package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"galopin/internal/backend"
	backendopencode "galopin/internal/backend/opencode"
	"galopin/internal/permrules"
	"galopin/internal/policy"
	"galopin/internal/sessions"
	"galopin/internal/workspaces"
)

// The delegation evaluation (agent/eval/delegation/README.md): about ten
// prompts on a few real models, scoring whether the model chose the right
// tool and whether a handoff completed its round trip. Gated behind
// GALOPIN_DELEGATION_EVAL=1; it talks to a real gateway with a key taken from
// the environment and spends real model calls, so it is never part of a normal
// test run. It compiles against code with and without report-back (the hooks
// are looked up through interfaces), so the same file runs the baseline.

type evalPrompt struct {
	ID     string `json:"id"`
	Expect string `json:"expect"` // spawn | task | no_spawn
	Prompt string `json:"prompt"`
}

type evalResult struct {
	Model     string `json:"model"`
	Prompt    string `json:"prompt"`
	Expect    string `json:"expect"`
	Chose     string `json:"chose"` // spawn | task | none
	Right     bool   `json:"right"`
	RoundTrip *bool  `json:"roundTrip,omitempty"` // spawn runs only
	Calls     int    `json:"calls"`
	Note      string `json:"note,omitempty"`
}

type evalHub struct {
	mc  *machine
	mu  sync.Mutex
	log []sessions.Envelope
}

func (h *evalHub) run(mat *sessions.Materializer) {
	for env := range mat.Events() {
		h.mu.Lock()
		h.log = append(h.log, env)
		h.mu.Unlock()
		if o, ok := any(h.mc).(interface{ observeEvent(sessions.Envelope) }); ok {
			o.observeEvent(env)
		}
		if env.Event.Kind == backend.EventPermissionAsked && env.Event.Request != nil {
			req := env.Event.Request
			go func() { // the person's answer: once, to everything
				raw, _ := json.Marshal(map[string]any{"sessionId": req.SessionID, "requestId": req.ID, "decision": "once"})
				_, _ = h.mc.Handle(context.Background(), "permission.reply", raw)
			}()
		}
	}
}

func (h *evalHub) from(mark int) []sessions.Envelope {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]sessions.Envelope(nil), h.log[mark:]...)
}

func (h *evalHub) mark() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.log)
}

func TestDelegationEval(t *testing.T) {
	if os.Getenv("GALOPIN_DELEGATION_EVAL") != "1" {
		t.Skip("set GALOPIN_DELEGATION_EVAL=1 (and EVAL_GATEWAY_KEY, EVAL_GATEWAY_BASE_URL, EVAL_MODELS) to run; see eval/delegation/README.md")
	}
	key, base := os.Getenv("EVAL_GATEWAY_KEY"), os.Getenv("EVAL_GATEWAY_BASE_URL")
	models := strings.Fields(strings.ReplaceAll(os.Getenv("EVAL_MODELS"), ",", " "))
	if key == "" || base == "" || len(models) == 0 {
		t.Fatal("EVAL_GATEWAY_KEY, EVAL_GATEWAY_BASE_URL and EVAL_MODELS are required")
	}
	if _, err := exec.LookPath("opencode"); err != nil {
		t.Skipf("opencode not on PATH: %v", err)
	}
	maxCalls := 100
	fmt.Sscan(os.Getenv("EVAL_MAX_CALLS"), &maxCalls)
	perRun := 8
	fmt.Sscan(os.Getenv("EVAL_RUN_CALLS"), &perRun)
	raw, err := os.ReadFile(filepath.Join("eval", "delegation", "prompts.json"))
	if err != nil {
		t.Fatal(err)
	}
	var prompts []evalPrompt
	if err := json.Unmarshal(raw, &prompts); err != nil {
		t.Fatal(err)
	}
	if only := os.Getenv("EVAL_ONLY"); only != "" {
		var keep []evalPrompt
		for _, p := range prompts {
			if strings.Contains(","+only+",", ","+p.ID+",") {
				keep = append(keep, p)
			}
		}
		prompts = keep
	}

	var results []evalResult
	used := 0
	// The call budget is split evenly, so one model cannot starve the others.
	for _, model := range models {
		modelUsed := 0
		results = append(results, evalModel(t, model, key, base, prompts, perRun, maxCalls/len(models), &modelUsed)...)
		used += modelUsed
	}
	out, _ := json.MarshalIndent(map[string]any{"results": results, "calls": used}, "", "  ")
	if p := os.Getenv("EVAL_OUT"); p != "" {
		_ = os.WriteFile(p, out, 0o644)
	}
	t.Logf("%s", summarise(results, used))
}

func summarise(rs []evalResult, used int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "\nmodel | prompt | expect | chose | right | round trip | calls\n")
	type agg struct{ right, n, rt, rtn int }
	per := map[string]*agg{}
	for _, r := range rs {
		a := per[r.Model]
		if a == nil {
			a = &agg{}
			per[r.Model] = a
		}
		a.n++
		if r.Right {
			a.right++
		}
		rt := "-"
		if r.RoundTrip != nil {
			a.rtn++
			rt = "no"
			if *r.RoundTrip {
				a.rt++
				rt = "yes"
			}
		}
		fmt.Fprintf(&b, "%s | %s | %s | %s | %v | %s | %d %s\n", r.Model, r.Prompt, r.Expect, r.Chose, r.Right, rt, r.Calls, r.Note)
	}
	for m, a := range per {
		fmt.Fprintf(&b, "%s: %d/%d right choices, %d/%d round trips completed\n", m, a.right, a.n, a.rt, a.rtn)
	}
	fmt.Fprintf(&b, "model calls used: %d\n", used)
	return b.String()
}

func evalModel(t *testing.T, model, key, base string, prompts []evalPrompt, perRun, maxCalls int, used *int) []evalResult {
	root := t.TempDir()
	dirs := map[string]string{}
	for _, n := range []string{"home", "config", "data", "cache", "work", "state"} {
		dirs[n] = filepath.Join(root, n)
		if err := os.MkdirAll(dirs[n], 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeFixture(t, dirs["work"])
	cfg := map[string]any{
		"$schema": "https://opencode.ai/config.json",
		"provider": map[string]any{"pystino": map[string]any{
			"npm": "@ai-sdk/openai-compatible", "name": "Eval gateway",
			"options": map[string]any{"baseURL": base, "apiKey": key},
			"models":  map[string]any{model: map[string]any{"name": model, "limit": map[string]any{"context": 1048576, "output": 16384}}},
		}},
		"enabled_providers": []string{"pystino"},
		"model":             "pystino/" + model,
	}
	body, _ := json.MarshalIndent(cfg, "", "  ")
	configPath := filepath.Join(root, "opencode.json")
	if err := os.WriteFile(configPath, body, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(configPath) }) // the key lives only in this file
	env := []string{
		"HOME=" + dirs["home"], "XDG_CONFIG_HOME=" + dirs["config"], "XDG_DATA_HOME=" + dirs["data"],
		"XDG_CACHE_HOME=" + dirs["cache"], "TMPDIR=" + itTmpDir(t), "PATH=" + os.Getenv("PATH"),
	}
	oc := backendopencode.New(backendopencode.Config{
		ConfigPath: configPath, Env: env, StateDir: dirs["state"],
		OverlayPath:    filepath.Join(dirs["state"], "opencode-overlay.json"),
		ToolsDir:       filepath.Join(dirs["state"], "opencode-tools"),
		StartupTimeout: 90 * time.Second, Logf: func(string, ...any) {},
		Permissions: func() permrules.Layers { return permrules.Layers{} },
	})
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Minute)
	defer cancel()
	if err := oc.Start(ctx); err != nil {
		t.Fatalf("starting opencode: %v", err)
	}
	t.Cleanup(func() { _ = oc.Stop() })
	pol := policy.Default()
	pol.AllowFreeModels = true // the eval's models are not in galopin's gateway catalogue
	mat := sessions.New(oc, pol)
	if err := mat.Start(ctx); err != nil {
		t.Fatal(err)
	}
	reg, err := workspaces.Load(filepath.Join(dirs["state"], "workspaces.json"))
	if err != nil {
		t.Fatal(err)
	}
	ws, err := reg.Create("eval", dirs["work"], nil)
	if err != nil {
		t.Fatal(err)
	}
	mc := newMachine(reg, oc, mat, pol)
	audit, err := newAuditLogger(dirs["state"])
	if err != nil {
		t.Fatal(err)
	}
	mc.AttachAudit(audit)
	if a, ok := any(mc).(interface{ AttachReportState(string) }); ok {
		a.AttachReportState(dirs["state"])
	}
	hub := &evalHub{mc: mc}
	go hub.run(mat)

	var out []evalResult
	for _, p := range prompts {
		if *used >= maxCalls {
			out = append(out, evalResult{Model: model, Prompt: p.ID, Expect: p.Expect, Chose: "-", Note: "skipped: call budget spent"})
			continue
		}
		res := evalOne(t, ctx, oc, mc, mat, hub, ws, model, p, perRun)
		*used += res.Calls
		t.Logf("%s / %s: expect %s chose %s right=%v calls=%d %s", model, p.ID, p.Expect, res.Chose, res.Right, res.Calls, res.Note)
		out = append(out, res)
	}
	return out
}

func evalOne(t *testing.T, ctx context.Context, oc *backendopencode.Backend, mc *machine, mat *sessions.Materializer, hub *evalHub, ws workspaces.Workspace, model string, p evalPrompt, perRun int) evalResult {
	s, err := oc.CreateSession(ctx, ws.Path, backend.CreateSessionOptions{Title: "eval-" + p.ID})
	if err != nil {
		t.Fatal(err)
	}
	mc.trackSession(ws, s)
	mark := hub.mark()
	if err := oc.Prompt(ctx, ws.Path, s.ID, backend.Prompt{Text: p.Prompt}); err != nil {
		return evalResult{Model: model, Prompt: p.ID, Expect: p.Expect, Note: "prompt failed: " + err.Error()}
	}

	analyse := func() (chose string, calls int, reportBack bool, callerBusy int, callerIdleAfter bool) {
		seen := map[string]bool{}
		chose = "none"
		var reportAt = -1
		evs := hub.from(mark)
		for i, env := range evs {
			e := env.Event
			if e.Kind == backend.EventMessage && e.Message != nil && e.Message.Role == "assistant" && !seen[e.Message.ID] {
				seen[e.Message.ID] = true
				calls++
			}
			if e.Part != nil && e.Part.Type == backend.PartTool && env.SessionID == s.ID {
				switch e.Part.Tool {
				case "session_spawn":
					chose = "spawn"
				case "task":
					if chose != "spawn" {
						chose = "task"
					}
				}
			}
			if env.SessionID == s.ID && e.Kind == backend.EventMessage && e.Message != nil && e.Message.Role == "user" && e.Message.SentBy != nil && reportAt < 0 {
				reportAt = i
			}
		}
		if reportAt >= 0 {
			reportBack = true
			for _, env := range evs[reportAt:] {
				if env.SessionID == s.ID && env.Event.Kind == backend.EventStatus {
					if env.Event.Status == backend.StatusBusy {
						callerBusy++
					} else if callerBusy > 0 {
						callerIdleAfter = true
					}
				}
			}
		}
		return
	}

	deadline := time.Now().Add(6 * time.Minute)
	capped := false
	var note string
	var sawBusy bool
	var idleSince time.Time
	for time.Now().Before(deadline) {
		time.Sleep(500 * time.Millisecond)
		chose, calls, reportBack, _, idleAfter := analyse()
		if calls > perRun {
			capped, note = true, "capped at "+fmt.Sprint(perRun)+" calls"
			break
		}
		st, _ := mat.Status(s.ID)
		if st == backend.StatusBusy {
			sawBusy = true
		}
		if !sawBusy || st != backend.StatusIdle {
			continue
		}
		if chose != "spawn" {
			break
		}
		// Idle after its own turn: give the delegate and its report time.
		if idleAfter {
			break
		}
		if idleSince.IsZero() {
			idleSince = time.Now()
		}
		if !reportBack && time.Since(idleSince) > 3*time.Minute {
			note = "no report within 3 minutes"
			break
		}
	}
	chose, calls, reportBack, _, idleAfter := analyse()
	if capped || time.Now().After(deadline) {
		// Stop everything this run started.
		seen := map[string]bool{}
		for _, env := range hub.from(mark) {
			if !seen[env.SessionID] {
				seen[env.SessionID] = true
				if d, ok := mat.WorkspaceDir(env.SessionID); ok {
					_ = oc.Cancel(ctx, d, env.SessionID)
				}
			}
		}
	}
	res := evalResult{Model: model, Prompt: p.ID, Expect: p.Expect, Chose: chose, Calls: calls, Note: note}
	switch p.Expect {
	case "spawn":
		res.Right = chose == "spawn"
		rt := res.Right && reportBack && idleAfter
		res.RoundTrip = &rt
	case "task":
		res.Right = chose == "task"
	default:
		res.Right = chose != "spawn"
	}
	return res
}

func writeFixture(t *testing.T, dir string) {
	files := map[string]string{
		"README.md":      "# Acme Widgets\nA small library for weighing and sorting widgets.\n",
		"main.go":        "package main\n\nfunc Parse(s string) int { return len(s) }\n\nfunc main() {}\n",
		"DESIGN.md":      "# Design\nA: store widgets in a slice, simple and slow.\nB: store widgets in a tree, fast, more code.\n",
		"notes/a.go":     "package notes\n\nfunc Div(a, b int) int { return a / b }\n",
		"docs/intro.md":  "Widgets are weighed then sorted.\n",
		"docs/config.md": "Set WIDGET_HOME for the data dir and WIDGET_DEBUG to 1 for logs.\n",
		"data/data.csv":  "id,amount\n1,10\n2,32\n3,8\n",
		"alpha/a.txt":    "alpha holds the parsers.\n",
		"beta/b.txt":     "beta holds the sorters.\n",
		"gamma/c.txt":    "gamma holds the weighers.\n",
		"src/one.go":     "package src\n\nfunc One() int { return 1 }\n",
		"src/two.go":     "package src\n\nfunc Two() int { return 2 }\n\nfunc Three() int { return 3 }\n",
	}
	for name, body := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}
