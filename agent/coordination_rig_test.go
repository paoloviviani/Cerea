package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/link"
	"galopin/internal/permrules"
	"galopin/internal/policy"
	"galopin/internal/sessions"
	"galopin/internal/workspaces"
)

// coordBackend is a backend for the coordination tools: sessions and
// transcripts held in memory, the agent tools' host side (asks are recorded and
// answered by a function), and a rule host that composes with the REAL
// permrules, so what a grant, the ceiling and the machine's rules do together is
// the production composition and not a canned answer.
type coordBackend struct {
	mu          sync.Mutex
	sessions    map[string]backend.Session
	dirs        map[string]string
	transcripts map[string][]backend.TranscriptEntry
	sel         map[string]permrules.Selector
	prompts     []coordPrompt
	asks        []backend.PermissionRequest
	answer      func(backend.PermissionRequest) (backend.Decision, string)
	layers      func() permrules.Layers
	handler     backend.ToolHandler
}

type coordPrompt struct {
	dir, session string
	prompt       backend.Prompt
}

var agentRules = []permrules.Rule{{Permission: "*", Pattern: "*", Action: permrules.Allow}}

func (c *coordBackend) ID() string      { return "coord" }
func (c *coordBackend) Version() string { return "0.0.0" }
func (c *coordBackend) Capabilities() backend.Capabilities {
	return backend.Capabilities{AgentTools: true, Permissions: true, CoordinationGrant: true, Steer: true}
}
func (c *coordBackend) ListSessions(_ context.Context, dir string) ([]backend.Session, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []backend.Session
	for id, s := range c.sessions {
		if c.dirs[id] == dir {
			out = append(out, s)
		}
	}
	return out, nil
}
func (c *coordBackend) GetSession(_ context.Context, _, id string) (backend.Session, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s, ok := c.sessions[id]
	if !ok {
		return backend.Session{}, errors.New("no such session")
	}
	return s, nil
}
func (c *coordBackend) Prompt(_ context.Context, dir, id string, p backend.Prompt) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.prompts = append(c.prompts, coordPrompt{dir, id, p})
	return nil
}
func (c *coordBackend) Transcript(_ context.Context, _, id string) (backend.Transcript, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return backend.Transcript{Messages: c.transcripts[id]}, nil
}
func (c *coordBackend) CreateSession(_ context.Context, dir string, o backend.CreateSessionOptions) (backend.Session, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	id := fmt.Sprintf("spawned_%d", len(c.sessions))
	s := backend.Session{ID: id, Title: o.Title, Status: backend.StatusIdle, SpawnedBy: o.SpawnedBy, CreatedAt: time.Now()}
	c.sessions[id], c.dirs[id] = s, dir
	return s, nil
}
func (c *coordBackend) RenameSession(context.Context, string, string, string) (backend.Session, error) {
	panic("not used")
}
func (c *coordBackend) DeleteSession(context.Context, string, string) error { panic("not used") }
func (c *coordBackend) Cancel(context.Context, string, string) error        { panic("not used") }
func (c *coordBackend) SetMode(context.Context, string, string, string) (backend.Session, error) {
	panic("not used")
}
func (c *coordBackend) SetModel(context.Context, string, string, string) (backend.Session, error) {
	panic("not used")
}
func (c *coordBackend) ReplyPermission(context.Context, string, string, string, backend.Decision, string) error {
	panic("not used")
}
func (c *coordBackend) Modes(context.Context, string) ([]backend.Mode, error)   { return nil, nil }
func (c *coordBackend) Models(context.Context, string) ([]backend.Model, error) { return nil, nil }
func (c *coordBackend) Subscribe(context.Context) (<-chan backend.BackendEvent, error) {
	panic("not used")
}

func (c *coordBackend) SetToolHandler(h backend.ToolHandler) { c.handler = h }
func (c *coordBackend) SpawnMarks() map[string]backend.SpawnedBy {
	return map[string]backend.SpawnedBy{}
}
func (c *coordBackend) Ask(_ context.Context, _, _ string, req backend.PermissionRequest) (backend.Decision, string, error) {
	c.mu.Lock()
	c.asks = append(c.asks, req)
	answer := c.answer
	c.mu.Unlock()
	if answer == nil {
		return backend.DecisionOnce, "", nil
	}
	d, msg := answer(req)
	return d, msg, nil
}

func (c *coordBackend) rootOf(id string) string {
	for i := 0; i < 8; i++ {
		p := c.sessions[id].ParentID
		if p == "" {
			return id
		}
		id = p
	}
	return id
}

func (c *coordBackend) EffectiveRules(ctx context.Context, dir, id string) ([]permrules.Rule, error) {
	l, err := c.RuleLayers(ctx, dir, id)
	return l.Plain(), err
}
func (c *coordBackend) RuleLayers(_ context.Context, _, id string) (backend.RuleLayers, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	root := c.rootOf(id)
	sel := c.sel[root]
	l := c.layers()
	own := l
	nOwn := len(l.Own)
	if root != id {
		own, nOwn = permrules.Layers{Ceiling: l.ChildCeiling()}, 0
	}
	cerea, tail := permrules.ComposeParts(own, sel, agentRules)
	out := backend.RuleLayers{Agent: "build", Mode: string(sel.Effective())}
	for _, r := range agentRules {
		out.Rules = append(out.Rules, backend.SourcedRule{Rule: r, Source: backend.SourceDefault})
	}
	for i, r := range cerea {
		src := backend.SourceCerea
		if i < nOwn {
			src = backend.SourceMachine
		}
		out.Rules = append(out.Rules, backend.SourcedRule{Rule: r, Source: src})
	}
	for _, r := range tail {
		out.Rules = append(out.Rules, backend.SourcedRule{Rule: r, Source: backend.SourceCeiling})
	}
	return out, nil
}
func (c *coordBackend) PermissionMode(id string) permrules.Action {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sel[c.rootOf(id)].Effective()
}
func (c *coordBackend) SetPermissionMode(_ context.Context, _, id string, mode permrules.Action) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	sel := c.sel[id]
	sel.Mode = mode
	c.sel[id] = sel
	return nil
}
func (c *coordBackend) Exceptions(id string) []permrules.Exception {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sel[id].Exceptions
}
func (c *coordBackend) AddException(context.Context, string, string, permrules.Exception) (permrules.Exception, error) {
	panic("not used")
}
func (c *coordBackend) RemoveException(context.Context, string, string, string) (bool, error) {
	panic("not used")
}
func (c *coordBackend) Coordination(id string) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.sel[c.rootOf(id)].Coordination...)
}
func (c *coordBackend) SetCoordination(_ context.Context, _, id string, keys []string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	sel := c.sel[id]
	sel.Coordination = append([]string(nil), keys...)
	c.sel[id] = sel
	return nil
}
func (c *coordBackend) EnsureRules(context.Context, string, string) error             { return nil }
func (c *coordBackend) ApplyChildRules(context.Context, string, string, string) error { return nil }
func (c *coordBackend) ChildAskAction(context.Context, string, string, string, string, []string) permrules.Action {
	return permrules.Ask
}
func (c *coordBackend) OnProcessStart(func())                  {}
func (c *coordBackend) RestartForPolicy(context.Context) error { return nil }

var (
	_ backend.Backend  = (*coordBackend)(nil)
	_ backend.ToolHost = (*coordBackend)(nil)
	_ backend.RuleHost = (*coordBackend)(nil)
)

// coordRig is a machine with two workspaces: w1 holds sessions "caller" and
// "peer", w2 holds "other". Add more with addSession.
type coordRig struct {
	t        *testing.T
	mc       *machine
	cb       *coordBackend
	stateDir string
	w1, w2   workspaces.Workspace
	calls    int
}

func newCoordRig(t *testing.T, mutate func(*policy.Policy)) *coordRig {
	t.Helper()
	stateDir := t.TempDir()
	reg, err := workspaces.Load(filepath.Join(stateDir, "workspaces.json"))
	if err != nil {
		t.Fatal(err)
	}
	w1, err := reg.Create("one", t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	w2, err := reg.Create("two", t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	pol := policy.Default()
	if mutate != nil {
		mutate(&pol)
	}
	cb := &coordBackend{
		sessions: map[string]backend.Session{}, dirs: map[string]string{},
		transcripts: map[string][]backend.TranscriptEntry{}, sel: map[string]permrules.Selector{},
	}
	mat := sessions.New(cb, pol)
	mc := newMachine(reg, cb, mat, pol)
	cb.layers = mc.live.Layers
	audit, err := newAuditLogger(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = audit.Close() })
	mc.AttachAudit(audit)
	if mc.agentTools == nil {
		t.Fatal("the agent tools were not installed on the rig")
	}
	r := &coordRig{t: t, mc: mc, cb: cb, stateDir: stateDir, w1: w1, w2: w2}
	r.addSession(w1, "caller", "Caller", "")
	r.addSession(w1, "peer", "Peer", "")
	r.addSession(w2, "other", "Other", "")
	return r
}

func (r *coordRig) addSession(w workspaces.Workspace, id, title, parent string) {
	r.t.Helper()
	s := backend.Session{ID: id, Title: title, ParentID: parent, Status: backend.StatusIdle, CreatedAt: time.Now()}
	r.cb.mu.Lock()
	r.cb.sessions[id] = s
	r.cb.dirs[id] = w.Path
	r.cb.mu.Unlock()
	r.mc.trackSession(w, s)
}

func (r *coordRig) say(id, role, text string, at time.Time) {
	r.t.Helper()
	r.cb.mu.Lock()
	n := len(r.cb.transcripts[id])
	msgID := fmt.Sprintf("%s_m%d", id, n)
	r.cb.transcripts[id] = append(r.cb.transcripts[id], backend.TranscriptEntry{
		Message: backend.Message{ID: msgID, Role: role, CreatedAt: at},
		Parts:   []backend.Part{{ID: msgID + "_p", MessageID: msgID, Role: role, Type: backend.PartText, Text: text}},
	})
	r.cb.mu.Unlock()
}

// call plays one tool call of session `from`: the tool part the backend's event
// stream would show (what verifyCaller demands), then the handler.
func (r *coordRig) call(from, tool string, args map[string]any) (string, error) {
	r.t.Helper()
	r.calls++
	callID := fmt.Sprintf("call_%d", r.calls)
	dir, _, operr := r.mc.resolveSession(from)
	if operr != nil {
		r.t.Fatal(operr)
	}
	r.mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{WorkspaceDir: dir, SessionID: from, Event: backend.Event{
		Kind: backend.EventPart, Part: &backend.Part{
			ID: "prt_" + callID, MessageID: "msg_" + callID, Role: "assistant", Type: backend.PartTool,
			Tool: tool, CallID: callID, ToolStatus: backend.ToolRunning,
		},
	}})
	raw, _ := json.Marshal(args)
	return r.cb.handler(context.Background(), backend.ToolCall{Tool: tool, SessionID: from, CallID: callID, MessageID: "msg_" + callID, Args: raw})
}

func (r *coordRig) asks() []backend.PermissionRequest {
	r.cb.mu.Lock()
	defer r.cb.mu.Unlock()
	return append([]backend.PermissionRequest(nil), r.cb.asks...)
}

func (r *coordRig) prompts() []coordPrompt {
	r.cb.mu.Lock()
	defer r.cb.mu.Unlock()
	return append([]coordPrompt(nil), r.cb.prompts...)
}

// grant plays session.grantCoordination.
func (r *coordRig) grant(id string, keys any) (any, *link.OpError) {
	raw, _ := json.Marshal(map[string]any{"sessionId": id, "keys": keys})
	return r.mc.opSessionGrantCoordination(context.Background(), raw)
}

func (r *coordRig) audit() []map[string]any { return auditRows(r.t, r.stateDir) }

func withRule(key, action string) func(*policy.Policy) {
	return func(p *policy.Policy) {
		if p.Permission.Rules == nil {
			p.Permission.Rules = map[string]string{}
		}
		p.Permission.Rules[key] = action
	}
}

func withMax(key, action string) func(*policy.Policy) {
	return func(p *policy.Policy) {
		if p.Permission.Max == nil {
			p.Permission.Max = map[string]string{}
		}
		p.Permission.Max[key] = action
	}
}
