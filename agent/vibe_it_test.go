package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/mockllm"
	"galopin/internal/policy"
)

// Real vibe-acp against galopin's Vibe engine, with a fake OpenAI-compatible model
// (internal/mockllm) behind a real galopin shim (the path a machine uses): no key, no
// network. Gated on GALOPIN_VIBE_IT=1 and a vibe-acp (GALOPIN_VIBE_BIN, or on PATH).

type vibeRig struct {
	t         *testing.T
	b         runningBackend
	events    <-chan backend.BackendEvent
	work      string
	home      string
	credsPath string
	stateDir  string
	mockURL   string
	requests  func() [][]string
	pol       policy.Policy
}

func vibeITBin(t *testing.T) string {
	t.Helper()
	if os.Getenv("GALOPIN_VIBE_IT") == "" {
		t.Skip("set GALOPIN_VIBE_IT=1 (and have vibe-acp on PATH or in GALOPIN_VIBE_BIN) to run the Vibe engine tests")
	}
	if b := os.Getenv(vibeEnvOverride); b != "" {
		return b
	}
	p, err := exec.LookPath("vibe-acp")
	if err != nil {
		t.Skip("no vibe-acp on PATH and no " + vibeEnvOverride)
	}
	t.Setenv(vibeEnvOverride, p)
	return p
}

func newVibeRig(t *testing.T) *vibeRig {
	t.Helper()
	return newVibeRigPolicy(t, policy.Default())
}

// newVibeRigPolicy is newVibeRig on a machine with this policy.
func newVibeRigPolicy(t *testing.T, pol policy.Policy) *vibeRig {
	t.Helper()
	vibeITBin(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("VIBE_HOME", "")
	t.Setenv("TMPDIR", t.TempDir())

	mock := httptest.NewServer(mockllm.New())
	t.Cleanup(mock.Close)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	shimPort := ln.Addr().(*net.TCPAddr).Port
	stateDir := t.TempDir()
	// Vibe leaves read-only files in its home (the plugin packages it unpacks).
	t.Cleanup(func() { _ = exec.Command("chmod", "-R", "u+rwX", stateDir).Run() })
	credsPath := filepath.Join(stateDir, "credentials.json")
	creds := &credentials{Gateway: mock.URL + "/v1", AccessToken: "tok", RefreshToken: "r", ExpiresIn: 3600,
		ObtainedAt: time.Now().Unix(), ShimPort: shimPort, ShimSecret: "it-secret"}
	if err := saveCredentials(credsPath, creds); err != nil {
		t.Fatal(err)
	}
	proxy := newShim(creds, credsPath, statusPathFor(credsPath), shimPort)
	srv := &httptest.Server{Listener: ln, Config: &http.Server{Handler: http.HandlerFunc(proxy.requireLocalAuth(proxy.handler))}}
	srv.Start()
	t.Cleanup(srv.Close)
	if err := writeVibeEngineConfig(vibeHomeFor(credsPath), creds, []gatewayModel{{ID: "mock-model", ContextWindow: 32000, SupportedFeatures: []string{"reasoning"}}}); err != nil {
		t.Fatal(err)
	}
	r := &vibeRig{t: t, pol: pol, work: t.TempDir(), home: vibeHomeFor(credsPath), credsPath: credsPath, stateDir: stateDir, mockURL: mock.URL}
	r.start()
	return r
}

// start (re)starts the backend over the same Vibe home.
func (r *vibeRig) start() {
	r.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	r.t.Cleanup(cancel)
	b, err := startVibeBackend(ctx, &runOptions{}, r.credsPath, r.stateDir, r.pol, nil, r.t.Logf)
	if err != nil {
		r.t.Fatal(err)
	}
	r.t.Cleanup(func() { _ = b.Stop() })
	events, err := b.Subscribe(ctx)
	if err != nil {
		r.t.Fatal(err)
	}
	r.b, r.events = b, events
}

func (r *vibeRig) scenario(sc mockllm.Scenario) {
	body, _ := json.Marshal(map[string]any{"scenario": sc})
	resp, err := http.Post(r.mockURL+"/__control/scenario", "application/json", strings.NewReader(string(body)))
	if err != nil {
		r.t.Fatal(err)
	}
	resp.Body.Close()
}

// turn sends a prompt and runs it to idle, answering every ask with decision.
func (r *vibeRig) turn(sessionID, text string, decision backend.Decision) (asks []backend.PermissionRequest, reply string) {
	r.t.Helper()
	return r.turnIn(r.work, sessionID, text, decision)
}

// turnIn is turn for a session of another workspace.
func (r *vibeRig) turnIn(work, sessionID, text string, decision backend.Decision) (asks []backend.PermissionRequest, reply string) {
	r.t.Helper()
	ctx := context.Background()
	if err := r.b.Prompt(ctx, work, sessionID, backend.Prompt{Text: text}); err != nil {
		r.t.Fatal(err)
	}
	deadline := time.After(2 * time.Minute)
	for {
		select {
		case ev := <-r.events:
			if ev.SessionID != sessionID {
				continue
			}
			if os.Getenv("GALOPIN_VIBE_IT_TRACE") != "" {
				e := ev.Event
				line := string(e.Kind) + " " + string(e.Status)
				if e.Part != nil {
					line += fmt.Sprintf(" part type=%s tool=%s status=%s text=%.80q err=%.120q out=%.80q", e.Part.Type, e.Part.Tool, e.Part.ToolStatus, e.Part.Text, e.Part.ToolError, e.Part.Output)
				}
				if e.Request != nil {
					line += fmt.Sprintf(" ask tool=%s title=%.80q", e.Request.Tool, e.Request.Title)
				}
				r.t.Logf("EVENT %s", line)
			}
			switch e := ev.Event; e.Kind {
			case backend.EventPermissionAsked:
				asks = append(asks, *e.Request)
				if err := r.b.ReplyPermission(ctx, work, sessionID, e.Request.ID, decision, ""); err != nil {
					r.t.Errorf("reply: %v", err)
				}
			case backend.EventPart:
				if e.Part != nil && e.Part.Role == "assistant" && e.Part.Type == backend.PartText {
					reply = e.Part.Text
				}
			case backend.EventDelta:
				reply += e.Delta
			case backend.EventStatus:
				if e.Status == backend.StatusIdle {
					return asks, reply
				}
			}
		case <-deadline:
			r.t.Fatal("turn timed out")
		}
	}
}

func (r *vibeRig) classify(ask backend.PermissionRequest) (string, []string) {
	return r.b.(interface {
		NormalizeAsk(backend.PermissionRequest) (string, []string)
	}).NormalizeAsk(ask)
}

func TestVibeEngineModesAreGalopins(t *testing.T) {
	r := newVibeRig(t)
	ctx := context.Background()
	sess, err := r.b.CreateSession(ctx, r.work, backend.CreateSessionOptions{Title: "it"})
	if err != nil {
		t.Fatal(err)
	}
	if sess.ModeID != vibeModeAsk {
		t.Errorf("a new session's mode = %q, want %q", sess.ModeID, vibeModeAsk)
	}
	modes, _ := r.b.Modes(ctx, r.work)
	var ids []string
	for _, m := range modes {
		ids = append(ids, m.ID)
	}
	for _, hidden := range vibeHiddenModes {
		for _, id := range ids {
			if id == hidden {
				t.Errorf("mode %q is offered: %v", hidden, ids)
			}
		}
	}
	if !strings.Contains(strings.Join(ids, ","), vibeModeAsk) {
		t.Errorf("modes = %v, want %q among them", ids, vibeModeAsk)
	}
	for _, hidden := range vibeHiddenModes {
		if _, err := r.b.SetMode(ctx, r.work, sess.ID, hidden); err == nil {
			t.Errorf("SetMode(%s) was accepted", hidden)
		}
	}
	models, _ := r.b.Models(ctx, r.work)
	for _, m := range models {
		if m.ID != "mock-model" {
			t.Errorf("model %q is offered: only the gateway's belong here (%v)", m.ID, models)
		}
	}
	if len(models) == 0 {
		t.Error("no model offered")
	}
}

// A shell command and a file read each ask, classify as bash and read (from the
// matching tool_call, since Vibe's ask carries neither a title nor a kind), and a
// rejected ask does not run the tool.
func TestVibeEngineAsksAndClassifies(t *testing.T) {
	r := newVibeRig(t)
	sess, err := r.b.CreateSession(context.Background(), r.work, backend.CreateSessionOptions{Title: "asks"})
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(r.work, "marker.txt")
	r.scenario(mockllm.Scenario{
		ToolCalls:    []mockllm.ToolCall{{ID: "call_1", Name: "bash", Arguments: `{"command":"echo galopin-sum-result > marker.txt && echo galopin-sum-result"}`}},
		FinishReason: "tool_calls",
		Routes:       []mockllm.Route{{Contains: "galopin-sum-result", Scenario: mockllm.Scenario{Content: []string{"the answer is galopin-sum-result"}, FinishReason: "stop"}}},
	})
	asks, reply := r.turn(sess.ID, "run the sum", backend.DecisionReject)
	if len(asks) == 0 {
		t.Fatalf("Vibe ran a tool without asking (reply %q): the ask floor is not holding", reply)
	}
	key, patterns := r.classify(asks[0])
	t.Logf("ask: tool=%q title=%q class=%q patterns=%v meta=%v", asks[0].Tool, asks[0].Title, key, patterns, asks[0].Metadata)
	if key != "bash" {
		t.Errorf("shell ask class = %q, want bash", key)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Error("a rejected command ran")
	}

	// allowed once: the tool runs
	r.scenario(mockllm.Scenario{
		ToolCalls:    []mockllm.ToolCall{{ID: "call_2", Name: "bash", Arguments: `{"command":"echo galopin-second > marker.txt && echo galopin-second"}`}},
		FinishReason: "tool_calls",
		Routes:       []mockllm.Route{{Contains: "galopin-second", Scenario: mockllm.Scenario{Content: []string{"done galopin-second"}, FinishReason: "stop"}}},
	})
	asks, reply = r.turn(sess.ID, "run it again", backend.DecisionOnce)
	if len(asks) == 0 || !strings.Contains(reply, "galopin-second") {
		t.Fatalf("allowed turn: asks=%d reply=%q", len(asks), reply)
	}
	if b, err := os.ReadFile(marker); err != nil || !strings.Contains(string(b), "galopin-second") {
		t.Errorf("the allowed command did not run: %v %q", err, b)
	}

	// a read inside the workspace asks too (Vibe's own default would run it unasked)
	readme := filepath.Join(r.work, "notes.txt")
	if err := os.WriteFile(readme, []byte("read-file-unique-777\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r.scenario(mockllm.Scenario{
		ToolCalls:    []mockllm.ToolCall{{ID: "call_3", Name: "read_file", Arguments: `{"path":"` + readme + `"}`}},
		FinishReason: "tool_calls",
		Routes:       []mockllm.Route{{Contains: "read-file-unique-777", Scenario: mockllm.Scenario{Content: []string{"read it"}, FinishReason: "stop"}}},
	})
	// (a new session: the mock answers in text once any tool result is in the history)
	sess, err = r.b.CreateSession(context.Background(), r.work, backend.CreateSessionOptions{Title: "reads"})
	if err != nil {
		t.Fatal(err)
	}
	asks, _ = r.turn(sess.ID, "read the notes", backend.DecisionOnce)
	if len(asks) == 0 {
		t.Fatal("read_file ran without asking: its default 'always' is not overridden")
	}
	key, patterns = r.classify(asks[0])
	t.Logf("read ask: class=%q patterns=%v", key, patterns)
	if key != "read" || len(patterns) == 0 {
		t.Errorf("read ask class = %q patterns %v, want read with the path", key, patterns)
	}
}

// Vibe runs a short list of read-only commands (cat, ls, head, ...) without asking; the
// floor empties that list, so galopin sees them (its protected paths and secrets rules
// need to).
func TestVibeEngineReadOnlyShellCommandsAsk(t *testing.T) {
	r := newVibeRig(t)
	sess, err := r.b.CreateSession(context.Background(), r.work, backend.CreateSessionOptions{Title: "cat"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r.work, "n.txt"), []byte("cat-file-contents-4242\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r.scenario(mockllm.Scenario{
		ToolCalls:    []mockllm.ToolCall{{ID: "call_c", Name: "bash", Arguments: `{"command":"cat n.txt"}`}},
		FinishReason: "tool_calls",
		Routes:       []mockllm.Route{{Contains: "cat-file-contents-4242", Scenario: mockllm.Scenario{Content: []string{"saw it"}, FinishReason: "stop"}}},
	})
	asks, reply := r.turn(sess.ID, "cat it", backend.DecisionReject)
	if len(asks) == 0 {
		t.Fatalf("cat ran without asking (reply %q): the shell allowlist is not empty", reply)
	}
	if key, _ := r.classify(asks[0]); key != "bash" {
		t.Errorf("class = %q, want bash", key)
	}
}

// A repository's own .vibe/ config is never loaded: it cannot loosen the floor.
func TestVibeEngineIgnoresProjectConfig(t *testing.T) {
	r := newVibeRig(t)
	if err := os.MkdirAll(filepath.Join(r.work, ".vibe"), 0o755); err != nil {
		t.Fatal(err)
	}
	loose := "bypass_tool_permissions = true\nenable_auto_approve = true\n[tools.bash]\npermission = \"always\"\nallowlist = [\"echo\"]\n"
	if err := os.WriteFile(filepath.Join(r.work, ".vibe", "config.toml"), []byte(loose), 0o644); err != nil {
		t.Fatal(err)
	}
	sess, err := r.b.CreateSession(context.Background(), r.work, backend.CreateSessionOptions{Title: "proj"})
	if err != nil {
		t.Fatal(err)
	}
	r.scenario(mockllm.Scenario{
		ToolCalls:    []mockllm.ToolCall{{ID: "call_p", Name: "bash", Arguments: `{"command":"echo project-config"}`}},
		FinishReason: "tool_calls",
		Routes:       []mockllm.Route{{Contains: "project-config", Scenario: mockllm.Scenario{Content: []string{"ok"}, FinishReason: "stop"}}},
	})
	asks, _ := r.turn(sess.ID, "echo", backend.DecisionOnce)
	if len(asks) == 0 {
		t.Fatal("the repository's .vibe/config.toml made a shell command run without an ask")
	}
}

// List, and reopen after the agent restarts (the lease Vibe keeps on an open session
// must be gone with the old process, and a load must replay the history).
func TestVibeEngineListAndReopenAfterRestart(t *testing.T) {
	r := newVibeRig(t)
	ctx := context.Background()
	sess, err := r.b.CreateSession(ctx, r.work, backend.CreateSessionOptions{Title: "persist"})
	if err != nil {
		t.Fatal(err)
	}
	if _, reply := r.turn(sess.ID, "say hello", backend.DecisionOnce); !strings.Contains(reply, "mock") {
		t.Fatalf("plain turn: reply %q", reply)
	}
	list, err := r.b.ListSessions(ctx, r.work)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, s := range list {
		found = found || s.ID == sess.ID
	}
	if !found {
		t.Fatalf("session %s not listed: %+v", sess.ID, list)
	}

	if err := r.b.Stop(); err != nil {
		t.Fatal(err)
	}
	r.start()
	list, err = r.b.ListSessions(ctx, r.work)
	if err != nil {
		t.Fatal(err)
	}
	found = false
	for _, s := range list {
		found = found || s.ID == sess.ID
	}
	if !found {
		t.Fatalf("after the restart session %s is not listed: %+v", sess.ID, list)
	}
	tr, err := r.b.Transcript(ctx, r.work, sess.ID)
	if err != nil {
		t.Fatalf("reopening after a restart: %v", err)
	}
	var text string
	for _, m := range tr.Messages {
		for _, p := range m.Parts {
			text += p.Text + "\n"
		}
	}
	if !strings.Contains(text, "say hello") || !strings.Contains(text, "mock") {
		t.Errorf("the reopened transcript lacks the history: %q", text)
	}
	if _, reply := r.turn(sess.ID, "and again", backend.DecisionOnce); !strings.Contains(reply, "mock") {
		t.Errorf("a turn after the reopen: reply %q", reply)
	}
}

// The agent process dying under galopin (the supervisor restarts it) must not leave a
// session unopenable: the old process held the session's lease until it was gone.
func TestVibeEngineReopenAfterAgentKilled(t *testing.T) {
	r := newVibeRig(t)
	ctx := context.Background()
	sess, err := r.b.CreateSession(ctx, r.work, backend.CreateSessionOptions{Title: "killed"})
	if err != nil {
		t.Fatal(err)
	}
	r.turn(sess.ID, "say hello", backend.DecisionOnce)
	if n := killVibeAgents(t, r.home); n == 0 {
		t.Skip("could not find the agent process (needs /proc)")
	}
	// the supervisor restarts the agent; the session is opened again by the next prompt
	// (a session/load on the new process, which must not find the old one's lock)
	deadline := time.Now().Add(90 * time.Second)
	var lastErr error
	for {
		if lastErr = r.b.Prompt(ctx, r.work, sess.ID, backend.Prompt{Text: "and again"}); lastErr == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no prompt got through after the agent was killed: %v", lastErr)
		}
		time.Sleep(time.Second)
	}
	for end := time.After(time.Minute); ; {
		select {
		case ev := <-r.events:
			if ev.SessionID == sess.ID && ev.Event.Kind == backend.EventStatus && ev.Event.Status == backend.StatusIdle {
				tr, err := r.b.Transcript(ctx, r.work, sess.ID)
				if err != nil {
					t.Fatal(err)
				}
				if len(tr.Messages) < 2 {
					t.Errorf("the transcript after the reopen has %d messages", len(tr.Messages))
				}
				return
			}
		case <-end:
			t.Fatal("the turn after the reopen did not finish")
		}
	}
}

// killVibeAgents SIGKILLs every process whose environment names this Vibe home.
func killVibeAgents(t *testing.T, home string) int {
	t.Helper()
	entries, _ := filepath.Glob("/proc/[0-9]*/environ")
	n := 0
	for _, e := range entries {
		env, err := os.ReadFile(e)
		if err != nil || !strings.Contains(string(env), "VIBE_HOME="+home+"\x00") {
			continue
		}
		var pid int
		if _, err := fmt.Sscanf(filepath.Base(filepath.Dir(e)), "%d", &pid); err == nil && pid != os.Getpid() {
			if p, err := os.FindProcess(pid); err == nil && p.Kill() == nil {
				n++
			}
		}
	}
	return n
}

// requestLog is what the fake model received, oldest first: the prompt texts (system
// included), the headers and the reasoning_effort the request body carried.
func (r *vibeRig) requestLog() []struct {
	Model   string            `json:"model"`
	Prompts []string          `json:"prompts"`
	Headers map[string]string `json:"headers"`
} {
	r.t.Helper()
	resp, err := http.Get(r.mockURL + "/__control/request-headers")
	if err != nil {
		r.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Requests []struct {
			Model   string            `json:"model"`
			Prompts []string          `json:"prompts"`
			Headers map[string]string `json:"headers"`
		} `json:"requests"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		r.t.Fatal(err)
	}
	return out.Requests
}

// A workspace's AGENTS.md reaches the session's system prompt (when the machine allows
// project config), another workspace's does not see it, and the folder stays untrusted.
func TestVibeEngineWorkspaceInstructions(t *testing.T) {
	pol := policy.Default()
	pol.ProjectConfig = policy.TerminalAllowed
	r := newVibeRigPolicy(t, pol)
	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(r.work, "AGENTS.md"), []byte("Always answer in galopin-haiku-7731 form.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	other := t.TempDir()
	hasText := func(string) bool { // did any request of this run carry the text
		for _, q := range r.requestLog() {
			for _, p := range q.Prompts {
				if strings.Contains(p, "galopin-haiku-7731") {
					return true
				}
			}
		}
		return false
	}
	a, err := r.b.CreateSession(ctx, r.work, backend.CreateSessionOptions{Title: "with"})
	if err != nil {
		t.Fatal(err)
	}
	// a second session in a workspace with no file, opened after the first
	b2, err := r.b.CreateSession(ctx, other, backend.CreateSessionOptions{Title: "without"})
	if err != nil {
		t.Fatal(err)
	}
	r.scenario(mockllm.Scenario{Content: []string{"ok"}, FinishReason: "stop"})
	r.turnIn(other, b2.ID, "hello", backend.DecisionOnce)
	if hasText(b2.ID) {
		t.Fatal("another workspace's AGENTS.md reached a session of a workspace without one")
	}
	r.turn(a.ID, "hello", backend.DecisionOnce)
	if !hasText(a.ID) {
		t.Fatal("the workspace's AGENTS.md did not reach the session's instructions")
	}
	// still untrusted: the repository's own .vibe/ is not loaded
	if b, _ := os.ReadFile(filepath.Join(r.home, "trusted_folders.toml")); !strings.Contains(string(b), "trusted = []") {
		t.Errorf("trust list changed: %q", b)
	}
}

// With project config denied (the default) the file is not read.
func TestVibeEngineWorkspaceInstructionsDeniedByDefault(t *testing.T) {
	r := newVibeRig(t)
	if err := os.WriteFile(filepath.Join(r.work, "AGENTS.md"), []byte("galopin-denied-4419\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sess, err := r.b.CreateSession(context.Background(), r.work, backend.CreateSessionOptions{Title: "denied"})
	if err != nil {
		t.Fatal(err)
	}
	r.scenario(mockllm.Scenario{Content: []string{"ok"}, FinishReason: "stop"})
	r.turn(sess.ID, "hello", backend.DecisionOnce)
	for _, q := range r.requestLog() {
		for _, p := range q.Prompts {
			if strings.Contains(p, "galopin-denied-4419") {
				t.Fatal("AGENTS.md was read although project config is denied")
			}
		}
	}
}

// Vibe's own /compact runs as a turn: the Compact capability is on, the compaction reaches
// the model (a summarising request), and the session still answers afterwards.
func TestVibeEngineCompact(t *testing.T) {
	r := newVibeRig(t)
	if !r.b.Capabilities().Compact {
		t.Fatal("the compact capability is off for Vibe")
	}
	ctx := context.Background()
	sess, err := r.b.CreateSession(ctx, r.work, backend.CreateSessionOptions{Title: "compact"})
	if err != nil {
		t.Fatal(err)
	}
	r.scenario(mockllm.Scenario{Content: []string{"first answer galopin-pre-compact"}, FinishReason: "stop"})
	r.turn(sess.ID, "remember the number 41", backend.DecisionOnce)
	before := len(r.requestLog())
	r.scenario(mockllm.Scenario{Content: []string{"SUMMARY galopin-compact-summary"}, FinishReason: "stop"})
	compactor, ok := r.b.(backend.Compactor)
	if !ok {
		t.Fatal("the backend is no Compactor")
	}
	if err := compactor.Compact(ctx, r.work, sess.ID); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, r, sess.ID)
	if after := len(r.requestLog()); after <= before {
		t.Fatalf("compaction made no model request (%d before, %d after)", before, after)
	}
	r.scenario(mockllm.Scenario{Content: []string{"still here"}, FinishReason: "stop"})
	if _, reply := r.turn(sess.ID, "are you there", backend.DecisionOnce); !strings.Contains(reply, "still here") {
		t.Fatalf("the session did not answer after compaction: %q", reply)
	}
}

// waitIdle waits for the session's turn (started by something other than r.turn) to end.
func waitIdle(t *testing.T, r *vibeRig, sessionID string) {
	t.Helper()
	deadline := time.After(2 * time.Minute)
	for {
		select {
		case ev := <-r.events:
			if ev.SessionID == sessionID && ev.Event.Kind == backend.EventStatus && ev.Event.Status == backend.StatusIdle {
				return
			}
		case <-deadline:
			t.Fatal("the turn did not end")
		}
	}
}

// Cerea's effort selector reaches the model: Vibe's thinking level goes out as the
// request's reasoning_effort, the default sends none, and a new session (and a restarted
// agent) starts on the default although Vibe keeps the last level set per model.
func TestVibeEngineEfforts(t *testing.T) {
	r := newVibeRig(t)
	ctx := context.Background()
	if !r.b.Capabilities().Efforts {
		t.Fatal("the efforts capability is off for Vibe")
	}
	setter := r.b.(backend.EffortSetter)
	effortOfLast := func() string {
		log := r.requestLog()
		for i := len(log) - 1; i >= 0; i-- {
			if len(log[i].Prompts) > 0 && strings.Contains(strings.Join(log[i].Prompts, " "), "effort-probe") {
				return log[i].Headers["x-body-reasoning-effort"]
			}
		}
		t.Fatal("no request of the probe turn")
		return ""
	}
	r.scenario(mockllm.Scenario{Content: []string{"ok"}, FinishReason: "stop"})
	sess, err := r.b.CreateSession(ctx, r.work, backend.CreateSessionOptions{Title: "effort"})
	if err != nil {
		t.Fatal(err)
	}
	models, err := r.b.Models(ctx, r.work)
	if err != nil {
		t.Fatal(err)
	}
	var offered []string
	for _, m := range models {
		if m.ID == "mock-model" {
			offered = m.Efforts
		}
	}
	if strings.Join(offered, ",") != "low,medium,high" {
		t.Fatalf("Cerea is offered %v", offered)
	}
	r.turn(sess.ID, "effort-probe default", backend.DecisionOnce)
	if got := effortOfLast(); got != "" {
		t.Fatalf("the default sent reasoning_effort %q", got)
	}
	got, err := setter.SetEffort(ctx, r.work, sess.ID, "high")
	if err != nil || got.Effort != "high" {
		t.Fatalf("SetEffort: %v %+v", err, got)
	}
	r.turn(sess.ID, "effort-probe high", backend.DecisionOnce)
	if got := effortOfLast(); got != "high" {
		t.Fatalf("reasoning_effort = %q, want high", got)
	}
	// Vibe keeps "high" for this model now: a new session still starts on the default
	other, err := r.b.CreateSession(ctx, r.work, backend.CreateSessionOptions{Title: "effort2"})
	if err != nil {
		t.Fatal(err)
	}
	r.turn(other.ID, "effort-probe fresh", backend.DecisionOnce)
	if got := effortOfLast(); got != "" {
		t.Fatalf("a new session inherited reasoning_effort %q from another", got)
	}
	// back to the model's default on the first session
	if _, err := setter.SetEffort(ctx, r.work, sess.ID, ""); err != nil {
		t.Fatal(err)
	}
	r.turn(sess.ID, "effort-probe cleared", backend.DecisionOnce)
	if got := effortOfLast(); got != "" {
		t.Fatalf("cleared effort sent %q", got)
	}
	if _, err := setter.SetEffort(ctx, r.work, sess.ID, "extreme"); err == nil {
		t.Fatal("an unoffered level was accepted")
	}
}
