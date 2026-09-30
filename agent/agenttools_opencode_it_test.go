package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"galopin/internal/backend"
	backendopencode "galopin/internal/backend/opencode"
	"galopin/internal/policy"
	"galopin/internal/sessions"
	"galopin/internal/workspaces"
)

// The agent-coordination tools against a real, pinned opencode (the M-round
// bar: every gate proven live). One opencode + one mock LLM serve every
// subtest; each drives a real tool call through opencode's custom-tool path,
// galopin's loopback relay and galopin's own approval. Gated behind
// GALOPIN_OPENCODE_IT=1.

// itHub is the one reader of the materializer's event stream: it logs every
// envelope for polling and answers galopin's own approvals through the real
// permission.reply op, per the current policy.
type itHub struct {
	t  *testing.T
	mc *machine

	mu      sync.Mutex
	log     []sessions.Envelope
	approve func(req *backend.PermissionRequest) string // "once" | "reject" | "" (leave pending)
}

func (h *itHub) run(mat *sessions.Materializer) {
	for env := range mat.Events() {
		h.mu.Lock()
		h.log = append(h.log, env)
		approve := h.approve
		h.mu.Unlock()
		if env.Event.Kind == backend.EventPermissionAsked && env.Event.Request != nil && approve != nil {
			if d := approve(env.Event.Request); d != "" {
				req := env.Event.Request
				go func() {
					raw, _ := json.Marshal(map[string]any{"sessionId": req.SessionID, "requestId": req.ID, "decision": d})
					if _, operr := h.mc.Handle(context.Background(), "permission.reply", raw); operr != nil {
						h.t.Errorf("permission.reply: %+v", operr)
					}
				}()
			}
		}
	}
}

func (h *itHub) setApprove(f func(req *backend.PermissionRequest) string) {
	h.mu.Lock()
	h.approve = f
	h.mu.Unlock()
}

func (h *itHub) mark() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.log)
}

func (h *itHub) since(mark int) []sessions.Envelope {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]sessions.Envelope(nil), h.log[mark:]...)
}

// wait polls the log after mark for an envelope satisfying pred.
func (h *itHub) wait(t *testing.T, mark int, timeout time.Duration, what string, pred func(sessions.Envelope) bool) sessions.Envelope {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		for _, env := range h.since(mark) {
			if pred(env) {
				return env
			}
		}
		if time.Now().After(deadline) {
			for _, env := range h.since(mark) {
				ev := env.Event
				switch {
				case ev.Part != nil && ev.Part.Type == backend.PartTool:
					t.Logf("  seen: %s part tool=%s status=%s err=%q out=%q", env.SessionID, ev.Part.Tool, ev.Part.ToolStatus, ev.Part.ToolError, truncate(ev.Part.Output, 80))
				default:
					t.Logf("  seen: %s %s %s part=%+v msg=%+v", env.SessionID, ev.Kind, ev.Status, ev.Part, ev.Message)
				}
			}
			t.Fatalf("timed out after %s waiting for %s", timeout, what)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// toolDone waits for the named tool's part in sessionID to finish and returns it.
func (h *itHub) toolDone(t *testing.T, mark int, sessionID, tool string) backend.Part {
	t.Helper()
	env := h.wait(t, mark, 90*time.Second, tool+" to finish in "+sessionID, func(e sessions.Envelope) bool {
		p := e.Event.Part
		return e.SessionID == sessionID && e.Event.Kind == backend.EventPart && p != nil && p.Tool == tool &&
			(p.ToolStatus == backend.ToolCompleted || p.ToolStatus == backend.ToolFailed)
	})
	return *env.Event.Part
}

func (h *itHub) asks(mark int, sessionID string) []backend.PermissionRequest {
	var out []backend.PermissionRequest
	for _, env := range h.since(mark) {
		if env.SessionID == sessionID && env.Event.Kind == backend.EventPermissionAsked && env.Event.Request != nil {
			out = append(out, *env.Event.Request)
		}
	}
	return out
}

func (h *itHub) waitIdle(t *testing.T, mark int, sessionID string) {
	t.Helper()
	h.wait(t, mark, 90*time.Second, sessionID+" to go idle", func(e sessions.Envelope) bool {
		return e.SessionID == sessionID && e.Event.Kind == backend.EventStatus && e.Event.Status == backend.StatusIdle
	})
}

// itClock is the machine's injectable clock: real time plus an offset the
// test advances, so windows and grace periods can be crossed without waiting.
type itClock struct{ offset atomic.Int64 }

func (c *itClock) now() time.Time          { return time.Now().Add(time.Duration(c.offset.Load())) }
func (c *itClock) advance(d time.Duration) { c.offset.Add(int64(d)) }

func TestAgentToolsIntegration(t *testing.T) {
	if !itEnabled("GALOPIN_OPENCODE_IT", "PYSTINO_AGENT_OPENCODE_IT") {
		t.Skip("set GALOPIN_OPENCODE_IT=1 to run (spawns real opencode + a mock LLM)")
	}
	if _, err := exec.LookPath("opencode"); err != nil {
		t.Skipf("opencode not on PATH: %v", err)
	}
	if out, err := exec.Command("opencode", "--version").CombinedOutput(); err == nil {
		t.Logf("installed opencode: %s", strings.TrimSpace(string(out)))
	}

	mockOrigin := startMockLLM(t, itFreePort(t))
	root := t.TempDir()
	dirs := map[string]string{}
	for _, n := range []string{"home", "config", "data", "cache", "work1", "work2", "state"} {
		dirs[n] = filepath.Join(root, n)
		if err := os.MkdirAll(dirs[n], 0o755); err != nil {
			t.Fatal(err)
		}
	}
	cfg := map[string]any{
		"$schema": "https://opencode.ai/config.json",
		"provider": map[string]any{"pystino": map[string]any{
			"npm": "@ai-sdk/openai-compatible", "name": "Pystino Mock",
			"options": map[string]any{"baseURL": mockOrigin + "/v1", "apiKey": "test-secret"},
			"models":  map[string]any{"mock-model": map[string]any{"name": "Mock Model", "limit": map[string]any{"context": 100000, "output": 8000}}},
		}},
		"enabled_providers": []string{"pystino"},
	}
	body, _ := json.MarshalIndent(cfg, "", "  ")
	configPath := filepath.Join(root, "opencode.json")
	if err := os.WriteFile(configPath, body, 0o644); err != nil {
		t.Fatal(err)
	}
	env := []string{
		"HOME=" + dirs["home"], "XDG_CONFIG_HOME=" + dirs["config"], "XDG_DATA_HOME=" + dirs["data"],
		"XDG_CACHE_HOME=" + dirs["cache"], "TMPDIR=" + itTmpDir(t), "PATH=" + os.Getenv("PATH"),
	}
	oc := backendopencode.New(backendopencode.Config{
		ConfigPath: configPath, Env: env, StateDir: dirs["state"],
		OverlayPath:    filepath.Join(dirs["state"], "opencode-overlay.json"),
		ToolsDir:       filepath.Join(dirs["state"], "opencode-tools"),
		StartupTimeout: 90 * time.Second, Logf: t.Logf,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	if err := oc.Start(ctx); err != nil {
		t.Fatalf("starting opencode: %v", err)
	}
	t.Cleanup(func() { _ = oc.Stop() })

	pol := policy.Default()
	pol.AutoAccept = policy.AutoAcceptAllowed
	mat := sessions.New(oc, pol)
	if err := mat.Start(ctx); err != nil {
		t.Fatal(err)
	}
	reg, err := workspaces.Load(filepath.Join(dirs["state"], "workspaces.json"))
	if err != nil {
		t.Fatal(err)
	}
	ws1, err := reg.Create("ws-one", dirs["work1"], nil)
	if err != nil {
		t.Fatal(err)
	}
	ws2, err := reg.Create("ws-two", dirs["work2"], nil)
	if err != nil {
		t.Fatal(err)
	}
	mc := newMachine(reg, oc, mat, pol)
	audit, err := newAuditLogger(dirs["state"])
	if err != nil {
		t.Fatal(err)
	}
	mc.AttachAudit(audit)
	if mc.agentTools == nil {
		t.Fatal("the agent tools were not installed on an opencode backend with a ToolsDir")
	}
	clock := &itClock{}
	mc.agentTools.now = clock.now
	hub := &itHub{t: t, mc: mc}
	go hub.run(mat)

	// Scenario routes accumulate: one per trigger token, matched against a
	// request's whole message JSON (the prompt, and a tool call's arguments).
	// The mock takes the FIRST route matching anywhere in a request's history,
	// so a session that is prompted repeatedly must see its newest trigger
	// first: trigger routes are prepended (register them in the order a
	// session uses them), slow routes sit at the tail.
	var routes, tail []map[string]any
	var callSeq int
	route := func(contains, tool, args string) {
		callSeq++
		r := map[string]any{"contains": contains, "scenario": map[string]any{
			"toolCalls":    []map[string]any{{"id": fmt.Sprintf("call_it_%d", callSeq), "name": tool, "arguments": args}},
			"content":      []string{"done"},
			"chunkDelayMs": 5, "finishReason": "stop",
		}}
		routes = append([]map[string]any{r}, routes...)
	}
	slowRoute := func(contains string) {
		tail = append(tail, map[string]any{"contains": contains, "scenario": map[string]any{
			"content": []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j"}, "chunkDelayMs": 400, "finishReason": "stop",
		}})
	}
	publish := func() {
		all := append(append([]map[string]any{}, routes...), tail...)
		setMockScenario(t, mockOrigin, map[string]any{"content": []string{"ok"}, "chunkDelayMs": 5, "finishReason": "stop", "routes": all})
	}
	// settle waits for a session that has started a turn to finish it.
	settle := func(sessionID string) {
		t.Helper()
		hub.wait(t, 0, 60*time.Second, sessionID+" to have run", func(e sessions.Envelope) bool {
			return e.SessionID == sessionID && e.Event.Kind == backend.EventStatus && e.Event.Status == backend.StatusBusy
		})
		deadline := time.Now().Add(90 * time.Second)
		for {
			if st, _ := mat.Status(sessionID); st == backend.StatusIdle {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s never finished its turn", sessionID)
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	spawnArgs := func(title, prompt, mode string) string {
		return mustJSON2(map[string]any{"title": title, "prompt": prompt, "mode": mode})
	}
	newSession := func(ws workspaces.Workspace, title, mode string) backend.Session {
		t.Helper()
		s, err := oc.CreateSession(ctx, ws.Path, backend.CreateSessionOptions{Title: title, ModeID: mode})
		if err != nil {
			t.Fatal(err)
		}
		mc.trackSession(ws, s)
		return s
	}
	prompt := func(s backend.Session, ws workspaces.Workspace, text string) {
		t.Helper()
		if err := oc.Prompt(ctx, ws.Path, s.ID, backend.Prompt{Text: text}); err != nil {
			t.Fatal(err)
		}
	}
	getSession := func(id string) backend.Session {
		t.Helper()
		res, operr := mc.Handle(ctx, "session.get", mustJSONArgs(t, map[string]any{"sessionId": id}))
		if operr != nil {
			t.Fatalf("session.get %s: %+v", id, operr)
		}
		return res.(map[string]any)["session"].(backend.Session)
	}
	allTitled := func(title string) []backend.Session {
		var out []backend.Session
		for _, w := range reg.List(false) {
			list, err := oc.ListSessions(ctx, w.Path)
			if err != nil {
				t.Fatal(err)
			}
			for _, s := range list {
				if s.Title == title {
					out = append(out, s)
				}
			}
		}
		return out
	}
	approveAll := func(req *backend.PermissionRequest) string { return "once" }
	rejectAll := func(req *backend.PermissionRequest) string { return "reject" }
	mockPrompts := func() string {
		resp, err := http.Get(mockOrigin + "/__control/requests")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		var parsed struct {
			Requests [][]string `json:"requests"`
		}
		_ = json.Unmarshal(raw, &parsed)
		return strings.Join(flatten(parsed.Requests), "\n")
	}
	auditRows := func() []map[string]any {
		raw, _ := os.ReadFile(filepath.Join(dirs["state"], "audit.log"))
		var rows []map[string]any
		for _, l := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
			var m map[string]any
			if json.Unmarshal([]byte(l), &m) == nil && m["action"] == "agent_tool" {
				rows = append(rows, m)
			}
		}
		return rows
	}

	t.Run("capabilities and installed tool files", func(t *testing.T) {
		caps := oc.Capabilities()
		if !caps.AgentTools || !caps.Steer {
			t.Fatalf("capabilities = %+v, want agentTools and steer", caps)
		}
		for _, name := range []string{"session_list", "session_spawn", "session_send"} {
			if _, err := os.Stat(filepath.Join(dirs["state"], "opencode-tools", "tools", name+".js")); err != nil {
				t.Errorf("tool file %s: %v", name, err)
			}
		}
		if _, err := os.Stat(filepath.Join(dirs["state"], "opencode-tools", "skills", "delegation", "SKILL.md")); err != nil {
			t.Errorf("delegation skill: %v", err)
		}
	})

	t.Run("spawn: approved by a card, marked, unprivileged", func(t *testing.T) {
		hub.setApprove(approveAll)
		caller := newSession(ws1, "it-caller-a", "")
		route("trigger-spawn-a", "session_spawn", spawnArgs("it-child-a", "child-a first prompt", "inherit"))
		publish()
		mark := hub.mark()
		prompt(caller, ws1, "trigger-spawn-a")
		part := hub.toolDone(t, mark, caller.ID, "session_spawn")
		if part.ToolStatus != backend.ToolCompleted {
			t.Fatalf("session_spawn = %s / %q / %q", part.ToolStatus, part.Output, part.ToolError)
		}
		asks := hub.asks(mark, caller.ID)
		if len(asks) != 1 {
			t.Fatalf("asks = %d, want exactly 1", len(asks))
		}
		req := asks[0]
		if !strings.HasPrefix(req.ID, "gp_") || req.Tool != "session_spawn" || req.Metadata["galopin"] != true {
			t.Errorf("card = %+v", req)
		}
		if req.Metadata["title"] != "it-child-a" || req.Metadata["prompt"] != "child-a first prompt" || req.Metadata["workspaceId"] != ws1.ID {
			t.Errorf("card metadata = %+v", req.Metadata)
		}
		for _, env := range hub.since(mark) {
			if env.Event.Kind == backend.EventPermissionReplied && env.Event.By == "auto" {
				t.Errorf("a galopin approval was auto-replied: %+v", env.Event)
			}
		}
		kids := allTitled("it-child-a")
		if len(kids) != 1 {
			t.Fatalf("child sessions = %d, want 1", len(kids))
		}
		child := getSession(kids[0].ID)
		if child.SpawnedBy == nil || child.SpawnedBy.SessionID != caller.ID || child.SpawnedBy.Title != "it-caller-a" {
			t.Errorf("spawnedBy = %+v", child.SpawnedBy)
		}
		if child.ParentID != "" || child.RootID != child.ID {
			t.Errorf("spawned session must be its own root: parent=%q root=%q", child.ParentID, child.RootID)
		}
		if child.AutoAccept {
			t.Errorf("the child inherited auto-accept")
		}
		if child.WorkspaceID != ws1.ID {
			t.Errorf("child workspace = %q, want the caller's %q", child.WorkspaceID, ws1.ID)
		}
		hub.waitIdle(t, mark, child.ID)
		if !strings.Contains(mockPrompts(), "child-a first prompt") {
			t.Errorf("the child's first prompt never reached the model")
		}
		found := false
		for _, r := range auditRows() {
			if r["tool"] == "session_spawn" && r["from"] == caller.ID && r["to"] == child.ID && r["decision"] == "done" {
				found = true
			}
		}
		if !found {
			t.Errorf("no audit row naming both sessions: %v", auditRows())
		}
		// The persisted marker survives the materializer's own re-reads.
		if got := oc.SpawnMarks()[child.ID]; got.SessionID != caller.ID {
			t.Errorf("SpawnMarks = %+v", oc.SpawnMarks())
		}
	})

	t.Run("spawn: under auto-accept goes through with no card; child has auto-accept off", func(t *testing.T) {
		hub.setApprove(approveAll)
		caller := newSession(ws1, "it-caller-auto", "")
		if err := mat.SetAutoAccept(caller.ID, true); err != nil {
			t.Fatal(err)
		}
		route("trigger-spawn-auto", "session_spawn", spawnArgs("it-child-auto", "child-auto first prompt", "inherit"))
		publish()
		mark := hub.mark()
		prompt(caller, ws1, "trigger-spawn-auto")
		part := hub.toolDone(t, mark, caller.ID, "session_spawn")
		if part.ToolStatus != backend.ToolCompleted {
			t.Fatalf("session_spawn = %s / %q / %q", part.ToolStatus, part.Output, part.ToolError)
		}
		if asks := hub.asks(mark, caller.ID); len(asks) != 0 {
			t.Fatalf("an auto-accepting caller's spawn raised a card: %+v", asks)
		}
		var out map[string]any
		if err := json.Unmarshal([]byte(part.Output), &out); err != nil || out["autoApproved"] != true {
			t.Errorf("result %q does not carry autoApproved: %v", part.Output, err)
		}
		kids := allTitled("it-child-auto")
		if len(kids) != 1 {
			t.Fatalf("child sessions = %d, want 1", len(kids))
		}
		child := getSession(kids[0].ID)
		if child.AutoAccept || mat.AutoAcceptInEffect(child.ID) {
			t.Errorf("the child of an auto-accepting spawner has auto-accept on")
		}
		if child.SpawnedBy == nil || child.SpawnedBy.SessionID != caller.ID {
			t.Errorf("spawnedBy = %+v", child.SpawnedBy)
		}
		hub.waitIdle(t, mark, child.ID)
		found := false
		for _, r := range auditRows() {
			if r["tool"] == "session_spawn" && r["from"] == caller.ID && r["decision"] == "auto" && r["reason"] != nil {
				found = true
			}
		}
		if !found {
			t.Errorf("no decision:auto audit row: %v", auditRows())
		}
	})

	t.Run("spawn: declined by the person creates nothing", func(t *testing.T) {
		hub.setApprove(rejectAll)
		caller := newSession(ws1, "it-caller-r", "")
		route("trigger-spawn-r", "session_spawn", spawnArgs("it-child-r", "never runs", "inherit"))
		publish()
		mark := hub.mark()
		prompt(caller, ws1, "trigger-spawn-r")
		part := hub.toolDone(t, mark, caller.ID, "session_spawn")
		if part.ToolStatus != backend.ToolFailed || !strings.Contains(part.ToolError, "declined") {
			t.Fatalf("declined spawn = %s / %q / %q", part.ToolStatus, part.Output, part.ToolError)
		}
		// The pinned refusal shape (PROTOCOL.md §6): exactly {"refused": "..."}.
		var shape map[string]string
		if err := json.Unmarshal([]byte(part.ToolError), &shape); err != nil || len(shape) != 1 || shape["refused"] == "" {
			t.Errorf("refusal error text = %q, want exactly {\"refused\": ...}", part.ToolError)
		}
		if n := len(allTitled("it-child-r")); n != 0 {
			t.Errorf("a declined spawn created %d sessions", n)
		}
	})

	t.Run("spawn: a plan-mode caller cannot spawn a more permissive session", func(t *testing.T) {
		hub.setApprove(approveAll)
		caller := newSession(ws1, "it-caller-plan", "plan")
		route("trigger-plan-up", "session_spawn", spawnArgs("it-child-up", "should be refused", "build"))
		route("trigger-plan-inherit", "session_spawn", spawnArgs("it-child-inh", "plan child prompt", "inherit"))
		publish()
		mark := hub.mark()
		prompt(caller, ws1, "trigger-plan-up")
		part := hub.toolDone(t, mark, caller.ID, "session_spawn")
		if part.ToolStatus != backend.ToolFailed || !strings.Contains(part.ToolError, "more permissive") {
			t.Fatalf("escalating spawn = %s / %q / %q", part.ToolStatus, part.Output, part.ToolError)
		}
		if a := hub.asks(mark, caller.ID); len(a) != 0 {
			t.Errorf("a refused spawn raised an ask: %+v", a)
		}
		if n := len(allTitled("it-child-up")); n != 0 {
			t.Errorf("the escalating spawn created %d sessions", n)
		}
		hub.waitIdle(t, mark, caller.ID)
		mark = hub.mark()
		prompt(caller, ws1, "trigger-plan-inherit")
		part = hub.toolDone(t, mark, caller.ID, "session_spawn")
		if part.ToolStatus != backend.ToolCompleted {
			t.Fatalf("inheriting spawn = %s / %q / %q", part.ToolStatus, part.Output, part.ToolError)
		}
		kids := allTitled("it-child-inh")
		if len(kids) != 1 {
			t.Fatalf("children = %d", len(kids))
		}
		if got := getSession(kids[0].ID).ModeID; got != "plan" {
			t.Errorf("a plan caller's child came out in mode %q, want plan", got)
		}
	})

	t.Run("spawn: no other workspace, ever", func(t *testing.T) {
		hub.setApprove(approveAll)
		caller := newSession(ws1, "it-caller-ws", "")
		route("trigger-ws-id", "session_spawn", mustJSON2(map[string]any{"title": "it-child-ws", "prompt": "elsewhere", "mode": "inherit", "workspaceId": ws2.ID}))
		route("trigger-ws-dir", "session_spawn", mustJSON2(map[string]any{"title": "it-child-ws2", "prompt": "elsewhere", "mode": "inherit", "directory": ws2.Path}))
		publish()
		for _, trig := range []string{"trigger-ws-id", "trigger-ws-dir"} {
			mark := hub.mark()
			prompt(caller, ws1, trig)
			part := hub.toolDone(t, mark, caller.ID, "session_spawn")
			if part.ToolStatus != backend.ToolFailed || !strings.Contains(part.ToolError, "unsupported argument") {
				t.Errorf("%s = %s / %q / %q", trig, part.ToolStatus, part.Output, part.ToolError)
			}
			hub.waitIdle(t, mark, caller.ID)
		}
		for _, title := range []string{"it-child-ws", "it-child-ws2"} {
			if n := len(allTitled(title)); n != 0 {
				t.Errorf("%s: %d sessions created despite the refusal", title, n)
			}
		}
		list, err := oc.ListSessions(ctx, ws2.Path)
		if err != nil {
			t.Fatal(err)
		}
		if len(list) != 0 {
			t.Errorf("the other workspace has %d sessions", len(list))
		}
	})

	t.Run("a forged caller is refused: a session id alone borrows nothing", func(t *testing.T) {
		victim := newSession(ws1, "it-victim", "build")
		start := time.Now()
		_, err := mc.agentTools.handle(ctx, backend.ToolCall{
			Tool: "session_spawn", SessionID: victim.ID, CallID: "call_forged",
			Args: []byte(spawnArgs("it-child-forged", "x", "inherit")),
		})
		if err == nil || !strings.Contains(err.Error(), "could not match") {
			t.Fatalf("forged call = %v", err)
		}
		if n := len(allTitled("it-child-forged")); n != 0 {
			t.Errorf("a forged call created %d sessions", n)
		}
		t.Logf("refused after %s", time.Since(start).Round(time.Millisecond))
	})

	t.Run("spawn limits: live sessions, rate, and chain depth", func(t *testing.T) {
		hub.setApprove(approveAll)
		caller := newSession(ws1, "it-caller-lim", "")
		slowRoute("slow-child")
		for i := 1; i <= 8; i++ {
			route(fmt.Sprintf("trigger-lim-%d", i), "session_spawn", spawnArgs(fmt.Sprintf("it-lim-%d", i), fmt.Sprintf("slow-child %d", i), "inherit"))
		}
		publish()
		spawn := func(i int) backend.Part {
			t.Helper()
			mark := hub.mark()
			prompt(caller, ws1, fmt.Sprintf("trigger-lim-%d", i))
			part := hub.toolDone(t, mark, caller.ID, "session_spawn")
			hub.waitIdle(t, mark, caller.ID)
			return part
		}
		settleTitles := func(ids ...int) {
			for _, i := range ids {
				for _, s := range allTitled(fmt.Sprintf("it-lim-%d", i)) {
					settle(s.ID)
				}
			}
		}
		for i := 1; i <= 3; i++ {
			if p := spawn(i); p.ToolStatus != backend.ToolCompleted {
				t.Fatalf("spawn %d = %s / %q", i, p.ToolStatus, p.ToolError)
			}
		}
		// Three spawned sessions are live: the fourth is refused.
		if p := spawn(4); p.ToolStatus != backend.ToolFailed || !strings.Contains(p.ToolError, "live spawn limit") {
			t.Fatalf("4th live spawn = %s / %q / %q", p.ToolStatus, p.Output, p.ToolError)
		}
		// They finish and pass the grace window: room again, until the rate
		// window (six attempts in ten minutes) closes.
		settleTitles(1, 2, 3)
		clock.advance(time.Minute)
		for _, i := range []int{5, 6, 7} {
			if p := spawn(i); p.ToolStatus != backend.ToolCompleted {
				t.Fatalf("spawn %d = %s / %q / %q", i, p.ToolStatus, p.Output, p.ToolError)
			}
		}
		settleTitles(5, 6, 7)
		clock.advance(time.Minute)
		if p := spawn(8); p.ToolStatus != backend.ToolFailed || !strings.Contains(p.ToolError, "rate limit") {
			t.Fatalf("7th spawn attempt in the window = %s / %q / %q", p.ToolStatus, p.Output, p.ToolError)
		}
		if n := len(allTitled("it-lim-8")); n != 0 {
			t.Errorf("the rate-limited spawn created %d sessions", n)
		}
		// The window is a window: ten minutes on, spawning is allowed again.
		clock.advance(11 * time.Minute)
		if p := spawn(8); p.ToolStatus != backend.ToolCompleted {
			t.Fatalf("spawn after the window = %s / %q / %q", p.ToolStatus, p.Output, p.ToolError)
		}

		// Chain depth: root -> c1 -> c2, and c2 may not spawn.
		root := newSession(ws1, "it-chain-root", "")
		route("trigger-chain-0", "session_spawn", spawnArgs("it-chain-1", "trigger-chain-1 go", "inherit"))
		route("trigger-chain-1", "session_spawn", spawnArgs("it-chain-2", "trigger-chain-2 go", "inherit"))
		route("trigger-chain-2", "session_spawn", spawnArgs("it-chain-3", "trigger-chain-3 go", "inherit"))
		publish()
		mark := hub.mark()
		prompt(root, ws1, "trigger-chain-0")
		hub.wait(t, mark, 120*time.Second, "the depth-2 spawn to be refused", func(e sessions.Envelope) bool {
			p := e.Event.Part
			return e.Event.Kind == backend.EventPart && p != nil && p.Tool == "session_spawn" && p.ToolStatus == backend.ToolFailed &&
				strings.Contains(p.ToolError, "spawn chain limit")
		})
		if n := len(allTitled("it-chain-3")); n != 0 {
			t.Errorf("a session at depth 2 spawned %d sessions", n)
		}
		if len(allTitled("it-chain-1")) != 1 || len(allTitled("it-chain-2")) != 1 {
			t.Errorf("the chain root->1->2 was not built")
		}
	})

	t.Run("session_list: top-level sessions of the machine, own tree marked", func(t *testing.T) {
		hub.setApprove(approveAll)
		caller := newSession(ws1, "it-caller-list", "")
		route("trigger-list", "session_list", `{"note":"x"}`)
		publish()
		mark := hub.mark()
		prompt(caller, ws1, "trigger-list")
		part := hub.toolDone(t, mark, caller.ID, "session_list")
		if part.ToolStatus != backend.ToolCompleted {
			t.Fatalf("session_list = %s / %q", part.ToolStatus, part.ToolError)
		}
		var rows []map[string]any
		if err := json.Unmarshal([]byte(part.Output), &rows); err != nil {
			t.Fatalf("output %q: %v", part.Output, err)
		}
		saw := map[string]map[string]any{}
		for _, r := range rows {
			saw[r["title"].(string)] = r
		}
		for _, want := range []string{"it-caller-a", "it-child-a", "it-caller-list"} {
			if saw[want] == nil {
				t.Errorf("%s is not listed: %s", want, part.Output)
			}
		}
		if r := saw["it-child-a"]; r != nil {
			if sb, _ := r["spawnedBy"].(map[string]any); sb == nil || sb["title"] != "it-caller-a" {
				t.Errorf("spawned row = %+v", r)
			}
		}
		if r := saw["it-caller-list"]; r != nil && r["note"] == nil {
			t.Errorf("the caller's own row is not marked: %+v", r)
		}
		if a := hub.asks(mark, caller.ID); len(a) != 0 {
			t.Errorf("a read-only list raised an ask: %+v", a)
		}
	})

	t.Run("deleting the spawner leaves the spawned session, and its spawnedBy marker survives", func(t *testing.T) {
		spawners := allTitled("it-caller-a")
		kids := allTitled("it-child-a")
		if len(spawners) != 1 || len(kids) != 1 {
			t.Fatalf("spawner/child sessions = %d/%d, want 1/1", len(spawners), len(kids))
		}
		spawnerID, childID := spawners[0].ID, kids[0].ID
		if _, operr := mc.Handle(ctx, "session.delete", mustJSONArgs(t, map[string]any{"sessionId": spawnerID})); operr != nil {
			t.Fatalf("session.delete spawner: %+v", operr)
		}
		if got := allTitled("it-caller-a"); len(got) != 0 {
			t.Fatalf("the spawner is still listed after delete: %+v", got)
		}
		// A spawned session is a peer: no parent edge, so nothing cascades.
		left := allTitled("it-child-a")
		if len(left) != 1 || left[0].ID != childID {
			t.Fatalf("the spawned session did not survive its spawner: %+v", left)
		}
		child := getSession(childID)
		if child.ParentID != "" || child.RootID != child.ID {
			t.Errorf("spawned session must stay its own root: parent=%q root=%q", child.ParentID, child.RootID)
		}
		if child.SpawnedBy == nil || child.SpawnedBy.SessionID != spawnerID || child.SpawnedBy.Title != "it-caller-a" {
			t.Errorf("spawnedBy after the spawner's delete = %+v", child.SpawnedBy)
		}
	})

	t.Run("send: approved, delivered as an agent message; refusals; hop and pair limits", func(t *testing.T) {
		hub.setApprove(approveAll)
		a := newSession(ws1, "it-send-a", "")
		b := newSession(ws2, "it-send-b", "")
		route("trigger-send-self", "session_send", mustJSON2(map[string]any{"target": a.ID, "text": "to myself"}))
		route("trigger-send-nope", "session_send", mustJSON2(map[string]any{"target": "ses_doesnotexist", "text": "x"}))
		route("trigger-send-1", "session_send", mustJSON2(map[string]any{"target": b.ID, "text": "hello from a"}))
		publish()

		// Refusals raise no ask.
		for _, tc := range []struct{ trig, want string }{
			{"trigger-send-self", "yourself"},
			{"trigger-send-nope", "no such session"},
		} {
			mark := hub.mark()
			prompt(a, ws1, tc.trig)
			part := hub.toolDone(t, mark, a.ID, "session_send")
			if part.ToolStatus != backend.ToolFailed || !strings.Contains(part.ToolError, tc.want) {
				t.Errorf("%s = %s / %q / %q", tc.trig, part.ToolStatus, part.Output, part.ToolError)
			}
			if asks := hub.asks(mark, a.ID); len(asks) != 0 {
				t.Errorf("%s raised an ask", tc.trig)
			}
			hub.waitIdle(t, mark, a.ID)
		}

		mark := hub.mark()
		prompt(a, ws1, "trigger-send-1")
		part := hub.toolDone(t, mark, a.ID, "session_send")
		if part.ToolStatus != backend.ToolCompleted {
			t.Fatalf("send = %s / %q / %q", part.ToolStatus, part.Output, part.ToolError)
		}
		asks := hub.asks(mark, a.ID)
		if len(asks) != 1 || asks[0].Tool != "session_send" || asks[0].Metadata["galopin"] != true || asks[0].Metadata["text"] != "hello from a" {
			t.Fatalf("send card = %+v", asks)
		}
		if hop, _ := asks[0].Metadata["hop"].(int); hop != 1 {
			t.Errorf("card hop = %v", asks[0].Metadata["hop"])
		}
		hub.wait(t, mark, 60*time.Second, "b's user message marked sentBy", func(e sessions.Envelope) bool {
			m := e.Event.Message
			return e.SessionID == b.ID && e.Event.Kind == backend.EventMessage && m != nil && m.Role == "user" && m.SentBy != nil &&
				m.SentBy.SessionID == a.ID && m.SentBy.Title == "it-send-a" && m.SentBy.Hop == 1
		})
		hub.waitIdle(t, mark, b.ID)
		if !strings.Contains(mockPrompts(), "hello from a") || !strings.Contains(mockPrompts(), "not by your person") {
			t.Errorf("the target's model did not get the message and the sender preface")
		}
		// The preface is a synthetic part: the transcript never shows it as the person's text.
		res, operr := mc.Handle(ctx, "session.sync", mustJSONArgs(t, map[string]any{"sessionId": b.ID}))
		if operr != nil {
			t.Fatal(operr)
		}
		snap := res.(map[string]any)["snapshot"].(*backend.Transcript)
		sawSynthetic, sawText := false, false
		for _, e := range snap.Messages {
			if e.Message.Role != "user" || e.Message.SentBy == nil {
				continue
			}
			if e.Message.SentBy.Hop != 1 {
				t.Errorf("snapshot sentBy = %+v", e.Message.SentBy)
			}
			for _, p := range e.Parts {
				if p.Type == backend.PartText && p.Synthetic && strings.Contains(p.Text, "not by your person") {
					sawSynthetic = true
				}
				if p.Type == backend.PartText && !p.Synthetic && p.Text == "hello from a" {
					sawText = true
				}
			}
		}
		if !sawSynthetic || !sawText {
			t.Errorf("snapshot parts: synthetic preface=%v, plain text=%v", sawSynthetic, sawText)
		}

		// A declined send delivers nothing.
		hub.setApprove(rejectAll)
		route("trigger-send-rej", "session_send", mustJSON2(map[string]any{"target": b.ID, "text": "never delivered"}))
		publish()
		mark = hub.mark()
		prompt(a, ws1, "trigger-send-rej")
		part = hub.toolDone(t, mark, a.ID, "session_send")
		if part.ToolStatus != backend.ToolFailed || !strings.Contains(part.ToolError, "declined") {
			t.Errorf("declined send = %s / %q", part.ToolStatus, part.ToolError)
		}
		if strings.Contains(mockPrompts(), "never delivered") {
			t.Errorf("a declined send reached the target")
		}
		hub.setApprove(approveAll)
	})

	t.Run("send: hop 4 falls back to a card instead of refusing; hop 1-3 under auto-accept need none", func(t *testing.T) {
		hub.setApprove(approveAll)
		s := make([]backend.Session, 5)
		for i := range s {
			s[i] = newSession(ws1, fmt.Sprintf("it-hop-%d", i), "build")
			if err := mat.SetAutoAccept(s[i].ID, true); err != nil {
				t.Fatal(err)
			}
		}
		// s0 (a person's prompt, hop 0) -> s1 (hop 1) -> s2 (2) -> s3 (3) -> s4 (hop 4: a card).
		route("trigger-hop-0", "session_send", mustJSON2(map[string]any{"target": s[1].ID, "text": "trigger-hop-1 relay"}))
		route("trigger-hop-1", "session_send", mustJSON2(map[string]any{"target": s[2].ID, "text": "trigger-hop-2 relay"}))
		route("trigger-hop-2", "session_send", mustJSON2(map[string]any{"target": s[3].ID, "text": "trigger-hop-3 relay"}))
		route("trigger-hop-3", "session_send", mustJSON2(map[string]any{"target": s[4].ID, "text": "trigger-hop-4 relay"}))
		publish()
		mark := hub.mark()
		prompt(s[0], ws1, "trigger-hop-0")
		hub.wait(t, mark, 120*time.Second, "the 4th hop to reach s4", func(e sessions.Envelope) bool {
			m := e.Event.Message
			return e.SessionID == s[4].ID && e.Event.Kind == backend.EventMessage && m != nil && m.Role == "user" && m.SentBy != nil && m.SentBy.Hop == 4
		})
		hub.waitIdle(t, mark, s[3].ID)
		for i := 0; i < 4; i++ {
			asks := hub.asks(mark, s[i].ID)
			switch {
			case i < 3 && len(asks) != 0:
				t.Errorf("hop %d under auto-accept raised a card: %+v", i+1, asks)
			case i == 3 && (len(asks) != 1 || asks[0].Tool != "session_send" || asks[0].Metadata["hop"] != 4):
				t.Errorf("hop 4 did not fall back to exactly one card: %+v", asks)
			}
		}
	})

	t.Run("send: auto-accept build to build goes through with no card, both ways; plan to build asks; build to plan goes through", func(t *testing.T) {
		hub.setApprove(approveAll)
		a := newSession(ws1, "it-auto-a", "build")
		b := newSession(ws1, "it-auto-b", "build")
		p := newSession(ws1, "it-auto-plan", "plan")
		q := newSession(ws1, "it-auto-plan-q", "plan")
		// The mock matches a trigger anywhere in a session's history, so a
		// session that has received a message must not be used as a sender
		// again or it would replay its first trigger: each reply goes to a
		// fresh session.
		a2 := newSession(ws1, "it-auto-a2", "build")
		b3 := newSession(ws1, "it-auto-b3", "build")
		for _, x := range []backend.Session{a, b, p} {
			if err := mat.SetAutoAccept(x.ID, true); err != nil {
				t.Fatal(err)
			}
		}
		send := func(tag string, target backend.Session, text string) string {
			route(tag, "session_send", mustJSON2(map[string]any{"target": target.ID, "text": text}))
			return tag
		}
		aToB := send("trigger-auto-ab", b, "auto hello b")
		bToA := send("trigger-auto-ba", a2, "auto hello a2")
		aToPlan := send("trigger-auto-aq", q, "auto hello plan")
		pToB := send("trigger-auto-pb", b3, "plan asks build")
		publish()

		run := func(from backend.Session, ws workspaces.Workspace, trig string) (backend.Part, []backend.PermissionRequest) {
			mark := hub.mark()
			prompt(from, ws, trig)
			part := hub.toolDone(t, mark, from.ID, "session_send")
			hub.waitIdle(t, mark, from.ID)
			return part, hub.asks(mark, from.ID)
		}
		for _, c := range []struct {
			name     string
			from     backend.Session
			ws       workspaces.Workspace
			trig     string
			wantCard bool
		}{
			{"build->build", a, ws1, aToB, false},
			{"build->build back", b, ws1, bToA, false},
			{"build->plan", a, ws1, aToPlan, false},
			{"plan->build", p, ws1, pToB, true},
		} {
			part, asks := run(c.from, c.ws, c.trig)
			if part.ToolStatus != backend.ToolCompleted {
				t.Fatalf("%s = %s / %q / %q", c.name, part.ToolStatus, part.Output, part.ToolError)
			}
			if c.wantCard && (len(asks) != 1 || asks[0].Tool != "session_send") {
				t.Errorf("%s: want exactly one card, got %+v", c.name, asks)
			}
			if !c.wantCard {
				if len(asks) != 0 {
					t.Errorf("%s: an auto-approved send raised a card: %+v", c.name, asks)
				}
				if part.Output != `{"autoApproved":true}` {
					t.Errorf("%s: result = %q, want the autoApproved marker", c.name, part.Output)
				}
			} else if part.Output != "{}" {
				t.Errorf("%s: a carded send's result = %q, want {}", c.name, part.Output)
			}
		}
		autos := 0
		for _, r := range auditRows() {
			if r["tool"] == "session_send" && r["decision"] == "auto" && (r["from"] == a.ID || r["from"] == b.ID) && r["reason"] != nil {
				autos++
			}
		}
		if autos != 3 {
			t.Errorf("decision:auto audit rows = %d, want 3: %v", autos, auditRows())
		}
	})

	t.Run("send: a cross-workspace send under auto-accept shows a card", func(t *testing.T) {
		hub.setApprove(approveAll)
		// Build to build, both auto-accepting, but the target is in another
		// workspace: the sender's unattended reach is its own workspace only.
		// (An unrankable sender is proven by the noMorePermissive unit test:
		// opencode cannot run a turn in an agent it does not have.)
		a := newSession(ws1, "it-xws-a", "build")
		b := newSession(ws2, "it-xws-b", "build")
		for _, x := range []backend.Session{a, b} {
			if err := mat.SetAutoAccept(x.ID, true); err != nil {
				t.Fatal(err)
			}
		}
		route("trigger-xws-ab", "session_send", mustJSON2(map[string]any{"target": b.ID, "text": "across workspaces"}))
		publish()
		mark := hub.mark()
		prompt(a, ws1, "trigger-xws-ab")
		part := hub.toolDone(t, mark, a.ID, "session_send")
		if part.ToolStatus != backend.ToolCompleted || part.Output != "{}" {
			t.Errorf("cross-workspace send = %s / %q / %q", part.ToolStatus, part.Output, part.ToolError)
		}
		if asks := hub.asks(mark, a.ID); len(asks) != 1 || asks[0].Tool != "session_send" {
			t.Errorf("want exactly one card, got %+v", asks)
		}
		hub.waitIdle(t, mark, a.ID)
	})

	t.Run("send: per-pair rate limit refuses the 6th message in a minute", func(t *testing.T) {
		hub.setApprove(approveAll)
		a := newSession(ws1, "it-rate-a", "build")
		b := newSession(ws2, "it-rate-b", "build")
		// Under auto-accept: the loop brake is a refusal, never a fallback.
		if err := mat.SetAutoAccept(a.ID, true); err != nil {
			t.Fatal(err)
		}
		for i := 1; i <= 6; i++ {
			route(fmt.Sprintf("trigger-rate-%d", i), "session_send", mustJSON2(map[string]any{"target": b.ID, "text": fmt.Sprintf("rate message %d", i)}))
		}
		publish()
		for i := 1; i <= 6; i++ {
			mark := hub.mark()
			prompt(a, ws1, fmt.Sprintf("trigger-rate-%d", i))
			part := hub.toolDone(t, mark, a.ID, "session_send")
			switch {
			case i <= 5 && part.ToolStatus != backend.ToolCompleted:
				t.Fatalf("send %d = %s / %q", i, part.ToolStatus, part.ToolError)
			case i == 6 && (part.ToolStatus != backend.ToolFailed || !strings.Contains(part.ToolError, "rate limit")):
				t.Fatalf("6th send = %s / %q / %q", part.ToolStatus, part.Output, part.ToolError)
			}
			hub.waitIdle(t, mark, a.ID)
			if i <= 5 {
				hub.waitIdle(t, mark, b.ID)
			}
		}
	})

	t.Run("send: a busy target folds the message into its running turn (steer)", func(t *testing.T) {
		hub.setApprove(approveAll)
		a := newSession(ws1, "it-fold-a", "")
		b := newSession(ws2, "it-fold-b", "")
		slowRoute("slow-target")
		route("trigger-fold", "session_send", mustJSON2(map[string]any{"target": b.ID, "text": "folded message"}))
		publish()
		mark := hub.mark()
		prompt(b, ws2, "slow-target work")
		hub.wait(t, mark, 30*time.Second, "b to be busy", func(e sessions.Envelope) bool {
			return e.SessionID == b.ID && e.Event.Kind == backend.EventStatus && e.Event.Status == backend.StatusBusy
		})
		prompt(a, ws1, "trigger-fold")
		part := hub.toolDone(t, mark, a.ID, "session_send")
		if part.ToolStatus != backend.ToolCompleted {
			t.Fatalf("send to a busy target = %s / %q / %q", part.ToolStatus, part.Output, part.ToolError)
		}
		hub.waitIdle(t, mark, b.ID)
		// One continuous turn: the message reached the model, and b had no
		// idle between its first busy and the end that came after the fold.
		if !strings.Contains(mockPrompts(), "folded message") {
			t.Fatalf("the folded message never reached the model")
		}
		// opencode announces one idle twice (session.status and session.idle):
		// count transitions, not events.
		idles, folded, prevIdle := 0, false, false
		for _, e := range hub.since(mark) {
			if e.SessionID != b.ID {
				continue
			}
			if e.Event.Kind == backend.EventStatus {
				nowIdle := e.Event.Status == backend.StatusIdle
				if nowIdle && prevIdle {
					continue
				}
				prevIdle = nowIdle
			}
			if e.Event.Kind == backend.EventMessage && e.Event.Message != nil && e.Event.Message.SentBy != nil {
				folded = true
			}
			if e.Event.Kind == backend.EventStatus && e.Event.Status == backend.StatusIdle {
				idles++
				if !folded {
					t.Errorf("b went idle before the sent message arrived: the turn was not steered")
				}
			}
		}
		if !folded {
			t.Errorf("b's transcript never got the sentBy message")
		}
		if idles != 1 {
			t.Errorf("b went idle %d times; a folded message is one continuous turn (want 1)", idles)
		}
	})
}

func mustJSON2(v any) string {
	body, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(body)
}
