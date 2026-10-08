package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"galopin/internal/backend"
	backendopencode "galopin/internal/backend/opencode"
	"galopin/internal/link"
	"galopin/internal/permrules"
	"galopin/internal/policy"
	"galopin/internal/sessions"
	"galopin/internal/workspaces"
)

// The schedule tools against a real opencode, over a REAL link to a fake
// Cerea that answers the machine calls (PROTOCOL.md §5 "Machine calls"). Each
// subtest drives one tool call through opencode's custom-tool path, galopin's
// gate and the link, and checks what the person saw (cards) and what Cerea
// was asked to do. Gated behind GALOPIN_OPENCODE_IT=1.

// fakeScheduleCerea is the Cerea half: it records every call and answers
// from its little world of two schedules.
type fakeScheduleCerea struct {
	mu    sync.Mutex
	calls []map[string]any
	// runOf: root session -> the schedule it is a run of (schedule.context).
	runOf map[string]string
	// selfRoot: the root session that is a run of "sched-self".
	selfRoot string
}

func (f *fakeScheduleCerea) answer(call map[string]any) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
	root, _ := call["rootSessionId"].(string)
	args, _ := call["args"].(map[string]any)
	ok := func(result any) map[string]any {
		return map[string]any{"type": "callres", "id": call["id"], "ok": true, "result": result}
	}
	switch call["op"] {
	case "schedule.context":
		var of any
		if s, found := f.runOf[root]; found {
			of = s
		}
		return ok(map[string]any{"scheduledRunOf": of, "enabled": true})
	case "schedule.list":
		item := func(id, name, text string, self bool, by map[string]any) map[string]any {
			return map[string]any{
				"id": id, "name": name, "recurrenceText": text, "timezone": "UTC", "paused": false, "status": "active",
				"nextRunAt": "2026-10-09T02:00:00.000Z", "lastRunAt": nil,
				"workspace": map[string]any{"id": "ws-x", "name": "ws-one"}, "session": "new",
				"permissionMode": "ask", "coordination": []string{}, "agentMode": "build",
				"prompt": "the stored prompt", "recurrence": map[string]any{"type": "daily", "at": "02:00"},
				"createdBy": by, "self": self,
			}
		}
		return ok(map[string]any{"schedules": []map[string]any{
			item("sched-self", "nightly check", "every day at 02:00", root == f.selfRoot,
				map[string]any{"kind": "agent", "sessionId": f.selfRoot, "title": "it-sched-self"}),
			item("sched-other", "someone else's", "every hour", false, map[string]any{"kind": "person"}),
		}})
	case "schedule.create":
		return ok(map[string]any{"schedule": map[string]any{"id": "sched-new", "name": args["name"]}})
	case "schedule.update":
		return ok(map[string]any{"schedule": map[string]any{"id": args["id"]}})
	case "schedule.delete":
		return ok(map[string]any{})
	}
	return map[string]any{"type": "callres", "id": call["id"], "ok": false, "error": map[string]any{"code": "unsupported", "message": "unknown op"}}
}

// opsFrom is the ops Cerea received from sessionID after mark.
func (f *fakeScheduleCerea) opsFrom(mark int, sessionID string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.calls[mark:] {
		if c["sessionId"] == sessionID {
			out = append(out, c["op"].(string))
		}
	}
	return out
}

func (f *fakeScheduleCerea) mark() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeScheduleCerea) last(op string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.calls) - 1; i >= 0; i-- {
		if f.calls[i]["op"] == op {
			return f.calls[i]
		}
	}
	return nil
}

type itCred struct{}

func (itCred) Token(context.Context) (string, error)        { return "tok", nil }
func (itCred) ForceRefresh(context.Context) (string, error) { return "tok", nil }
func (itCred) NextRenewal() time.Time                       { return time.Now().Add(time.Hour) }

func TestScheduleToolsIntegration(t *testing.T) {
	if !itEnabled("GALOPIN_OPENCODE_IT", "PYSTINO_AGENT_OPENCODE_IT") {
		t.Skip("set GALOPIN_OPENCODE_IT=1 to run (spawns real opencode + a mock LLM)")
	}
	if _, err := exec.LookPath("opencode"); err != nil {
		t.Skipf("opencode not on PATH: %v", err)
	}

	mockOrigin := startMockLLM(t, itFreePort(t))
	root := t.TempDir()
	dirs := map[string]string{}
	for _, n := range []string{"home", "config", "data", "cache", "work1", "state"} {
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
	var ceilMu sync.Mutex
	ceiling := map[string]permrules.Action{}
	oc := backendopencode.New(backendopencode.Config{
		ConfigPath: configPath, Env: env, StateDir: dirs["state"],
		OverlayPath:    filepath.Join(dirs["state"], "opencode-overlay.json"),
		ToolsDir:       filepath.Join(dirs["state"], "opencode-tools"),
		StartupTimeout: 90 * time.Second, Logf: t.Logf,
		Permissions: func() permrules.Layers {
			ceilMu.Lock()
			defer ceilMu.Unlock()
			max := map[string]permrules.Action{}
			for k, v := range ceiling {
				max[k] = v
			}
			return permrules.Layers{Ceiling: permrules.Ceiling{Max: max}}
		},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if err := oc.Start(ctx); err != nil {
		t.Fatalf("starting opencode: %v", err)
	}
	t.Cleanup(func() { _ = oc.Stop() })

	pol := policy.Default()
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
	mc := newMachine(reg, oc, mat, pol)
	audit, err := newAuditLogger(dirs["state"])
	if err != nil {
		t.Fatal(err)
	}
	mc.AttachAudit(audit)
	if mc.agentTools == nil {
		t.Fatal("agent tools not installed")
	}
	setCeiling := func(a permrules.Action) {
		ceilMu.Lock()
		if a == permrules.Allow {
			delete(ceiling, scheduleKey)
		} else {
			ceiling[scheduleKey] = a
		}
		ceilMu.Unlock()
		mc.pol.Permission.Max = map[string]string{}
		if a != permrules.Allow {
			mc.pol.Permission.Max[scheduleKey] = string(a)
		}
	}

	// The fake Cerea, on a real link.
	cerea := &fakeScheduleCerea{runOf: map[string]string{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"pystino-machine.v1"}})
		if err != nil {
			return
		}
		conn.SetReadLimit(link.MaxFrameBytes)
		cctx := r.Context()
		if _, _, err := conn.Read(cctx); err != nil { // hello
			return
		}
		welcome, _ := json.Marshal(map[string]any{"type": "welcome", "deviceId": "dev-it", "status": "paired",
			"features": map[string]any{"machineCalls": []string{"schedule"}}})
		_ = conn.Write(cctx, websocket.MessageText, welcome)
		for {
			_, raw, err := conn.Read(cctx)
			if err != nil {
				return
			}
			var frame map[string]any
			if json.Unmarshal(raw, &frame) != nil || frame["type"] != "call" {
				continue
			}
			out, _ := json.Marshal(cerea.answer(frame))
			_ = conn.Write(cctx, websocket.MessageText, out)
		}
	}))
	t.Cleanup(srv.Close)
	lnk := link.New(link.Config{
		CereaOrigin: srv.URL, MachineID: "m-it", MachineName: "it", Cred: itCred{},
		Hello: func() link.Hello { return buildHello(oc, pol) }, Handler: mc,
	})
	mc.AttachLink(lnk)
	go func() { _ = lnk.Run(ctx) }()
	for deadline := time.Now().Add(10 * time.Second); !lnk.Supports("schedule"); {
		if time.Now().After(deadline) {
			t.Fatal("the link never came up with machineCalls")
		}
		time.Sleep(20 * time.Millisecond)
	}

	hub := &itHub{t: t, mc: mc}
	go hub.run(mat)
	approveAll := func(*backend.PermissionRequest) string { return "once" }
	rejectAll := func(*backend.PermissionRequest) string { return "reject" }

	var routes []map[string]any
	var callSeq int
	route := func(contains, tool string, args any) {
		callSeq++
		routes = append([]map[string]any{{"contains": contains, "scenario": map[string]any{
			"toolCalls":    []map[string]any{{"id": fmt.Sprintf("call_sched_%d", callSeq), "name": tool, "arguments": mustJSON2(args)}},
			"content":      []string{"done"},
			"chunkDelayMs": 5, "finishReason": "stop",
		}}}, routes...)
		setMockScenario(t, mockOrigin, map[string]any{"content": []string{"ok"}, "chunkDelayMs": 5, "finishReason": "stop", "routes": routes})
	}
	newSession := func(title string, mode permrules.Action) backend.Session {
		t.Helper()
		s, err := oc.CreateSession(ctx, ws1.Path, backend.CreateSessionOptions{Title: title})
		if err != nil {
			t.Fatal(err)
		}
		mc.trackSession(ws1, s)
		if err := oc.SetPermissionMode(ctx, ws1.Path, s.ID, mode); err != nil {
			t.Fatal(err)
		}
		return s
	}
	// run prompts the session with trigger and returns the finished tool part.
	run := func(s backend.Session, trigger, tool string) (backend.Part, int, int) {
		t.Helper()
		mark, cmark := hub.mark(), cerea.mark()
		if err := oc.Prompt(ctx, ws1.Path, s.ID, backend.Prompt{Text: trigger}); err != nil {
			t.Fatal(err)
		}
		part := hub.toolDone(t, mark, s.ID, tool)
		return part, mark, cmark
	}
	createArgs := func(name string) map[string]any {
		return map[string]any{
			"name": name, "prompt": "check the nightly build and report", "recurrence": map[string]any{"type": "daily", "at": "09:00"},
			"timezone": "", "workspaceId": "", "session": "this", "permissionMode": "ask", "agentMode": "plan",
			"coordination": []string{"session_list", "session_read", "session_send"},
		}
	}

	t.Run("capability and tool files", func(t *testing.T) {
		if !oc.Capabilities().ScheduleTools {
			t.Fatal("scheduleTools capability is off")
		}
		if !buildHello(oc, pol).Backends[0].Capabilities["scheduleTools"] {
			t.Fatal("hello does not carry scheduleTools")
		}
		for _, name := range []string{"schedule_list", "schedule_create", "schedule_update", "schedule_delete"} {
			if _, err := os.Stat(filepath.Join(dirs["state"], "opencode-tools", "tools", name+".js")); err != nil {
				t.Errorf("tool file %s: %v", name, err)
			}
		}
	})

	t.Run("list asks nothing and carries the caller's facts", func(t *testing.T) {
		hub.setApprove(rejectAll)
		s := newSession("it-sched-list", permrules.Ask)
		route("trigger-sched-list", "schedule_list", map[string]any{"note": "looking"})
		part, mark, _ := run(s, "trigger-sched-list", "schedule_list")
		if part.ToolStatus != backend.ToolCompleted || !strings.Contains(part.Output, "sched-self") {
			t.Fatalf("schedule_list = %s / %q / %q", part.ToolStatus, part.Output, part.ToolError)
		}
		if n := len(hub.asks(mark, s.ID)); n != 0 {
			t.Fatalf("list raised %d cards", n)
		}
		call := cerea.last("schedule.list")
		caller, _ := call["caller"].(map[string]any)
		if call["rootSessionId"] != s.ID || caller["workspaceId"] != ws1.ID || caller["permissionMode"] != "ask" {
			t.Fatalf("call = %v", call)
		}
	})

	t.Run("create under Allow goes through with no card", func(t *testing.T) {
		hub.setApprove(rejectAll) // a card would be declined: the create must not need one
		s := newSession("it-sched-allow", permrules.Allow)
		route("trigger-sched-create-allow", "schedule_create", createArgs("nightly build check"))
		part, mark, cmark := run(s, "trigger-sched-create-allow", "schedule_create")
		if part.ToolStatus != backend.ToolCompleted || !strings.Contains(part.Output, `"autoApproved":true`) {
			t.Fatalf("schedule_create = %s / %q / %q", part.ToolStatus, part.Output, part.ToolError)
		}
		if n := len(hub.asks(mark, s.ID)); n != 0 {
			t.Fatalf("create under Allow raised %d cards", n)
		}
		if ops := cerea.opsFrom(cmark, s.ID); strings.Join(ops, ",") != "schedule.context,schedule.create" {
			t.Fatalf("ops = %v", ops)
		}
		args := cerea.last("schedule.create")["args"].(map[string]any)
		if args["workspaceId"] != ws1.ID || args["session"] != "this" || args["permissionMode"] != "ask" || args["timezone"] != nil ||
			args["agentMode"] != "plan" || fmt.Sprint(args["coordination"]) != "[session_list session_read session_send]" {
			t.Fatalf("create args = %v", args)
		}
		if rec, _ := args["recurrence"].(map[string]any); rec["type"] != "daily" || rec["at"] != "09:00" {
			t.Fatalf("recurrence = %v", args["recurrence"])
		}
	})

	t.Run("create under Ask shows the full card", func(t *testing.T) {
		hub.setApprove(approveAll)
		s := newSession("it-sched-ask", permrules.Ask)
		route("trigger-sched-create-ask", "schedule_create", createArgs("asked check"))
		part, mark, _ := run(s, "trigger-sched-create-ask", "schedule_create")
		if part.ToolStatus != backend.ToolCompleted {
			t.Fatalf("schedule_create = %s / %q", part.ToolStatus, part.ToolError)
		}
		asks := hub.asks(mark, s.ID)
		if len(asks) != 1 || asks[0].Tool != "schedule_create" || !strings.HasPrefix(asks[0].ID, "gp_") {
			t.Fatalf("asks = %+v", asks)
		}
		card, _ := asks[0].Metadata["schedule"].(map[string]any)
		if card["name"] != "asked check" || card["prompt"] != "check the nightly build and report" || card["recurrenceText"] != "every day at 09:00" || card["permissionMode"] != "ask" {
			t.Fatalf("card = %v", asks[0].Metadata)
		}
	})

	t.Run("create from a scheduled run asks even under Allow", func(t *testing.T) {
		hub.setApprove(rejectAll)
		s := newSession("it-sched-run", permrules.Allow)
		cerea.mu.Lock()
		cerea.runOf[s.ID] = "sched-self"
		cerea.mu.Unlock()
		route("trigger-sched-create-run", "schedule_create", createArgs("runaway"))
		part, mark, cmark := run(s, "trigger-sched-create-run", "schedule_create")
		if part.ToolStatus != backend.ToolFailed || !strings.Contains(part.ToolError, "declined") {
			t.Fatalf("schedule_create = %s / %q / %q", part.ToolStatus, part.Output, part.ToolError)
		}
		asks := hub.asks(mark, s.ID)
		if len(asks) != 1 || asks[0].Metadata["scheduledRun"] != true {
			t.Fatalf("asks = %+v", asks)
		}
		for _, op := range cerea.opsFrom(cmark, s.ID) {
			if op == "schedule.create" {
				t.Fatal("a declined create reached Cerea")
			}
		}
	})

	t.Run("a run pausing its own schedule needs no card, even under the session's Deny", func(t *testing.T) {
		hub.setApprove(rejectAll)
		s := newSession("it-sched-self", permrules.Deny)
		cerea.mu.Lock()
		cerea.selfRoot = s.ID
		cerea.mu.Unlock()
		route("trigger-sched-self-pause", "schedule_update", map[string]any{"id": "sched-self", "changes": map[string]any{"paused": true}})
		part, mark, cmark := run(s, "trigger-sched-self-pause", "schedule_update")
		if part.ToolStatus != backend.ToolCompleted || !strings.Contains(part.Output, `"autoApproved":true`) {
			t.Fatalf("schedule_update = %s / %q / %q", part.ToolStatus, part.Output, part.ToolError)
		}
		if n := len(hub.asks(mark, s.ID)); n != 0 {
			t.Fatalf("self pause raised %d cards", n)
		}
		if ops := cerea.opsFrom(cmark, s.ID); strings.Join(ops, ",") != "schedule.list,schedule.update" {
			t.Fatalf("ops = %v", ops)
		}
		if args := cerea.last("schedule.update")["args"].(map[string]any); args["id"] != "sched-self" || args["paused"] != true || len(args) != 2 {
			t.Fatalf("update args = %v", args)
		}
	})

	t.Run("changing a schedule that is not its own under the session's Deny is refused", func(t *testing.T) {
		hub.setApprove(approveAll)
		s := newSession("it-sched-deny-other", permrules.Deny)
		route("trigger-sched-deny-other", "schedule_update", map[string]any{"id": "sched-other", "changes": map[string]any{"paused": true}})
		part, mark, cmark := run(s, "trigger-sched-deny-other", "schedule_update")
		if part.ToolStatus != backend.ToolFailed || !strings.Contains(part.ToolError, "Deny") {
			t.Fatalf("schedule_update = %s / %q / %q", part.ToolStatus, part.Output, part.ToolError)
		}
		if n := len(hub.asks(mark, s.ID)); n != 0 {
			t.Fatalf("a refused update raised %d cards", n)
		}
		if ops := cerea.opsFrom(cmark, s.ID); strings.Join(ops, ",") != "schedule.list" {
			t.Fatalf("ops = %v", ops)
		}
	})

	t.Run("deleting a schedule that is not its own asks, even under Allow", func(t *testing.T) {
		hub.setApprove(approveAll)
		s := newSession("it-sched-del-other", permrules.Allow)
		route("trigger-sched-del-other", "schedule_delete", map[string]any{"id": "sched-other"})
		part, mark, cmark := run(s, "trigger-sched-del-other", "schedule_delete")
		if part.ToolStatus != backend.ToolCompleted {
			t.Fatalf("schedule_delete = %s / %q / %q", part.ToolStatus, part.Output, part.ToolError)
		}
		asks := hub.asks(mark, s.ID)
		if len(asks) != 1 || asks[0].Tool != "schedule_delete" {
			t.Fatalf("asks = %+v", asks)
		}
		if card, _ := asks[0].Metadata["schedule"].(map[string]any); card["name"] != "someone else's" {
			t.Fatalf("card = %v", asks[0].Metadata)
		}
		if ops := cerea.opsFrom(cmark, s.ID); strings.Join(ops, ",") != "schedule.list,schedule.delete" {
			t.Fatalf("ops = %v", ops)
		}
	})

	t.Run("a ceiling of deny refuses, Allow or not", func(t *testing.T) {
		hub.setApprove(approveAll)
		setCeiling(permrules.Deny)
		defer setCeiling(permrules.Allow)
		s := newSession("it-sched-ceiling", permrules.Allow)
		route("trigger-sched-ceiling", "schedule_create", createArgs("capped"))
		part, mark, cmark := run(s, "trigger-sched-ceiling", "schedule_create")
		if part.ToolStatus != backend.ToolFailed || !strings.Contains(part.ToolError, "ceiling") {
			t.Fatalf("schedule_create = %s / %q / %q", part.ToolStatus, part.Output, part.ToolError)
		}
		if n := len(hub.asks(mark, s.ID)); n != 0 {
			t.Fatalf("a ceiling deny raised %d cards", n)
		}
		if ops := cerea.opsFrom(cmark, s.ID); len(ops) != 0 {
			t.Fatalf("a refused call reached Cerea: %v", ops)
		}
	})

	t.Run("the audit rows name the schedule, never the prompt", func(t *testing.T) {
		raw, err := os.ReadFile(filepath.Join(dirs["state"], "audit.log"))
		if err != nil {
			matches, _ := filepath.Glob(filepath.Join(dirs["state"], "audit*"))
			if len(matches) == 0 {
				t.Fatalf("no audit log: %v", err)
			}
			raw, _ = os.ReadFile(matches[0])
		}
		log := string(raw)
		if strings.Contains(log, "check the nightly build") {
			t.Fatal("the audit log carries a schedule's prompt text")
		}
		for _, want := range []string{`"schedule":"nightly build check"`, `"schedule":"sched-self"`, `"tool":"schedule_delete"`} {
			if !strings.Contains(log, want) {
				t.Errorf("audit log lacks %s", want)
			}
		}
	})
}
