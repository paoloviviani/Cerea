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
	"galopin/internal/permrules"
	"galopin/internal/policy"
	"galopin/internal/sessions"
	"galopin/internal/workspaces"
)

// ruleBackend is a Backend with a permission surface: replies are recorded,
// rules and saved approvals canned, and every call RestartForPolicy,
// EnsureRules and ApplyChildRules receives is kept.
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
	setRules map[string][]permrules.Rule
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
func (r *ruleBackend) SetSessionRules(_ context.Context, _, sessionID string, rules []permrules.Rule) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.setRules == nil {
		r.setRules = map[string][]permrules.Rule{}
	}
	r.setRules[sessionID] = rules
	return r.setErr
}
func (r *ruleBackend) RuleLayers(context.Context, string, string) (backend.RuleLayers, error) {
	return r.layers, nil
}

// OnProcessStart records the callback; start() plays a process start.
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

func TestAlwaysIsCappedByTheCeiling(t *testing.T) {
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
	reply("per_1", "always") // bash is capped at ask: one click must not outlive itself
	reply("per_2", "always") // edit is not capped
	reply("per_3", "reject")
	reply("per_unknown", "always") // an ask the machine does not hold, with a ceiling: cannot tell what it covers
	want := []backend.Decision{backend.DecisionOnce, backend.DecisionAlways, backend.DecisionReject, backend.DecisionOnce}
	if len(rb.replies) != len(want) {
		t.Fatalf("replies = %v, want %v", rb.replies, want)
	}
	for i := range want {
		if rb.replies[i] != want[i] {
			t.Errorf("reply %d = %s, want %s", i, rb.replies[i], want[i])
		}
	}

	rows := auditRows(t, dir)
	var perms []map[string]any
	for _, r := range rows {
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
	if perms[2]["decision"] != "reject" {
		t.Errorf("a reject is audited too: %v", perms[2])
	}
	raw, _ := json.Marshal(perms)
	if strings.Contains(string(raw), "rm -rf") {
		t.Errorf("a pattern (for bash, the command) reached the audit log: %s", raw)
	}
}

func TestAlwaysStandsWithNoCeiling(t *testing.T) {
	mc, rb, _ := newRuleMachine(t, policy.Default())
	askFor(mc, "per_1", "bash")
	args, _ := json.Marshal(map[string]any{"sessionId": "s1", "requestId": "per_1", "decision": "always"})
	if _, operr := mc.opPermissionReply(context.Background(), args); operr != nil {
		t.Fatal(operr)
	}
	if len(rb.replies) != 1 || rb.replies[0] != backend.DecisionAlways {
		t.Errorf("replies = %v, want always to stand when nothing is capped", rb.replies)
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
	mc.saved.add("s1", dir, "bash", []string{"rm *"})
	mc.saved.add("s2", "/another/workspace", "edit", []string{"*"}) // granted elsewhere
	got, operr := mc.opPermissionRules(context.Background(), json.RawMessage(`{"sessionId":"s1"}`))
	if operr != nil {
		t.Fatal(operr)
	}
	body, _ := json.Marshal(got)
	var out struct {
		Agent string `json:"agent"`
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
	if len(out.SavedApprovals) != 1 || out.Ceiling["edit"] != "ask" {
		t.Fatalf("saved/ceiling = %+v: only this workspace's approval should be listed", out)
	}
	minted := out.SavedApprovals[0]
	if !strings.HasPrefix(minted.ID, "sa_") || minted.SessionID != "s1" || minted.Permission != "bash" || minted.Removable {
		t.Errorf("a minted approval = %+v: it should carry the granting session and not be removable", minted)
	}
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

func TestSavedRemoveNeedsBothIDsAndKnowsOnlyThisWorkspacesApprovals(t *testing.T) {
	mc, _, _ := newRuleMachine(t, policy.Default())
	dir, _ := mc.mat.WorkspaceDir("s1")
	mc.saved.add("s1", dir, "bash", []string{"ls *"})
	mc.saved.add("s9", "/elsewhere", "bash", []string{"ls *"})
	elsewhere := mc.saved.list()[1].ID
	for name, body := range map[string]string{
		"no id":        `{"sessionId":"s1"}`,
		"no sessionId": `{"id":"sa_x"}`,
		"neither":      `{}`,
	} {
		if _, operr := mc.opPermissionSavedRemove(context.Background(), json.RawMessage(body)); operr == nil || operr.Code != "invalid" {
			t.Errorf("%s: %v, want invalid", name, operr)
		}
	}
	if _, operr := mc.opPermissionSavedRemove(context.Background(), json.RawMessage(`{"sessionId":"s1","id":"nope"}`)); operr == nil || operr.Code != "not_found" {
		t.Errorf("an unknown id: %v, want not_found", operr)
	}
	body, _ := json.Marshal(map[string]any{"sessionId": "s1", "id": elsewhere})
	if _, operr := mc.opPermissionSavedRemove(context.Background(), body); operr == nil || operr.Code != "not_found" {
		t.Errorf("another workspace's approval: %v, want not_found", operr)
	}
	if _, operr := mc.opPermissionSavedRemove(context.Background(), json.RawMessage(`{"sessionId":"ghost","id":"x"}`)); operr == nil || operr.Code != "not_found" {
		t.Errorf("an unknown session: %v", operr)
	}
}

// An approval galopin minted an id for cannot be withdrawn on 1.18.32: the op
// says so, rather than pretending, and nothing is removed.
func TestSavedRemoveOfAMintedApprovalIsUnsupported(t *testing.T) {
	mc, rb, _ := newRuleMachine(t, policy.Default())
	askFor(mc, "per_1", "edit")
	args, _ := json.Marshal(map[string]any{"sessionId": "s1", "requestId": "per_1", "decision": "always"})
	if _, operr := mc.opPermissionReply(context.Background(), args); operr != nil {
		t.Fatal(operr)
	}
	list := mc.saved.list()
	if len(list) != 1 || list[0].SessionID != "s1" || list[0].Permission != "edit" || list[0].Removable {
		t.Fatalf("ledger = %+v, want one non-removable entry for the granting session", list)
	}
	if len(list[0].Patterns) != 1 || list[0].Patterns[0] != "rm -rf /" {
		t.Errorf("patterns = %v", list[0].Patterns)
	}
	rm, _ := json.Marshal(map[string]any{"sessionId": "s1", "id": list[0].ID})
	if _, operr := mc.opPermissionSavedRemove(context.Background(), rm); operr == nil || operr.Code != "unsupported" {
		t.Errorf("removing a minted approval: %v, want unsupported", operr)
	}
	if n := len(mc.saved.list()); n != 1 {
		t.Errorf("ledger = %d entries after an unsupported removal, want it untouched", n)
	}
	if dir, _ := mc.mat.WorkspaceDir("s1"); list[0].WorkspaceDir != dir {
		t.Errorf("entry workspace = %q, want %q", list[0].WorkspaceDir, dir)
	}
	// A capped always creates nothing to remember; neither does a once.
	mc2, _, _ := newRuleMachine(t, policyWithCeiling(map[string]string{"edit": "ask"}))
	askFor(mc2, "per_1", "edit")
	if _, operr := mc2.opPermissionReply(context.Background(), args); operr != nil {
		t.Fatal(operr)
	}
	if n := len(mc2.saved.list()); n != 0 {
		t.Errorf("ledger = %d entries after a capped always, want none", n)
	}
	// A start of the opencode process — a crash restart as much as a tightened
	// policy — forgets them, and the asks that died with the old process.
	askFor(mc, "per_2", "edit")
	rb.start()
	if n := len(mc.saved.list()); n != 0 {
		t.Errorf("ledger = %d entries after a process start, want none", n)
	}
	if mc.mat.PendingPermissions("s1") != 0 {
		t.Error("an ask that died with the old process is still shown")
	}
}

// The link writes a session's rules (capped) and withdraws a saved approval;
// no op sets a ceiling or a policy.
func TestNoOpWritesRules(t *testing.T) {
	mc, _, _ := newRuleMachine(t, policy.Default())
	for _, op := range []string{"permission.rules.set", "permission.setRules", "permission.ceiling", "policy.set", "permission.saved.add", "session.setRule"} {
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

	// Only auto-accept going off needs no restart: the responder reads the
	// switch itself.
	mc.policyTightened(context.Background(), policy.Change{RespondersOff: true})
	if rb.restarts != 1 {
		t.Errorf("restarts = %d after a responders-only change, want still 1", rb.restarts)
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
	start.Permission = policy.Permission{Responders: policy.TerminalAllowed, Max: map[string]string{"bash": "ask"}}
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
	tight.Permission = policy.Permission{Responders: policy.TerminalAllowed, Max: map[string]string{"bash": "deny"}}
	write(tight)
	waitFor(1, "a lowered ceiling")
	if !changes[0].Tightened || changes[0].RespondersOff {
		t.Errorf("change = %+v", changes[0])
	}

	// A file edited back up is ignored: loosening needs enroll.
	loose := start
	loose.Permission = policy.Permission{Responders: policy.TerminalAllowed, Max: map[string]string{"bash": "allow"}}
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

	off := start
	off.Permission = policy.Permission{Responders: policy.TerminalDenied, Max: map[string]string{"bash": "deny"}}
	write(off)
	waitFor(2, "auto-accept turned off")
	if !changes[1].RespondersOff || changes[1].Tightened {
		t.Errorf("change = %+v", changes[1])
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

// session.setRules: every rule is capped to the ceiling before it is applied.
func TestSetRulesClampsToTheCeiling(t *testing.T) {
	mc, rb, dir := newRuleMachine(t, policyWithCeiling(map[string]string{"bash": "ask", "edit": "deny", "session_spawn": "ask"}))
	args, _ := json.Marshal(map[string]any{"sessionId": "s1", "rules": []map[string]any{
		{"permission": "bash", "pattern": "rm -rf *", "action": "allow"}, // over the ceiling
		{"permission": "edit", "pattern": "*", "action": "allow"},        // over: capped at deny
		{"permission": "read", "pattern": "*.md", "action": "allow"},     // under: as asked
		{"permission": "session_spawn", "pattern": "*", "action": "allow"},
	}})
	res, operr := mc.Handle(context.Background(), "session.setRules", args)
	if operr != nil {
		t.Fatal(operr)
	}
	if m, ok := res.(map[string]any); !ok || len(m) != 0 {
		t.Errorf("answer = %v, want the bare {} (the panel re-reads the truth)", res)
	}
	got := rb.setRules["s1"]
	want := []permrules.Rule{
		{Permission: "bash", Pattern: "rm -rf *", Action: permrules.Ask},
		{Permission: "edit", Pattern: "*", Action: permrules.Deny},
		{Permission: "read", Pattern: "*.md", Action: permrules.Allow},
		{Permission: "session_spawn", Pattern: "*", Action: permrules.Ask},
	}
	if len(got) != len(want) {
		t.Fatalf("applied = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("applied[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
	// The audit says it was clamped and which tools, never the patterns.
	var row map[string]any
	for _, r := range auditRows(t, dir) {
		if r["action"] == "permission.setRules" {
			row = r
		}
	}
	if row == nil || row["clamped"] != true || row["session"] != "s1" || row["sent"] != float64(4) {
		t.Fatalf("audit row = %v", row)
	}
	raw, _ := json.Marshal(row)
	if strings.Contains(string(raw), "rm -rf") || strings.Contains(string(raw), "*.md") {
		t.Errorf("a pattern reached the audit log: %s", raw)
	}
}

func TestSetRulesWithinTheCeilingIsNotClamped(t *testing.T) {
	mc, rb, dir := newRuleMachine(t, policyWithCeiling(map[string]string{"bash": "ask"}))
	args, _ := json.Marshal(map[string]any{"sessionId": "s1", "rules": []map[string]any{{"permission": "bash", "pattern": "*", "action": "deny"}, {"permission": "edit", "pattern": "*", "action": "allow"}}})
	if _, operr := mc.Handle(context.Background(), "session.setRules", args); operr != nil {
		t.Fatal(operr)
	}
	if got := rb.setRules["s1"]; len(got) != 2 || got[0].Action != permrules.Deny || got[1].Action != permrules.Allow {
		t.Errorf("applied = %+v", got)
	}
	for _, r := range auditRows(t, dir) {
		if r["action"] == "permission.setRules" && r["clamped"] != false {
			t.Errorf("a within-ceiling write was audited as clamped: %v", r)
		}
	}
	// An empty write clears the person's rules; it is still a write.
	empty, _ := json.Marshal(map[string]any{"sessionId": "s1", "rules": []any{}})
	if _, operr := mc.Handle(context.Background(), "session.setRules", empty); operr != nil {
		t.Fatal(operr)
	}
	if got, ok := rb.setRules["s1"]; !ok || len(got) != 0 {
		t.Errorf("applied after an empty write = %+v ok=%v", got, ok)
	}
}

// Refused only for an unknown session (and a malformed rule or a backend with
// no rules); never for being over the ceiling.
func TestSetRulesRefusals(t *testing.T) {
	mc, rb, _ := newRuleMachine(t, policy.Default())
	ghost, _ := json.Marshal(map[string]any{"sessionId": "ghost", "rules": []any{}})
	if _, operr := mc.Handle(context.Background(), "session.setRules", ghost); operr == nil || operr.Code != "not_found" {
		t.Errorf("an unknown session: %v, want not_found", operr)
	}
	if len(rb.setRules) != 0 {
		t.Error("something was applied to a session that does not exist")
	}
	for name, body := range map[string]string{
		"bad action":    `{"sessionId":"s1","rules":[{"permission":"edit","pattern":"*","action":"yes"}]}`,
		"no permission": `{"sessionId":"s1","rules":[{"pattern":"*","action":"allow"}]}`,
		"not json":      `{"sessionId":"s1","rules":"allow everything"}`,
	} {
		if _, operr := mc.Handle(context.Background(), "session.setRules", json.RawMessage(body)); operr == nil || operr.Code != "invalid" {
			t.Errorf("%s: %v, want invalid (a malformed rule is not silently dropped)", name, operr)
		}
	}
	tooMany := make([]map[string]string, maxSetRules+1)
	for i := range tooMany {
		tooMany[i] = map[string]string{"permission": "edit", "pattern": "*", "action": "ask"}
	}
	big, _ := json.Marshal(map[string]any{"sessionId": "s1", "rules": tooMany})
	if _, operr := mc.Handle(context.Background(), "session.setRules", big); operr == nil || operr.Code != "invalid" {
		t.Errorf("too many rules: %v", operr)
	}
	rb.setErr = errors.New("opencode went away")
	ok, _ := json.Marshal(map[string]any{"sessionId": "s1", "rules": []any{}})
	if _, operr := mc.Handle(context.Background(), "session.setRules", ok); operr == nil || operr.Code != "backend" {
		t.Errorf("a write that could not be applied must say so, got %v", operr)
	}

	stateDir := t.TempDir()
	reg, _ := workspaces.Load(filepath.Join(stateDir, "workspaces.json"))
	ws, _ := reg.Create("ws", t.TempDir(), nil)
	fb := &fakeBackend{}
	plain := newMachine(reg, fb, sessions.New(fb, policy.Default()), policy.Default())
	plain.trackSession(ws, backend.Session{ID: "s1"})
	if _, operr := plain.Handle(context.Background(), "session.setRules", json.RawMessage(`{"sessionId":"s1","rules":[]}`)); operr == nil || operr.Code != "unsupported" {
		t.Errorf("a backend without rules: %v", operr)
	}
}

// F7: the auto-accept toggle is a decision, so writing it is audited, and so is
// the attempt a machine refuses.
func TestAutoAcceptToggleIsAudited(t *testing.T) {
	pol := policy.Default()
	pol.Permission.Responders = policy.TerminalAllowed
	mc, _, dir := newRuleMachine(t, pol)
	for _, enabled := range []bool{true, false} {
		args, _ := json.Marshal(map[string]any{"sessionId": "s1", "enabled": enabled})
		if _, operr := mc.Handle(context.Background(), "session.setAutoAccept", args); operr != nil {
			t.Fatal(operr)
		}
	}
	var rows []map[string]any
	for _, r := range auditRows(t, dir) {
		if r["action"] == "auto_accept" {
			rows = append(rows, r)
		}
	}
	if len(rows) != 2 || rows[0]["enabled"] != true || rows[1]["enabled"] != false || rows[0]["session"] != "s1" {
		t.Errorf("auto_accept audit rows = %v, want an on then an off for s1", rows)
	}

	denied, _, ddir := newRuleMachine(t, policy.Default())
	args, _ := json.Marshal(map[string]any{"sessionId": "s1", "enabled": true})
	if _, operr := denied.Handle(context.Background(), "session.setAutoAccept", args); operr == nil || operr.Code != "forbidden" {
		t.Fatalf("a denying machine: %v", operr)
	}
	var refusal, toggled bool
	for _, r := range auditRows(t, ddir) {
		refusal = refusal || (r["action"] == "refusal" && r["op"] == "session.setAutoAccept")
		toggled = toggled || r["action"] == "auto_accept"
	}
	if !refusal || toggled {
		t.Errorf("refusal audited=%v, toggle audited=%v; want the refusal and no toggle row", refusal, toggled)
	}
}
