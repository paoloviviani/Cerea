package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	backendacp "galopin/internal/backend/acp"
)

// TestACPEngineProbe drives the generic ACP adapter against an arbitrary real
// ACP agent (goose, pi-acp, ...) and logs what arrives: the permission asks
// (tool, title, kind, metadata, the class key NormalizeAsk derives), the tool
// parts, plan/todo events, usage, and whether a restart of the adapter can
// resume the session. It asserts only that the turns finish; the log is the
// evidence (run with -v). Gated behind GALOPIN_ACP_ENGINE_CMD, the agent's
// command line (e.g. "goose acp"); the agent inherits this process's
// environment, so point HOME and the provider variables at it from the shell.
// GALOPIN_ACP_ENGINE_WORKDIR is the workspace (default: a temp dir),
// GALOPIN_ACP_ENGINE_ASK is the decision for every ask: once (default) or
// reject.
func TestACPEngineProbe(t *testing.T) {
	cmdline := os.Getenv("GALOPIN_ACP_ENGINE_CMD")
	if cmdline == "" {
		t.Skip("set GALOPIN_ACP_ENGINE_CMD (e.g. \"goose acp\") to probe a real ACP agent")
	}
	argv := strings.Fields(cmdline)
	if _, err := exec.LookPath(argv[0]); err != nil {
		t.Skipf("%s not on PATH: %v", argv[0], err)
	}
	workDir := os.Getenv("GALOPIN_ACP_ENGINE_WORKDIR")
	if workDir == "" {
		workDir = t.TempDir()
	}
	decision := backend.DecisionOnce
	if os.Getenv("GALOPIN_ACP_ENGINE_ASK") == "reject" {
		decision = backend.DecisionReject
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	start := time.Now()
	b := backendacp.New(backendacp.Config{Command: argv, Tools: os.Getenv("GALOPIN_ACP_ENGINE_TOOLS") != "", StartupTimeout: 90 * time.Second, Logf: t.Logf})
	if err := b.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Logf("STARTUP %s id=%s version=%s caps=%+v", time.Since(start), b.ID(), b.Version(), b.Capabilities())
	defer b.Stop()

	events, err := b.Subscribe(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if modes, err := b.Modes(ctx, workDir); err == nil {
		j, _ := json.Marshal(modes)
		t.Logf("MODES %s", j)
	}
	if models, err := b.Models(ctx, workDir); err == nil {
		j, _ := json.Marshal(models)
		s := string(j)
		if len(s) > 600 {
			s = s[:600] + "..."
		}
		t.Logf("MODELS(%d) %s", len(models), s)
	}
	sess, err := b.CreateSession(ctx, workDir, backend.CreateSessionOptions{Title: "probe"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	t.Logf("SESSION %+v", sess)

	if modes, err := b.Modes(ctx, workDir); err == nil {
		j, _ := json.Marshal(modes)
		t.Logf("MODES after create %s", j)
	}
	if models, err := b.Models(ctx, workDir); err == nil {
		t.Logf("MODELS after create: %d", len(models))
	}
	if m := os.Getenv("GALOPIN_ACP_ENGINE_SETMODEL"); m != "" {
		s, err := b.SetModel(ctx, workDir, sess.ID, m)
		t.Logf("SETMODEL %s err=%v modelId=%s", m, err, s.ModelID)
	}
	if m := os.Getenv("GALOPIN_ACP_ENGINE_SETMODE"); m != "" {
		s, err := b.SetMode(ctx, workDir, sess.ID, m)
		t.Logf("SETMODE %s err=%v modeId=%s", m, err, s.ModeID)
	}

	turn := func(label, text string, cancelAfter time.Duration) {
		t.Logf("==== TURN %s: %q", label, text)
		if err := b.Prompt(ctx, workDir, sess.ID, backend.Prompt{Text: text}); err != nil {
			t.Fatalf("prompt: %v", err)
		}
		var cancelCh <-chan time.Time
		if cancelAfter > 0 {
			cancelCh = time.After(cancelAfter)
		}
		deadline := time.After(150 * time.Second)
		var text2 strings.Builder
		for {
			select {
			case ev := <-events:
				if ev.SessionID != sess.ID {
					continue
				}
				e := ev.Event
				switch e.Kind {
				case backend.EventPermissionAsked:
					key, pats := b.NormalizeAsk(*e.Request)
					j, _ := json.Marshal(e.Request)
					t.Logf("ASK class=%s patterns=%v req=%s", key, pats, j)
					if err := b.ReplyPermission(ctx, workDir, sess.ID, e.Request.ID, decision, ""); err != nil {
						t.Errorf("reply: %v", err)
					}
				case backend.EventPart:
					if e.Part != nil && e.Part.Type == backend.PartTool {
						j, _ := json.Marshal(e.Part)
						s := string(j)
						if len(s) > 700 {
							s = s[:700] + "..."
						}
						t.Logf("TOOLPART %s", s)
					} else if e.Part != nil && e.Part.Role == "assistant" {
						text2.Reset()
						text2.WriteString(e.Part.Text)
					}
				case backend.EventDelta:
					text2.WriteString(e.Delta)
				case backend.EventStatus:
					if e.Status == backend.StatusIdle {
						s := text2.String()
						if len(s) > 400 {
							s = s[:400] + "..."
						}
						t.Logf("IDLE text=%q", s)
						return
					}
				case backend.EventMessage:
				default:
					j, _ := json.Marshal(e)
					s := string(j)
					if len(s) > 500 {
						s = s[:500] + "..."
					}
					t.Logf("EVENT %s", s)
				}
			case <-cancelCh:
				cancelCh = nil
				t.Logf("CANCEL sent")
				if err := b.Cancel(ctx, workDir, sess.ID); err != nil {
					t.Errorf("cancel: %v", err)
				}
			case <-deadline:
				t.Fatalf("turn %s timed out", label)
			}
		}
	}

	for i, p := range splitPrompts(os.Getenv("GALOPIN_ACP_ENGINE_PROMPTS")) {
		turn(string(rune('A'+i)), p, 0)
	}

	if os.Getenv("GALOPIN_ACP_ENGINE_CANCEL") != "" {
		turn("cancel", os.Getenv("GALOPIN_ACP_ENGINE_CANCEL"), 4*time.Second)
	}

	list, err := b.ListSessions(ctx, workDir)
	j, _ := json.Marshal(list)
	t.Logf("LIST err=%v %s", err, j)
	tr, err := b.Transcript(ctx, workDir, sess.ID)
	t.Logf("TRANSCRIPT err=%v entries=%d", err, len(tr.Messages))

	// Resume: a second adapter process, same agent, same session id.
	b2 := backendacp.New(backendacp.Config{Command: argv, StartupTimeout: 90 * time.Second, Logf: t.Logf})
	if err := b2.Start(ctx); err != nil {
		t.Fatalf("start 2: %v", err)
	}
	defer b2.Stop()
	list2, err := b2.ListSessions(ctx, workDir)
	j, _ = json.Marshal(list2)
	t.Logf("LIST2 err=%v %s", err, j)
	tr2, err := b2.Transcript(ctx, workDir, sess.ID)
	t.Logf("RESUME transcript err=%v entries=%d", err, len(tr2.Messages))
	if err == nil {
		events2, _ := b2.Subscribe(ctx)
		_ = b2.Prompt(ctx, workDir, sess.ID, backend.Prompt{Text: "Without using tools: what was the first thing I asked you in this conversation? One sentence."})
		deadline := time.After(90 * time.Second)
		var last string
	loop:
		for {
			select {
			case ev := <-events2:
				if ev.Event.Kind == backend.EventPart && ev.Event.Part != nil && ev.Event.Part.Role == "assistant" && ev.Event.Part.Type == backend.PartText {
					last = ev.Event.Part.Text
				}
				if ev.Event.Kind == backend.EventDelta {
					last += ev.Event.Delta
				}
				if ev.Event.Kind == backend.EventStatus && ev.Event.Status == backend.StatusIdle {
					break loop
				}
			case <-deadline:
				t.Log("resume prompt timed out")
				break loop
			}
		}
		t.Logf("RESUME answer=%q", last)
	}
}

func splitPrompts(s string) []string {
	var out []string
	for _, p := range strings.Split(s, "||") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
