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
	saved    []backend.SavedApproval
	removed  []string
	restarts int
	ensured  []string
	children map[string]string
	layers   backend.RuleLayers
	restart  error
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
	return append(append(append([]permrules.Rule(nil), r.layers.OpencodeSide...), r.layers.Own...), r.layers.Ceiling...), nil
}
func (r *ruleBackend) RuleLayers(context.Context, string, string) (backend.RuleLayers, error) {
	return r.layers, nil
}
func (r *ruleBackend) SavedApprovals(context.Context) ([]backend.SavedApproval, error) {
	return r.saved, nil
}
func (r *ruleBackend) RemoveSavedApproval(_ context.Context, id string) error {
	for _, s := range r.saved {
		if s.ID == id {
			r.removed = append(r.removed, id)
			return nil
		}
	}
	return errors.New("no such saved approval")
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
	rb.layers = backend.RuleLayers{
		Agent:        "build",
		OpencodeSide: []permrules.Rule{{Permission: "*", Pattern: "*", Action: permrules.Allow}},
		Own:          []permrules.Rule{{Permission: "edit", Pattern: "*", Action: permrules.Allow}},
		Ceiling:      []permrules.Rule{{Permission: "edit", Pattern: "*", Action: permrules.Ask}},
	}
	rb.saved = []backend.SavedApproval{{ID: "sav_1", Action: "bash", Resource: "ls *"}}
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
	if out.Agent != "build" || len(out.Rules) != 3 || out.Rules[0].Source != "opencode" || out.Rules[1].Source != "machine" || out.Rules[2].Source != "ceiling" {
		t.Errorf("rules = %+v", out)
	}
	if len(out.SavedApprovals) != 1 || out.SavedApprovals[0].ID != "sav_1" || out.Ceiling["edit"] != "ask" {
		t.Errorf("saved/ceiling = %+v", out)
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
	if _, operr := mc.opPermissionSavedRemove(context.Background(), json.RawMessage(`{"id":"x"}`)); operr == nil || operr.Code != "unsupported" {
		t.Errorf("saved.remove on a backend without them: %v", operr)
	}
}

func TestSavedRemoveWithdrawsAndAudits(t *testing.T) {
	mc, rb, dir := newRuleMachine(t, policy.Default())
	rb.saved = []backend.SavedApproval{{ID: "sav_1", Action: "bash", Resource: "ls *"}}
	if _, operr := mc.opPermissionSavedRemove(context.Background(), json.RawMessage(`{"id":"sav_1"}`)); operr != nil {
		t.Fatal(operr)
	}
	if len(rb.removed) != 1 || rb.removed[0] != "sav_1" {
		t.Errorf("removed = %v", rb.removed)
	}
	if _, operr := mc.opPermissionSavedRemove(context.Background(), json.RawMessage(`{"id":"nope"}`)); operr == nil {
		t.Error("an unknown id must fail")
	}
	if _, operr := mc.opPermissionSavedRemove(context.Background(), json.RawMessage(`{}`)); operr == nil || operr.Code != "invalid" {
		t.Errorf("no id: %v", operr)
	}
	var seen int
	for _, r := range auditRows(t, dir) {
		if r["action"] == "permission.saved.remove" && r["id"] == "sav_1" {
			seen++
		}
	}
	if seen != 1 {
		t.Errorf("audit rows for the removal = %d, want 1 (a failed removal is not one)", seen)
	}
}

// The contract: the link has exactly one write to permissions, and it only
// tightens. No op sets rules, a ceiling or a policy.
func TestNoOpWritesRules(t *testing.T) {
	mc, _, _ := newRuleMachine(t, policy.Default())
	for _, op := range []string{"permission.rules.set", "permission.setRules", "permission.ceiling", "policy.set", "session.setRules", "permission.saved.add"} {
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
		rb.layers = backend.RuleLayers{OpencodeSide: c.rules}
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
