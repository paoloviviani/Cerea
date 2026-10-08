package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
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

// ruleBackend is a Backend with a permission surface: replies are recorded,
// rules canned, a selector (mode and exceptions) held per root session, and
// every call RestartForPolicy, EnsureRules and ApplyChildRules receives is kept.
type ruleBackend struct {
	*fakeBackend
	mu       sync.Mutex
	replies  []backend.Decision
	onStart  func()
	restarts int
	ensured  []string
	children map[string]string
	layers   backend.RuleLayers
	restart  error
	sel      map[string]permrules.Selector
	setErr   error
}

func (r *ruleBackend) Capabilities() backend.Capabilities {
	return backend.Capabilities{Permissions: true}
}
func (r *ruleBackend) ReplyPermission(_ context.Context, _, _, _ string, d backend.Decision, _ string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.replies = append(r.replies, d)
	return nil
}
func (r *ruleBackend) EffectiveRules(context.Context, string, string) ([]permrules.Rule, error) {
	return r.layers.Plain(), nil
}
func (r *ruleBackend) PermissionMode(sessionID string) permrules.Action {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sel[sessionID].Effective()
}
func (r *ruleBackend) SetPermissionMode(_ context.Context, _, sessionID string, mode permrules.Action) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.setErr != nil {
		return r.setErr
	}
	if r.sel == nil {
		r.sel = map[string]permrules.Selector{}
	}
	sel := r.sel[sessionID]
	sel.Mode = mode
	r.sel[sessionID] = sel
	return nil
}
func (r *ruleBackend) Exceptions(sessionID string) []permrules.Exception {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]permrules.Exception(nil), r.sel[sessionID].Exceptions...)
}
func (r *ruleBackend) AddException(_ context.Context, _, sessionID string, e permrules.Exception) (permrules.Exception, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.setErr != nil {
		return permrules.Exception{}, r.setErr
	}
	if r.sel == nil {
		r.sel = map[string]permrules.Selector{}
	}
	next, kept := r.sel[sessionID].With(e)
	r.sel[sessionID] = next
	return kept, nil
}
func (r *ruleBackend) RemoveException(_ context.Context, _, sessionID, id string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	next, ok := r.sel[sessionID].Without(id)
	if ok && r.setErr != nil {
		return true, r.setErr
	}
	if r.sel == nil {
		r.sel = map[string]permrules.Selector{}
	}
	r.sel[sessionID] = next
	return ok, nil
}
func (r *ruleBackend) Coordination(sessionID string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.sel[sessionID].Coordination...)
}
func (r *ruleBackend) SetCoordination(_ context.Context, _, sessionID string, keys []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.setErr != nil {
		return r.setErr
	}
	if r.sel == nil {
		r.sel = map[string]permrules.Selector{}
	}
	sel := r.sel[sessionID]
	sel.Coordination = append([]string(nil), keys...)
	r.sel[sessionID] = sel
	return nil
}
func (r *ruleBackend) RuleLayers(context.Context, string, string) (backend.RuleLayers, error) {
	return r.layers, nil
}

// OnProcessStart records the callback; start() plays a process start.
func (r *ruleBackend) ChildAskAction(context.Context, string, string, string, string, []string) permrules.Action {
	return permrules.Ask
}
func (r *ruleBackend) OnProcessStart(fn func()) { r.onStart = fn }
func (r *ruleBackend) start() {
	if r.onStart != nil {
		r.onStart()
	}
}
func (r *ruleBackend) EnsureRules(_ context.Context, _, sessionID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ensured = append(r.ensured, sessionID)
	return nil
}
func (r *ruleBackend) ApplyChildRules(_ context.Context, _, sessionID, agent string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.children == nil {
		r.children = map[string]string{}
	}
	r.children[sessionID] = agent
	return nil
}
func (r *ruleBackend) RestartForPolicy(context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.restarts++
	if r.restart == nil {
		r.start() // a restart is a start of the process
	}
	return r.restart
}

var _ backend.RuleHost = (*ruleBackend)(nil)

func newRuleMachine(t *testing.T, pol policy.Policy) (*machine, *ruleBackend, string) {
	t.Helper()
	stateDir := t.TempDir()
	reg, err := workspaces.Load(filepath.Join(stateDir, "workspaces.json"))
	if err != nil {
		t.Fatal(err)
	}
	ws, err := reg.Create("ws", t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	rb := &ruleBackend{fakeBackend: &fakeBackend{}}
	mat := sessions.New(rb, pol)
	mc := newMachine(reg, rb, mat, pol)
	audit, err := newAuditLogger(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = audit.Close() })
	mc.AttachAudit(audit)
	mc.trackSession(ws, backend.Session{ID: "s1"})
	return mc, rb, stateDir
}

func auditRows(t *testing.T, dir string) []map[string]any {
	t.Helper()
	raw, _ := os.ReadFile(filepath.Join(dir, "audit.log"))
	var rows []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line == "" {
			continue
		}
		var row map[string]any
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatalf("audit line %q: %v", line, err)
		}
		rows = append(rows, row)
	}
	return rows
}

func askFor(mc *machine, id, tool string) {
	mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{
		WorkspaceDir: "/x", SessionID: "s1",
		Event: backend.Event{Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: id, SessionID: "s1", Tool: tool, Patterns: []string{"rm -rf /"}}},
	})
}

func policyWithCeiling(max map[string]string) policy.Policy {
	p := policy.Default()
	p.Permission.Max = max
	return p
}

// "Always allow" is an exception on the root session, never an approval opencode
// keeps: opencode is answered "once" every time, and a key the ceiling caps
// stores nothing.
func TestAlwaysIsAnExceptionAndOpencodeGetsOnce(t *testing.T) {
	mc, rb, dir := newRuleMachine(t, policyWithCeiling(map[string]string{"bash": "ask", "webfetch": "deny"}))
	ctx := context.Background()
	reply := func(id, decision string) {
		t.Helper()
		args, _ := json.Marshal(map[string]any{"sessionId": "s1", "requestId": id, "decision": decision})
		if _, operr := mc.opPermissionReply(ctx, args); operr != nil {
			t.Fatalf("reply %s: %v", id, operr)
		}
	}
	askFor(mc, "per_1", "bash")
	askFor(mc, "per_2", "edit")
	askFor(mc, "per_3", "bash")
	reply("per_1", "always") // bash is capped at ask: stores nothing
	reply("per_2", "always") // edit is not capped: an exception
	reply("per_3", "reject")
	reply("per_unknown", "always") // an ask the machine does not hold, with a ceiling: cannot tell what it covers
	want := []backend.Decision{backend.DecisionOnce, backend.DecisionOnce, backend.DecisionReject, backend.DecisionOnce}
	if len(rb.replies) != len(want) {
		t.Fatalf("replies = %v, want %v", rb.replies, want)
	}
	for i := range want {
		if rb.replies[i] != want[i] {
			t.Errorf("reply %d = %s, want %s: opencode must never be told always", i, rb.replies[i], want[i])
		}
	}
	ex := rb.Exceptions("s1")
	if len(ex) != 1 || ex[0].Permission != "edit" || len(ex[0].Patterns) != 1 || ex[0].Patterns[0] != "rm -rf /" ||
		!strings.HasPrefix(ex[0].ID, "ex_") || ex[0].GrantedAt == "" {
		t.Fatalf("exceptions = %+v, want one edit exception (patterns fall back to the ask's own), none for the capped bash", ex)
	}

	var perms []map[string]any
	for _, r := range auditRows(t, dir) {
		if r["action"] == "permission" {
			perms = append(perms, r)
		}
	}
	if len(perms) != 4 {
		t.Fatalf("audit rows = %v, want one per reply", perms)
	}
	if perms[0]["tool"] != "bash" || perms[0]["decision"] != "once" || perms[0]["capped"] != true || perms[0]["by"] != "user" ||
		perms[0]["session"] != "s1" || perms[0]["requestId"] != "per_1" {
		t.Errorf("capped row = %v", perms[0])
	}
	if perms[1]["decision"] != "always" || perms[1]["capped"] != nil {
		t.Errorf("the stored exception is audited as the person's always: %v", perms[1])
	}
	if perms[2]["decision"] != "reject" {
		t.Errorf("a reject is audited too: %v", perms[2])
	}
	raw, _ := json.Marshal(perms)
	if strings.Contains(string(raw), "rm -rf") {
		t.Errorf("a pattern (for bash, the command) reached the audit log: %s", raw)
	}
}

// opencode's own `always` patterns are what the exception covers, when the ask
// carries them; a galopin ask (gp_) is never an exception.
func TestAlwaysUsesTheAsksAlwaysPatternsAndSkipsGalopinAsks(t *testing.T) {
	mc, rb, _ := newRuleMachine(t, policy.Default())
	mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{WorkspaceDir: "/x", SessionID: "s1", Event: backend.Event{
		Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: "per_1", SessionID: "s1", Tool: "bash",
			Patterns: []string{"git status --short"}, Always: []string{"git status *"}},
	}})
	mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{WorkspaceDir: "/x", SessionID: "s1", Event: backend.Event{
		Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: "gp_1", SessionID: "s1", Tool: "session_spawn", Patterns: []string{"*"}},
	}})
	for _, id := range []string{"per_1", "gp_1"} {
		args, _ := json.Marshal(map[string]any{"sessionId": "s1", "requestId": id, "decision": "always"})
		if _, operr := mc.opPermissionReply(context.Background(), args); operr != nil {
			t.Fatal(operr)
		}
	}
	ex := rb.Exceptions("s1")
	if len(ex) != 1 || ex[0].Permission != "bash" || len(ex[0].Patterns) != 1 || ex[0].Patterns[0] != "git status *" {
		t.Errorf("exceptions = %+v, want the one for git status *, none for the gp_ ask", ex)
	}
	// The same "always" twice is one entry.
	mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{WorkspaceDir: "/x", SessionID: "s1", Event: backend.Event{
		Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: "per_2", SessionID: "s1", Tool: "bash", Always: []string{"git status *"}},
	}})
	args, _ := json.Marshal(map[string]any{"sessionId": "s1", "requestId": "per_2", "decision": "always"})
	_, _ = mc.opPermissionReply(context.Background(), args)
	if n := len(rb.Exceptions("s1")); n != 1 {
		t.Errorf("exceptions = %d after the same always twice, want 1", n)
	}
}

// A subagent's "always" lands on its ROOT.
func TestASubagentsAlwaysIsStoredOnItsRoot(t *testing.T) {
	mc, rb, _ := newRuleMachine(t, policy.Default())
	ctx := context.Background()
	mc.mat.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/x", SessionID: "kid", Event: backend.Event{
		Kind: backend.EventSession, Session: &backend.Session{ID: "kid", ParentID: "s1"},
	}})
	mc.sessionWorkspaceID["kid"] = mc.sessionWorkspaceID["s1"]
	mc.mat.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/x", SessionID: "kid", Event: backend.Event{
		Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: "per_k", SessionID: "kid", Tool: "edit", Always: []string{"*"}},
	}})
	args, _ := json.Marshal(map[string]any{"sessionId": "kid", "requestId": "per_k", "decision": "always"})
	if _, operr := mc.opPermissionReply(ctx, args); operr != nil {
		t.Fatal(operr)
	}
	if len(rb.Exceptions("s1")) != 1 || len(rb.Exceptions("kid")) != 0 {
		t.Errorf("root=%+v child=%+v, want the exception on the root only", rb.Exceptions("s1"), rb.Exceptions("kid"))
	}
}

// A failed exception is not a failed answer: this one is allowed once.
func TestAnExceptionThatCannotBeStoredStillAnswersOnce(t *testing.T) {
	mc, rb, dir := newRuleMachine(t, policy.Default())
	askFor(mc, "per_1", "edit")
	rb.setErr = errors.New("opencode went away")
	args, _ := json.Marshal(map[string]any{"sessionId": "s1", "requestId": "per_1", "decision": "always"})
	if _, operr := mc.opPermissionReply(context.Background(), args); operr != nil {
		t.Fatal(operr)
	}
	if len(rb.replies) != 1 || rb.replies[0] != backend.DecisionOnce {
		t.Errorf("replies = %v", rb.replies)
	}
	for _, r := range auditRows(t, dir) {
		if r["action"] == "permission" && r["decision"] != "once" {
			t.Errorf("an exception that was not stored is audited as always: %v", r)
		}
	}
}

func TestPermissionRulesIsReadOnlyAndTakenApartBySource(t *testing.T) {
	mc, rb, _ := newRuleMachine(t, policyWithCeiling(map[string]string{"edit": "ask"}))
	rb.layers = backend.RuleLayers{Agent: "build", Rules: []backend.SourcedRule{
		{Rule: permrules.Rule{Permission: "*", Pattern: "*", Action: permrules.Allow}, Source: backend.SourceDefault},
		{Rule: permrules.Rule{Permission: "edit", Pattern: "*", Action: permrules.Ask}, Source: backend.SourceFile},
		{Rule: permrules.Rule{Permission: "edit", Pattern: "*", Action: permrules.Deny}, Source: backend.SourceMachine},
		{Rule: permrules.Rule{Permission: "edit", Pattern: "*", Action: permrules.Allow}, Source: backend.SourceCerea},
		{Rule: permrules.Rule{Permission: "edit", Pattern: "*", Action: permrules.Ask}, Source: backend.SourceCeiling},
	}}
	dir, _ := mc.mat.WorkspaceDir("s1")
	_ = dir
	rb.layers.Mode = "allow"
	_, _ = rb.AddException(context.Background(), "", "s1", permrules.Exception{ID: "ex_1", Permission: "bash", Patterns: []string{"rm *"}, GrantedAt: "2026-10-03T10:00:00Z"})
	_, _ = rb.AddException(context.Background(), "", "s2", permrules.Exception{ID: "ex_2", Permission: "edit", Patterns: []string{"*"}}) // another root's
	got, operr := mc.opPermissionRules(context.Background(), json.RawMessage(`{"sessionId":"s1"}`))
	if operr != nil {
		t.Fatal(operr)
	}
	body, _ := json.Marshal(got)
	var out struct {
		Agent string `json:"agent"`
		Mode  string `json:"mode"`
		Rules []struct {
			Permission, Pattern, Action, Source string
		} `json:"rules"`
		SavedApprovals []backend.SavedApproval `json:"savedApprovals"`
		Ceiling        map[string]string       `json:"ceiling"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	sources := []string{}
	for _, r := range out.Rules {
		sources = append(sources, r.Source)
	}
	if out.Agent != "build" || strings.Join(sources, " ") != "default file machine cerea ceiling" {
		t.Errorf("rules = %+v (sources %v)", out, sources)
	}
	if out.Mode != "allow" {
		t.Errorf("mode = %q, want the backend's word", out.Mode)
	}
	if len(out.SavedApprovals) != 1 || out.Ceiling["edit"] != "ask" {
		t.Fatalf("saved/ceiling = %+v: only this root's exceptions should be listed", out)
	}
	ex := out.SavedApprovals[0]
	if ex.ID != "ex_1" || ex.SessionID != "s1" || ex.Permission != "bash" || !ex.Removable || ex.GrantedAt == "" || ex.Patterns[0] != "rm *" {
		t.Errorf("an exception = %+v: it should name its root and be removable", ex)
	}
	// None is [] on the wire, never null.
	none, _ := mc.opPermissionRules(context.Background(), json.RawMessage(`{"sessionId":"s1"}`))
	_ = none
	if _, operr := mc.opPermissionRules(context.Background(), json.RawMessage(`{}`)); operr == nil || operr.Code != "invalid" {
		t.Errorf("no sessionId: %v", operr)
	}
	if _, operr := mc.opPermissionRules(context.Background(), json.RawMessage(`{"sessionId":"ghost"}`)); operr == nil {
		t.Error("an unknown session must be refused")
	}
}

func TestPermissionRulesUnsupportedWithoutAPermissionBackend(t *testing.T) {
	stateDir := t.TempDir()
	reg, _ := workspaces.Load(filepath.Join(stateDir, "workspaces.json"))
	ws, _ := reg.Create("ws", t.TempDir(), nil)
	fb := &fakeBackend{}
	mc := newMachine(reg, fb, sessions.New(fb, policy.Default()), policy.Default())
	mc.trackSession(ws, backend.Session{ID: "s1"})
	if _, operr := mc.opPermissionRules(context.Background(), json.RawMessage(`{"sessionId":"s1"}`)); operr == nil || operr.Code != "unsupported" {
		t.Errorf("rules on a backend without them: %v", operr)
	}
	if _, operr := mc.opPermissionSavedRemove(context.Background(), json.RawMessage(`{"sessionId":"s1","id":"x"}`)); operr == nil || operr.Code != "unsupported" {
		t.Errorf("saved.remove on a backend without them: %v", operr)
	}
}

func TestSavedRemoveNeedsBothIDsAndKnowsOnlyThisRootsExceptions(t *testing.T) {
	mc, rb, _ := newRuleMachine(t, policy.Default())
	_, _ = rb.AddException(context.Background(), "", "s1", permrules.Exception{ID: "ex_mine", Permission: "bash", Patterns: []string{"ls *"}})
	_, _ = rb.AddException(context.Background(), "", "s9", permrules.Exception{ID: "ex_other", Permission: "bash", Patterns: []string{"ls *"}})
	for name, body := range map[string]string{
		"no id":        `{"sessionId":"s1"}`,
		"no sessionId": `{"id":"ex_x"}`,
		"neither":      `{}`,
	} {
		if _, operr := mc.opPermissionSavedRemove(context.Background(), json.RawMessage(body)); operr == nil || operr.Code != "invalid" {
			t.Errorf("%s: %v, want invalid", name, operr)
		}
	}
	if _, operr := mc.opPermissionSavedRemove(context.Background(), json.RawMessage(`{"sessionId":"s1","id":"nope"}`)); operr == nil || operr.Code != "not_found" {
		t.Errorf("an unknown id: %v, want not_found", operr)
	}
	if _, operr := mc.opPermissionSavedRemove(context.Background(), json.RawMessage(`{"sessionId":"s1","id":"ex_other"}`)); operr == nil || operr.Code != "not_found" {
		t.Errorf("another root's exception: %v, want not_found", operr)
	}
	if len(rb.Exceptions("s9")) != 1 {
		t.Error("another root's exception was removed")
	}
	if _, operr := mc.opPermissionSavedRemove(context.Background(), json.RawMessage(`{"sessionId":"ghost","id":"x"}`)); operr == nil || operr.Code != "not_found" {
		t.Errorf("an unknown session: %v", operr)
	}
}

// permission.saved.remove really removes now, audited with no patterns; a process
// start does not forget exceptions (they are galopin's, not opencode's), only the
// asks that died with the old process.
func TestSavedRemoveRemovesAnExceptionAndAProcessStartKeepsThem(t *testing.T) {
	mc, rb, dir := newRuleMachine(t, policy.Default())
	askFor(mc, "per_1", "edit")
	args, _ := json.Marshal(map[string]any{"sessionId": "s1", "requestId": "per_1", "decision": "always"})
	if _, operr := mc.opPermissionReply(context.Background(), args); operr != nil {
		t.Fatal(operr)
	}
	list := rb.Exceptions("s1")
	if len(list) != 1 {
		t.Fatalf("exceptions = %+v", list)
	}
	askFor(mc, "per_2", "edit")
	rb.start()
	if len(rb.Exceptions("s1")) != 1 {
		t.Error("a process start forgot an exception")
	}
	if mc.mat.PendingPermissions("s1") != 0 {
		t.Error("an ask that died with the old process is still shown")
	}
	rm, _ := json.Marshal(map[string]any{"sessionId": "s1", "id": list[0].ID})
	res, operr := mc.opPermissionSavedRemove(context.Background(), rm)
	if operr != nil {
		t.Fatalf("remove: %v", operr)
	}
	if m, ok := res.(map[string]any); !ok || len(m) != 0 {
		t.Errorf("answer = %v, want {}", res)
	}
	if len(rb.Exceptions("s1")) != 0 {
		t.Error("the exception is still there")
	}
	var row map[string]any
	for _, r := range auditRows(t, dir) {
		if r["action"] == "permission.saved.remove" {
			row = r
		}
	}
	if row == nil || row["id"] != list[0].ID {
		t.Fatalf("remove audit row = %v", row)
	}
	raw, _ := json.Marshal(row)
	if strings.Contains(string(raw), "rm -rf") {
		t.Errorf("a pattern reached the audit log: %s", raw)
	}
}

// The link sets a session's selector and removes an exception; no op sets a
// ceiling or a policy, and the retired ones say so.
func TestNoOpWritesRules(t *testing.T) {
	mc, _, _ := newRuleMachine(t, policy.Default())
	for _, op := range []string{"permission.rules.set", "permission.setRules", "permission.ceiling", "policy.set", "permission.saved.add", "session.setRule", "session.setRules", "session.setAutoAccept"} {
		if _, operr := mc.Handle(context.Background(), op, json.RawMessage(`{}`)); operr == nil || operr.Code != "unsupported" {
			t.Errorf("%s: %v, want unsupported", op, operr)
		}
	}
}

func TestTightenedPolicyRestartsWithdrawsAndReapplies(t *testing.T) {
	mc, rb, dir := newRuleMachine(t, policy.Default())
	askFor(mc, "per_1", "edit")
	if mc.mat.PendingPermissions("s1") != 1 {
		t.Fatal("setup: the ask was not held")
	}
	mc.policyTightened(context.Background(), policy.Change{Tightened: true})
	if rb.restarts != 1 {
		t.Errorf("restarts = %d, want 1", rb.restarts)
	}
	if mc.mat.PendingPermissions("s1") != 0 {
		t.Error("an ask that died with the old process is still shown")
	}
	if len(rb.ensured) != 1 || rb.ensured[0] != "s1" {
		t.Errorf("ensured = %v, want every tracked session brought under the new rules", rb.ensured)
	}
	var restarted bool
	for _, r := range auditRows(t, dir) {
		restarted = restarted || (r["action"] == "permission.tightened" && r["restarted"] == true)
	}
	if !restarted {
		t.Error("the restart was not audited")
	}

	// A change that tightens nothing needs no restart.
	mc.policyTightened(context.Background(), policy.Change{})
	if rb.restarts != 1 {
		t.Errorf("restarts = %d after a change that tightened nothing, want still 1", rb.restarts)
	}
}

func TestFailedRestartIsAuditedAndLeavesAsksAlone(t *testing.T) {
	mc, rb, dir := newRuleMachine(t, policy.Default())
	rb.restart = errors.New("did not come back")
	askFor(mc, "per_1", "edit")
	mc.policyTightened(context.Background(), policy.Change{Tightened: true})
	if mc.mat.PendingPermissions("s1") != 1 {
		t.Error("asks were withdrawn though the old process may still be answering for them")
	}
	for _, r := range auditRows(t, dir) {
		if r["action"] == "permission.tightened" && r["restarted"] == false {
			return
		}
	}
	t.Error("the failed restart was not audited")
}

func TestWatchPolicyTakesInOnlyTightening(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	start := policy.Default()
	start.Permission = policy.Permission{Max: map[string]string{"bash": "ask"}}
	if err := policy.Save(path, start); err != nil {
		t.Fatal(err)
	}
	live := policy.NewLive(start.Permission)

	var mu sync.Mutex
	var changes []policy.Change
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go watchPolicy(ctx, path, live, 10*time.Millisecond, func(ch policy.Change) {
		mu.Lock()
		changes = append(changes, ch)
		mu.Unlock()
	})
	count := func() int { mu.Lock(); defer mu.Unlock(); return len(changes) }
	waitFor := func(n int, what string) {
		t.Helper()
		for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
			if count() >= n {
				return
			}
		}
		t.Fatalf("%s: changes = %d, want %d", what, count(), n)
	}
	write := func(p policy.Policy) {
		t.Helper()
		time.Sleep(15 * time.Millisecond) // a distinct mtime
		if err := policy.Save(path, p); err != nil {
			t.Fatal(err)
		}
	}

	tight := start
	tight.Permission = policy.Permission{Max: map[string]string{"bash": "deny"}}
	write(tight)
	waitFor(1, "a lowered ceiling")
	if !changes[0].Tightened {
		t.Errorf("change = %+v", changes[0])
	}

	// A file edited back up is ignored: loosening needs enroll.
	loose := start
	loose.Permission = policy.Permission{Max: map[string]string{"bash": "allow"}}
	write(loose)
	time.Sleep(150 * time.Millisecond)
	if count() != 1 || live.Permission().Max["bash"] != "deny" {
		t.Errorf("a loosened file was taken in: changes=%d permission=%+v", count(), live.Permission())
	}

	// A half-written file is ignored, not applied and not fatal.
	time.Sleep(15 * time.Millisecond)
	if err := os.WriteFile(path, []byte(`{"permission":{"max":{"bash":"as`), 0o600); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	if count() != 1 {
		t.Errorf("a torn file produced a change: %d", count())
	}

}

func TestChildGetsTheCeilingWithItsAgent(t *testing.T) {
	mc, rb, _ := newRuleMachine(t, policy.Default())
	ctx := context.Background()
	mc.mat.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/x", SessionID: "s1", Event: backend.Event{
		Kind: backend.EventPart,
		Part: &backend.Part{ID: "p1", MessageID: "m1", Role: "assistant", Type: backend.PartTool, CallID: "c", Tool: "task",
			ToolStatus: backend.ToolRunning, SubtaskSessionID: "kid", Input: map[string]any{"subagent_type": "explore"}},
	}})
	mc.mat.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/x", SessionID: "kid", Event: backend.Event{
		Kind: backend.EventSession, Session: &backend.Session{ID: "kid", ParentID: "s1"},
	}})
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		rb.mu.Lock()
		agent, ok := rb.children["kid"]
		rb.mu.Unlock()
		if ok {
			if agent != "explore" {
				t.Fatalf("child agent = %q, want explore", agent)
			}
			return
		}
	}
	t.Fatal("the subagent was never given the ceiling")
}

// P7: a session.prompt that carries `tools` never hands it on: the field is
// not part of what a prompt is, and opencode would treat it as replacing the
// session's rules.
type capturingBackend struct {
	*fakeBackend
	prompts []backend.Prompt
}

func (c *capturingBackend) Prompt(_ context.Context, _, _ string, p backend.Prompt) error {
	c.prompts = append(c.prompts, p)
	return nil
}

func TestPromptOpCarriesNoToolsField(t *testing.T) {
	stateDir := t.TempDir()
	reg, _ := workspaces.Load(filepath.Join(stateDir, "workspaces.json"))
	ws, _ := reg.Create("ws", t.TempDir(), nil)
	cb := &capturingBackend{fakeBackend: &fakeBackend{}}
	mc := newMachine(reg, cb, sessions.New(cb, policy.Default()), policy.Default())
	mc.trackSession(ws, backend.Session{ID: "s1"})
	args := json.RawMessage(`{"sessionId":"s1","text":"hi","tools":{"bash":true,"edit":true},"permission":[{"permission":"*","pattern":"*","action":"allow"}]}`)
	if _, operr := mc.Handle(context.Background(), "session.prompt", args); operr != nil {
		t.Fatal(operr)
	}
	if len(cb.prompts) != 1 {
		t.Fatalf("prompts = %d", len(cb.prompts))
	}
	raw, _ := json.Marshal(cb.prompts[0])
	for _, forbidden := range []string{`"tools"`, `"permission"`, "allow"} {
		if strings.Contains(string(raw), forbidden) {
			t.Errorf("the prompt handed to the backend carries %s: %s", forbidden, raw)
		}
	}
}

// The rule lookup behind session_spawn / session_send, as a table: allow,
// deny, ask, absent, and the two wildcards.
func TestGrantReadsTheAskingSessionsRules(t *testing.T) {
	mc, rb, _ := newRuleMachine(t, policy.Default())
	at := &agentTools{mc: mc}
	tc := &toolCaller{dir: "/x", workspaceID: "w", session: backend.Session{ID: "s1"}}
	allowAll := permrules.Rule{Permission: "*", Pattern: "*", Action: permrules.Allow}
	cases := []struct {
		name    string
		rules   []permrules.Rule
		want    permrules.Action
		refused bool
	}{
		{"absent", nil, permrules.Ask, false},
		{"opencode's default * allow", []permrules.Rule{allowAll}, permrules.Ask, false},
		{"explicit allow over the default", []permrules.Rule{allowAll, {Permission: "session_spawn", Pattern: "*", Action: permrules.Allow}}, permrules.Allow, false},
		{"explicit ask", []permrules.Rule{allowAll, {Permission: "session_spawn", Pattern: "*", Action: permrules.Ask}}, permrules.Ask, false},
		{"explicit deny", []permrules.Rule{allowAll, {Permission: "session_spawn", Pattern: "*", Action: permrules.Deny}}, permrules.Deny, true},
		{"* deny", []permrules.Rule{{Permission: "session_spawn", Pattern: "*", Action: permrules.Allow}, {Permission: "*", Pattern: "*", Action: permrules.Deny}}, permrules.Deny, true},
		{"the other tool's allow is not this one's", []permrules.Rule{{Permission: "session_send", Pattern: "*", Action: permrules.Allow}}, permrules.Ask, false},
	}
	for _, c := range cases {
		rb.layers = backend.RuleLayers{}
		for _, r := range c.rules {
			rb.layers.Rules = append(rb.layers.Rules, backend.SourcedRule{Rule: r, Source: backend.SourceDefault})
		}
		got, err := at.grant(context.Background(), tc, "session_spawn")
		if got != c.want || (err != nil) != c.refused {
			t.Errorf("%s: grant = %s, %v; want %s refused=%v", c.name, got, err, c.want, c.refused)
		}
	}

	// A backend that cannot show its rules, or an error reading them, is not
	// consent.
	rb.layers = backend.RuleLayers{}
	fb := &fakeBackend{}
	at2 := &agentTools{mc: &machine{back: fb}}
	if got, err := at2.grant(context.Background(), tc, "session_spawn"); got != permrules.Ask || err != nil {
		t.Errorf("a backend without rules = %s, %v; want ask", got, err)
	}
}

// session.setPermissionMode: the three words, a subagent follows its root, an
// unknown session is not_found; audited as permission.mode.
func TestSetPermissionMode(t *testing.T) {
	mc, rb, dir := newRuleMachine(t, policy.Default())
	ctx := context.Background()
	call := func(body string) (any, *link.OpError) {
		return mc.Handle(ctx, "session.setPermissionMode", json.RawMessage(body))
	}
	for _, mode := range []string{"deny", "allow", "ask"} {
		res, operr := call(`{"sessionId":"s1","mode":"` + mode + `"}`)
		if operr != nil {
			t.Fatalf("%s: %v", mode, operr)
		}
		if m, ok := res.(map[string]any); !ok || len(m) != 0 {
			t.Errorf("answer = %v, want {}", res)
		}
		if got := rb.PermissionMode("s1"); string(got) != mode {
			t.Errorf("mode = %s, want %s", got, mode)
		}
	}
	for name, body := range map[string]string{
		"a bad mode": `{"sessionId":"s1","mode":"yes"}`,
		"no mode":    `{"sessionId":"s1"}`,
		"a capital":  `{"sessionId":"s1","mode":"Allow"}`,
		"not json":   `{"sessionId":1}`,
	} {
		if _, operr := call(body); operr == nil || operr.Code != "invalid" {
			t.Errorf("%s: %v, want invalid", name, operr)
		}
	}
	if _, operr := call(`{"sessionId":"ghost","mode":"allow"}`); operr == nil || operr.Code != "not_found" {
		t.Errorf("an unknown session: %v, want not_found", operr)
	}
	// A subagent has no selector of its own.
	mc.mat.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/x", SessionID: "kid", Event: backend.Event{
		Kind: backend.EventSession, Session: &backend.Session{ID: "kid", ParentID: "s1"},
	}})
	mc.sessionWorkspaceID["kid"] = mc.sessionWorkspaceID["s1"]
	if _, operr := call(`{"sessionId":"kid","mode":"allow"}`); operr == nil || operr.Code != "invalid" || !strings.Contains(operr.Message, "follows its root") {
		t.Errorf("a subagent: %v, want invalid (a subagent follows its root)", operr)
	}
	if rb.PermissionMode("kid") != permrules.Ask {
		t.Error("a subagent's mode was set")
	}
	var modes []string
	for _, r := range auditRows(t, dir) {
		if r["action"] == "permission.mode" && r["session"] == "s1" {
			modes = append(modes, r["mode"].(string))
		}
	}
	if strings.Join(modes, " ") != "deny allow ask" {
		t.Errorf("audit modes = %v, want deny allow ask", modes)
	}
	rb.setErr = errors.New("opencode went away")
	if _, operr := call(`{"sessionId":"s1","mode":"deny"}`); operr == nil || operr.Code != "backend" {
		t.Errorf("a change that could not be applied must say so: %v", operr)
	}
}

func TestSetPermissionModeUnsupportedWithoutAPermissionBackend(t *testing.T) {
	stateDir := t.TempDir()
	reg, _ := workspaces.Load(filepath.Join(stateDir, "workspaces.json"))
	ws, _ := reg.Create("ws", t.TempDir(), nil)
	fb := &fakeBackend{}
	mc := newMachine(reg, fb, sessions.New(fb, policy.Default()), policy.Default())
	mc.trackSession(ws, backend.Session{ID: "s1"})
	if _, operr := mc.Handle(context.Background(), "session.setPermissionMode", json.RawMessage(`{"sessionId":"s1","mode":"allow"}`)); operr == nil || operr.Code != "unsupported" {
		t.Errorf("a backend without a selector: %v", operr)
	}
}

// Session objects carry the selector's word; a backend with none omits it.
func TestSessionsReportTheirPermissionMode(t *testing.T) {
	mc, rb, _ := newRuleMachine(t, policy.Default())
	if got := mc.enrich(backend.Session{ID: "s1"}, "w").PermissionMode; got != "ask" {
		t.Errorf("a new session reports %q, want ask", got)
	}
	_ = rb.SetPermissionMode(context.Background(), "", "s1", permrules.Allow)
	listed := mc.enrichAll([]backend.Session{{ID: "s1"}}, []string{"w"})
	if listed[0].PermissionMode != "allow" {
		t.Errorf("a listed session reports %q, want allow", listed[0].PermissionMode)
	}
	fb := &fakeBackend{}
	plain := newMachine(nil, fb, sessions.New(fb, policy.Default()), policy.Default())
	if got := plain.enrich(backend.Session{ID: "x"}, "w").PermissionMode; got != "" {
		t.Errorf("a backend without a selector reports %q", got)
	}
}

// The retired ops answer unsupported for one release.
func TestRetiredOpsAnswerUnsupported(t *testing.T) {
	mc, _, _ := newRuleMachine(t, policy.Default())
	for _, op := range []string{"session.setAutoAccept", "session.setRules"} {
		if _, operr := mc.Handle(context.Background(), op, json.RawMessage(`{"sessionId":"s1","enabled":true,"rules":[]}`)); operr == nil || operr.Code != "unsupported" {
			t.Errorf("%s: %v, want unsupported", op, operr)
		}
	}
}
