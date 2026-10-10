package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"galopin/internal/backend"
	backendopencode "galopin/internal/backend/opencode"
	"galopin/internal/permrules"
	"galopin/internal/policy"
	"galopin/internal/sessions"
	"galopin/internal/workspaces"
)

// The permission pass-through's live specs run a real, pinned opencode against
// the mock LLM (internal/mockllm). Everything asserted here is a behaviour of
// the binary or of galopin driving it — what a write tool does under a given
// stack of rules — never a unit's say-so. Gated behind GALOPIN_OPENCODE_IT=1.

// permRig is one opencode + materializer + machine under a chosen policy.
type permRig struct {
	t         *testing.T
	ctx       context.Context
	mock      string
	root      string
	stateDir  string
	work      string
	port      int
	password  string
	oc        *backendopencode.Backend
	mat       *sessions.Materializer
	mc        *machine
	hub       *itHub
	ws        workspaces.Workspace
	live      *policy.Live
	policyArg string
	seq       int
	// bypass makes the rig prompt opencode directly, skipping galopin's own
	// composing of rules before a prompt (Backend.Prompt applies them to every
	// session, raw ones included): the upgrade canaries are about opencode alone
	// and must see only the rules they set. agents are the agent a bypassed
	// session runs (the backend's overlay is what carries it otherwise).
	bypass bool
	agents map[string]string
}

type permRigOpts struct {
	// file is the "permission" block of the static opencode.json (what a new
	// enroll writes).
	file map[string]any
	// perm is policy.json's permission block.
	perm policy.Permission
	// tools installs galopin's coordination tools.
	tools bool
	// agentTools with a second workspace.
	secondWorkspace bool
	// background lets the task tool start background subagents.
	background bool
}

func newPermRig(t *testing.T, o permRigOpts) *permRig {
	t.Helper()
	if !itEnabled("GALOPIN_OPENCODE_IT", "PYSTINO_AGENT_OPENCODE_IT") {
		t.Skip("set GALOPIN_OPENCODE_IT=1 to run (spawns real opencode + a mock LLM)")
	}
	if _, err := exec.LookPath("opencode"); err != nil {
		t.Skipf("opencode not on PATH: %v", err)
	}
	r := &permRig{t: t, mock: startMockLLM(t, itFreePort(t)), root: rigRoot(t)}
	dirs := map[string]string{}
	for _, n := range []string{"home", "config", "data", "cache", "work", "work2", "state"} {
		dirs[n] = filepath.Join(r.root, n)
		if err := os.MkdirAll(dirs[n], 0o755); err != nil {
			t.Fatal(err)
		}
	}
	r.work, r.stateDir = dirs["work"], dirs["state"]
	cfg := map[string]any{
		"$schema": "https://opencode.ai/config.json",
		"provider": map[string]any{"pystino": map[string]any{
			"npm": "@ai-sdk/openai-compatible", "name": "Pystino Mock",
			"options": map[string]any{"baseURL": r.mock + "/v1", "apiKey": "test-secret"},
			"models":  map[string]any{"mock-model": map[string]any{"name": "Mock Model", "limit": map[string]any{"context": 100000, "output": 8000}}},
		}},
		"enabled_providers": []string{"pystino"},
	}
	if o.file != nil {
		cfg["permission"] = o.file
	}
	body, _ := json.MarshalIndent(cfg, "", "  ")
	configPath := filepath.Join(r.root, "opencode.json")
	if err := os.WriteFile(configPath, body, 0o644); err != nil {
		t.Fatal(err)
	}
	env := []string{
		"HOME=" + dirs["home"], "XDG_CONFIG_HOME=" + dirs["config"], "XDG_DATA_HOME=" + dirs["data"],
		"XDG_CACHE_HOME=" + dirs["cache"], "TMPDIR=" + itTmpDir(t), "PATH=" + os.Getenv("PATH"),
	}
	pol := policy.Default()
	pol.Permission = o.perm
	r.policyArg = filepath.Join(r.stateDir, policyFileName)
	if err := policy.Save(r.policyArg, pol); err != nil {
		t.Fatal(err)
	}
	r.live = policy.NewLive(pol.Permission)
	r.port, r.password = itFreePort(t), "it-password"
	cfgOC := backendopencode.Config{
		ConfigPath: configPath, Env: env, StateDir: r.stateDir, Port: r.port, Password: r.password,
		OverlayPath: filepath.Join(r.stateDir, "opencode-overlay.json"), TmpDir: filepath.Join(itTmpDir(t), "oc-tmp"),
		Permissions: r.live.Layers, BackgroundSubagents: o.background, StartupTimeout: 90 * time.Second, Logf: t.Logf,
	}
	if o.tools {
		cfgOC.ToolsDir = filepath.Join(r.stateDir, "opencode-tools")
	}
	r.oc = backendopencode.New(cfgOC)
	var cancel context.CancelFunc
	r.ctx, cancel = context.WithTimeout(context.Background(), 8*time.Minute)
	t.Cleanup(cancel)
	if err := r.oc.Start(r.ctx); err != nil {
		t.Fatalf("starting opencode: %v", err)
	}
	t.Cleanup(func() { _ = r.oc.Stop() })
	r.mat = sessions.New(r.oc, pol)
	r.mat.UseLive(r.live)
	if err := r.mat.Start(r.ctx); err != nil {
		t.Fatal(err)
	}
	reg, err := workspaces.Load(filepath.Join(r.stateDir, "workspaces.json"))
	if err != nil {
		t.Fatal(err)
	}
	if r.ws, err = reg.Create("ws", r.work, nil); err != nil {
		t.Fatal(err)
	}
	if o.secondWorkspace {
		if _, err = reg.Create("ws2", dirs["work2"], nil); err != nil {
			t.Fatal(err)
		}
	}
	r.mc = newMachine(reg, r.oc, r.mat, pol)
	audit, err := newAuditLogger(r.stateDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = audit.Close() })
	r.mc.AttachAudit(audit)
	r.hub = &itHub{t: t, mc: r.mc}
	go r.hub.run(r.mat)
	return r
}

// session creates a tracked session in the first workspace.
func (r *permRig) session(title, mode string) backend.Session {
	r.t.Helper()
	s, err := r.oc.CreateSession(r.ctx, r.work, backend.CreateSessionOptions{Title: title, ModeID: mode})
	if err != nil {
		r.t.Fatalf("create session: %v", err)
	}
	r.mc.trackSession(r.ws, s)
	return s
}

// writeCall scripts the model to make one write tool call, then answer.
func (r *permRig) script(extra map[string]any) {
	r.t.Helper()
	sc := map[string]any{"content": []string{"done"}, "chunkDelayMs": 5, "finishReason": "stop"}
	for k, v := range extra {
		sc[k] = v
	}
	setMockScenario(r.t, r.mock, sc)
}

func (r *permRig) next() int { r.seq++; return r.seq }

// writeTool is the call that writes name in the workspace.
func (r *permRig) writeTool(name string) map[string]any {
	return map[string]any{
		"id": fmt.Sprintf("call_w%d", r.next()), "name": "write",
		"arguments": mustJSON2(map[string]any{"filePath": filepath.Join(r.work, name), "content": "x"}),
	}
}

// try prompts the session to write name and waits for the outcome: an ask
// (pending, returned), or the tool finishing (part returned). Exactly one is non-nil.
func (r *permRig) try(s backend.Session, name string) (*backend.PermissionRequest, *backend.Part, int) {
	r.t.Helper()
	return r.tryCall(s, "write", map[string]any{"filePath": filepath.Join(r.work, name), "content": "x"})
}

// tryCall is try for any one tool call: it scripts the model to make the call
// and waits for an ask or for the tool to finish (or to land on opencode's
// "invalid" tool, which is where a tool a deny withdrew ends up).
func (r *permRig) tryCall(s backend.Session, tool string, args map[string]any) (*backend.PermissionRequest, *backend.Part, int) {
	r.t.Helper()
	r.script(map[string]any{"toolCalls": []map[string]any{{
		"id": fmt.Sprintf("call_t%d", r.next()), "name": tool, "arguments": mustJSON2(args),
	}}})
	mark := r.hub.mark()
	if err := r.promptSession(s, "use "+tool); err != nil {
		r.t.Fatalf("prompt: %v", err)
	}
	env := r.hub.wait(r.t, mark, 60*time.Second, "an ask or the "+tool+" call to finish", func(e sessions.Envelope) bool {
		if e.SessionID != s.ID {
			return false
		}
		if e.Event.Kind == backend.EventPermissionAsked {
			return true
		}
		p := e.Event.Part
		return e.Event.Kind == backend.EventPart && p != nil && (p.Tool == tool || p.Tool == "invalid") &&
			(p.ToolStatus == backend.ToolCompleted || p.ToolStatus == backend.ToolFailed)
	})
	if env.Event.Kind == backend.EventPermissionAsked {
		return env.Event.Request, nil, mark
	}
	return nil, env.Event.Part, mark
}

// promptSession sends a prompt the way the machine does, or straight to opencode
// when the rig bypasses galopin (see bypass).
func (r *permRig) promptSession(s backend.Session, text string) error {
	if !r.bypass {
		return r.oc.Prompt(r.ctx, r.work, s.ID, backend.Prompt{Text: text})
	}
	body := map[string]any{"parts": []map[string]any{{"type": "text", "text": text}}}
	if a := r.agents[s.ID]; a != "" {
		body["agent"] = a
	}
	r.raw(http.MethodPost, "/session/"+s.ID+"/prompt_async?directory="+r.work, body)
	return nil
}

// reply answers through the real permission.reply op (so the ceiling's cap on
// "always" is in the path).
func (r *permRig) reply(s backend.Session, id, decision string) {
	r.t.Helper()
	raw, _ := json.Marshal(map[string]any{"sessionId": s.ID, "requestId": id, "decision": decision})
	if _, operr := r.mc.Handle(r.ctx, "permission.reply", raw); operr != nil {
		r.t.Fatalf("permission.reply %s: %+v", decision, operr)
	}
}

// refused reports whether a write part is the outcome of a deny. opencode
// handles a tool whose permission is denied outright in one of two ways, and
// both are a refusal: the tool is withdrawn from the model (the call lands on
// the "invalid" tool, which completes with an "unavailable" message), or the
// call runs and fails with the rule that refused it.
func refused(p *backend.Part) bool {
	return p.ToolStatus == backend.ToolFailed || p.Tool == "invalid"
}

func (r *permRig) exists(name string) bool {
	_, err := os.Stat(filepath.Join(r.work, name))
	return err == nil
}

func (r *permRig) idle(s backend.Session, mark int) {
	r.t.Helper()
	r.hub.wait(r.t, mark, 60*time.Second, s.ID+" to go idle", func(e sessions.Envelope) bool {
		return e.SessionID == s.ID && e.Event.Kind == backend.EventStatus && e.Event.Status == backend.StatusIdle
	})
}

// rulesView is permission.rules as the panel reads it.
type rulesView struct {
	Agent string `json:"agent"`
	Mode  string `json:"mode"`
	Rules []struct {
		Permission string `json:"permission"`
		Pattern    string `json:"pattern"`
		Action     string `json:"action"`
		Source     string `json:"source"`
	} `json:"rules"`
	SavedApprovals []backend.SavedApproval `json:"savedApprovals"`
	Ceiling        map[string]string       `json:"ceiling"`
}

// reread is what the panel does after a change: ask the machine what is true.
func (r *permRig) reread(s backend.Session) rulesView {
	r.t.Helper()
	raw, _ := json.Marshal(map[string]any{"sessionId": s.ID})
	res, operr := r.mc.Handle(r.ctx, "permission.rules", raw)
	if operr != nil {
		r.t.Fatalf("permission.rules: %+v", operr)
	}
	body, _ := json.Marshal(res)
	var v rulesView
	if err := json.Unmarshal(body, &v); err != nil {
		r.t.Fatal(err)
	}
	return v
}

// exceptions is the session's root's exceptions as the panel lists them.
func (r *permRig) exceptions(s backend.Session) []backend.SavedApproval {
	return r.reread(s).SavedApprovals
}

// setMode goes through the real session.setPermissionMode op.
func (r *permRig) setMode(s backend.Session, mode string) {
	r.t.Helper()
	raw, _ := json.Marshal(map[string]any{"sessionId": s.ID, "mode": mode})
	if res, operr := r.mc.Handle(r.ctx, "session.setPermissionMode", raw); operr != nil {
		r.t.Fatalf("session.setPermissionMode %s: %+v", mode, operr)
	} else if m, ok := res.(map[string]any); !ok || len(m) != 0 {
		r.t.Fatalf("session.setPermissionMode answered %v, want {}", res)
	}
}

// removeException goes through the real permission.saved.remove op.
func (r *permRig) removeException(s backend.Session, id string) {
	r.t.Helper()
	raw, _ := json.Marshal(map[string]any{"sessionId": s.ID, "id": id})
	if _, operr := r.mc.Handle(r.ctx, "permission.saved.remove", raw); operr != nil {
		r.t.Fatalf("permission.saved.remove: %+v", operr)
	}
}

// raw talks to opencode directly (for the canaries, which must set rules
// galopin would never compose).
func (r *permRig) raw(method, path string, body any) []byte {
	r.t.Helper()
	var rd io.Reader
	if body != nil {
		buf, _ := json.Marshal(body)
		rd = bytes.NewReader(buf)
	}
	req, _ := http.NewRequestWithContext(r.ctx, method, fmt.Sprintf("http://127.0.0.1:%d%s", r.port, path), rd)
	req.Header.Set("Content-Type", "application/json")
	req.SetBasicAuth("opencode", r.password)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		r.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		r.t.Fatalf("%s %s: %d %s", method, path, resp.StatusCode, out)
	}
	return out
}

// rawSession creates a session carrying exactly rules (nothing of galopin's),
// tracked so the hub sees its events.
func (r *permRig) rawSession(rules []permrules.Rule) backend.Session {
	r.t.Helper()
	body := map[string]any{"title": "raw"}
	if rules != nil {
		body["permission"] = rules
	}
	out := r.raw(http.MethodPost, "/session?directory="+r.work, body)
	var m struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(out, &m)
	s := backend.Session{ID: m.ID, Title: "raw"}
	r.mc.trackSession(r.ws, s)
	return s
}

func (r *permRig) agentRules(agent string) []permrules.Rule {
	r.t.Helper()
	var all []struct {
		Name       string           `json:"name"`
		Permission []permrules.Rule `json:"permission"`
	}
	if err := json.Unmarshal(r.raw(http.MethodGet, "/agent?directory="+r.work, nil), &all); err != nil {
		r.t.Fatal(err)
	}
	for _, a := range all {
		if a.Name == agent {
			return a.Permission
		}
	}
	r.t.Fatalf("no agent %q", agent)
	return nil
}

func (r *permRig) auditRows() []map[string]any { return auditRows(r.t, r.stateDir) }

// rigRoot is the rig's own scratch root: OUTSIDE every default safe
// directory, so the specs that write "outside the workspace" still meet the
// external_directory ask. t.TempDir() lands under /tmp from a plain shell,
// and /tmp is a safe directory now. ~/.cache/galopin-it is not one (only
// named build caches under ~/.cache are).
func rigRoot(t *testing.T) string {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("no home directory for a scratch root outside the safe directories")
	}
	base := filepath.Join(home, ".cache", "galopin-it")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(base, "rig-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// safeTmp is a directory under /tmp — the one safe entry every machine's
// default list has — for the safe-directory specs to write into. Made under
// /tmp whatever the test process's TMPDIR says: on this box that can point
// into a running galopin's own state, which the default list never names.
func (r *permRig) safeTmp() string {
	r.t.Helper()
	dir, err := os.MkdirTemp("/tmp", "galopin-s13-")
	if err != nil {
		r.t.Fatal(err)
	}
	r.t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// onlyOneAsk reports the asks the hub has logged for a session since mark.
func (r *permRig) asks(mark int, s backend.Session) []backend.PermissionRequest {
	return r.hub.asks(mark, s.ID)
}

// taskScript makes the parent delegate one write to a general subagent, whose
// own prompt (recognised by its marker) makes the write call.
func (r *permRig) taskScript(marker, file string) {
	r.t.Helper()
	r.taskScriptCall(marker, r.writeTool(file))
}

// taskScriptCall is taskScript for any one tool call by the child.
func (r *permRig) taskScriptCall(marker string, call map[string]any) {
	r.t.Helper()
	r.script(map[string]any{
		"toolCalls": []map[string]any{{
			"id": fmt.Sprintf("call_task%d", r.next()), "name": "task",
			"arguments": mustJSON2(map[string]any{"description": "write a file", "prompt": marker, "subagent_type": "general"}),
		}},
		"routes": []map[string]any{{
			"contains": marker,
			"scenario": map[string]any{
				"toolCalls":    []map[string]any{call},
				"content":      []string{"child done"},
				"chunkDelayMs": 5, "finishReason": "stop",
			},
		}},
	})
}

// delegate prompts the parent to run the scripted task and returns the child's
// session id once it exists.
func (r *permRig) delegate(parent backend.Session, marker, file string) (child string, mark int) {
	r.t.Helper()
	return r.delegateCall(parent, marker, r.writeTool(file))
}

// delegateCall is delegate for any one tool call by the child.
func (r *permRig) delegateCall(parent backend.Session, marker string, call map[string]any) (child string, mark int) {
	r.t.Helper()
	r.taskScriptCall(marker, call)
	return r.startDelegation(parent)
}

// startDelegation prompts the parent to run the scripted task and waits for the
// child's session.
func (r *permRig) startDelegation(parent backend.Session) (child string, mark int) {
	r.t.Helper()
	// The task call is itself a tool the blanket moves: under Ask it asks. The
	// tests are about the child's write, so the delegation is allowed once.
	r.hub.setApprove(func(req *backend.PermissionRequest) string {
		if req.Tool == "task" {
			return "once"
		}
		return ""
	})
	mark = r.hub.mark()
	if err := r.promptSession(parent, "delegate"); err != nil {
		r.t.Fatalf("prompt: %v", err)
	}
	env := r.hub.wait(r.t, mark, 60*time.Second, "the subagent session", func(e sessions.Envelope) bool {
		return e.SessionID != parent.ID && e.RootSessionID == parent.ID
	})
	return env.SessionID, mark
}

// childOutcome waits for what the subagent's write comes to: an ask, or the
// tool finishing.
func (r *permRig) childOutcome(child string, mark int) (*backend.PermissionRequest, *backend.Part) {
	r.t.Helper()
	return r.childOutcomeOf("write", child, mark)
}

// childOutcomeOf is childOutcome for the named tool.
func (r *permRig) childOutcomeOf(tool, child string, mark int) (*backend.PermissionRequest, *backend.Part) {
	r.t.Helper()
	env := r.hub.wait(r.t, mark, 60*time.Second, "the subagent's ask or write", func(e sessions.Envelope) bool {
		if e.SessionID != child {
			return false
		}
		if e.Event.Kind == backend.EventPermissionAsked {
			return true
		}
		p := e.Event.Part
		return e.Event.Kind == backend.EventPart && p != nil && (p.Tool == tool || p.Tool == "invalid") &&
			(p.ToolStatus == backend.ToolCompleted || p.ToolStatus == backend.ToolFailed)
	})
	if env.Event.Kind == backend.EventPermissionAsked {
		return env.Event.Request, nil
	}
	return nil, env.Event.Part
}

// sessionRules reads a session's own permission field straight from opencode.
func (r *permRig) sessionRules(id string) []permrules.Rule {
	r.t.Helper()
	var s struct {
		Permission []permrules.Rule `json:"permission"`
	}
	if err := json.Unmarshal(r.raw(http.MethodGet, "/session/"+id, nil), &s); err != nil {
		r.t.Fatal(err)
	}
	return s.Permission
}
