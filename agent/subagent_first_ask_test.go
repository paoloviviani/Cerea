package main

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/decide"
	"galopin/internal/permrules"
	"galopin/internal/policy"
	"galopin/internal/sessions"
	"galopin/internal/workspaces"
)

// A subagent is decided by its ROOT's word from its very first ask, even when
// that ask reaches galopin before the session tree edge does (its session event
// not seen yet: a restart, a cut event stream, a late event). The ask is held
// while the session's record is read, off the event path.

var errNoRecord = errors.New("no such session")

// treeBackend is a ruleBackend that answers GetSession from a table, as opencode
// would, failing the first failFirst reads of each id.
type treeBackend struct {
	*ruleBackend
	tmu       sync.Mutex
	records   map[string]backend.Session
	gets      map[string]int
	failFirst int
}

func (b *treeBackend) GetSession(_ context.Context, _, id string) (backend.Session, error) {
	b.tmu.Lock()
	defer b.tmu.Unlock()
	if b.gets == nil {
		b.gets = map[string]int{}
	}
	b.gets[id]++
	if s, ok := b.records[id]; ok && b.gets[id] > b.failFirst {
		return s, nil
	}
	return backend.Session{}, errNoRecord
}

func (b *treeBackend) getCount(id string) int {
	b.tmu.Lock()
	defer b.tmu.Unlock()
	return b.gets[id]
}

// treeMachine is a machine with a root session s1 in the given mode, and the
// records "kid" (a child of s1) and "grandkid" (a child of kid) readable.
func treeMachine(t *testing.T, mode permrules.Action, pol policy.Policy) (*machine, *treeBackend) {
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
	tb := &treeBackend{ruleBackend: &ruleBackend{fakeBackend: &fakeBackend{}}, records: map[string]backend.Session{
		"kid":      {ID: "kid", ParentID: "s1"},
		"grandkid": {ID: "grandkid", ParentID: "kid"},
		"s1":       {ID: "s1"},
	}}
	tb.sel = map[string]permrules.Selector{"s1": {Mode: mode}}
	mat := sessions.New(tb, pol)
	mc := newMachine(reg, tb, mat, pol)
	mc.treeWait = 600 * time.Millisecond
	audit, err := newAuditLogger(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = audit.Close() })
	mc.AttachAudit(audit)
	mc.trackSession(ws, backend.Session{ID: "s1"})
	mc.installPermissions()
	return mc, tb
}

func askFrom(mc *machine, id, sess string) {
	mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{
		WorkspaceDir: "/x", SessionID: sess,
		Event: backend.Event{Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{
			ID: id, SessionID: sess, Tool: "bash", Patterns: []string{"touch a.txt"},
			Metadata: map[string]any{"command": "touch a.txt"}}},
	})
}

func (b *treeBackend) answers() ([]backend.Decision, []string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]backend.Decision(nil), b.replies...), append([]string(nil), b.messages...)
}

// waitPending waits for n cards for sess.
func waitPending(t *testing.T, mc *machine, sess string, n int) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); mc.mat.PendingPermissions(sess) != n; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("pending cards for %s = %d, want %d", sess, mc.mat.PendingPermissions(sess), n)
		}
	}
}

// settle gives a decision that should NOT come the time it would need.
func settle() { time.Sleep(300 * time.Millisecond) }

func TestSubagentFirstAskBeforeItsParentEdgeRunsUnderAnAllowRoot(t *testing.T) {
	mc, tb := treeMachine(t, permrules.Allow, policy.Default())
	askFrom(mc, "per_k1", "kid")
	waitReplies(t, tb.ruleBackend, 1)
	if d, _ := tb.answers(); d[0] != backend.DecisionOnce {
		t.Errorf("reply = %s, want once", d[0])
	}
	if n := mc.mat.PendingPermissions("kid"); n != 0 {
		t.Errorf("pending = %d, want no card", n)
	}
	if got := mc.mat.RootOf("kid"); got != "s1" {
		t.Errorf("root of kid = %q, want s1: the record's edge is learned", got)
	}
}

func TestSubagentFirstAskUnderAnAskRootStillAsks(t *testing.T) {
	mc, tb := treeMachine(t, permrules.Ask, policy.Default())
	askFrom(mc, "per_k1", "kid")
	waitPending(t, mc, "kid", 1)
	settle()
	if d, _ := tb.answers(); len(d) != 0 {
		t.Errorf("replies = %v, want none: the card is the person's", d)
	}
}

func TestSubagentFirstAskUnderAPlanRootIsRefused(t *testing.T) {
	mc, tb := treeMachine(t, permrules.Deny, policy.Default())
	askFrom(mc, "per_k1", "kid")
	waitReplies(t, tb.ruleBackend, 1)
	d, msg := tb.answers()
	if d[0] != backend.DecisionReject || msg[0] != decide.PlanReason {
		t.Errorf("reply = %s %q, want the Plan refusal", d[0], msg[0])
	}
	if n := mc.mat.PendingPermissions("kid"); n != 0 {
		t.Errorf("pending = %d, want no card under Plan", n)
	}
}

func TestSubagentFirstAskKeepsTheMachinesDenyListUnderAnAllowRoot(t *testing.T) {
	mc, tb := treeMachine(t, permrules.Allow, policyWithDeny("command"))
	askFrom(mc, "per_k1", "kid")
	waitReplies(t, tb.ruleBackend, 1)
	if d, _ := tb.answers(); d[0] != backend.DecisionReject {
		t.Errorf("reply = %s, want the machine's deny to refuse it", d[0])
	}
}

func TestGrandchildFirstAskIsDecidedByTheRoot(t *testing.T) {
	mc, tb := treeMachine(t, permrules.Allow, policy.Default())
	askFrom(mc, "per_g1", "grandkid")
	waitReplies(t, tb.ruleBackend, 1)
	if d, _ := tb.answers(); d[0] != backend.DecisionOnce {
		t.Errorf("reply = %s, want once", d[0])
	}
	if got := mc.mat.RootOf("grandkid"); got != "s1" {
		t.Errorf("root of grandkid = %q, want s1", got)
	}
}

func TestSubagentRecordReadFailsATimeAndIsRetried(t *testing.T) {
	mc, tb := treeMachine(t, permrules.Allow, policy.Default())
	tb.failFirst = 2
	askFrom(mc, "per_k1", "kid")
	waitReplies(t, tb.ruleBackend, 1)
	if d, _ := tb.answers(); d[0] != backend.DecisionOnce {
		t.Errorf("reply = %s, want once after the retries", d[0])
	}
}

// When the parent really cannot be determined the ask fails toward a person,
// once, and the next ask from that session is not held again.
func TestSubagentWithNoReadableRecordAsksAfterTheBound(t *testing.T) {
	mc, tb := treeMachine(t, permrules.Allow, policy.Default())
	delete(tb.records, "kid")
	start := time.Now()
	askFrom(mc, "per_k1", "kid")
	waitPending(t, mc, "kid", 1)
	if took := time.Since(start); took < 300*time.Millisecond {
		t.Errorf("the card came after %s: the ask was not held for the bound", took)
	}
	if d, _ := tb.answers(); len(d) != 0 {
		t.Errorf("replies = %v, want none", d)
	}
	reads := tb.getCount("kid")
	askFrom(mc, "per_k2", "kid")
	waitPending(t, mc, "kid", 2)
	if got := tb.getCount("kid"); got != reads {
		t.Errorf("record reads = %d after the second ask, want %d: not held twice", got, reads)
	}
}

// A child whose session event arrived is decided straight away, with no read.
func TestSubagentWithAKnownEdgeIsNotHeld(t *testing.T) {
	mc, tb := treeMachine(t, permrules.Allow, policy.Default())
	mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{WorkspaceDir: "/x", SessionID: "kid", Event: backend.Event{
		Kind: backend.EventSession, Session: &backend.Session{ID: "kid", ParentID: "s1"},
	}})
	askFrom(mc, "per_k1", "kid")
	waitReplies(t, tb.ruleBackend, 1)
	if n := tb.getCount("kid"); n != 0 {
		t.Errorf("record reads = %d, want none for a known child", n)
	}
}

// Asks that arrive together while the record is read are all decided, one read.
func TestSubagentAsksHeldTogetherAreAllDecided(t *testing.T) {
	mc, tb := treeMachine(t, permrules.Allow, policy.Default())
	tb.failFirst = 1
	for _, id := range []string{"per_a", "per_b", "per_c"} {
		askFrom(mc, id, "kid")
	}
	waitReplies(t, tb.ruleBackend, 3)
	if n := mc.mat.PendingPermissions("kid"); n != 0 {
		t.Errorf("pending = %d, want none", n)
	}
}
