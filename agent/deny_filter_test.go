package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/permrules"
	"galopin/internal/policy"
	"galopin/internal/sessions"
	"galopin/internal/workspaces"
)

// The Deny pre-filter (B1): in Deny mode the session's block says ask for the
// blanket names, and galopin itself rejects every ask from that root and its
// subagents before any card is shown. The ask is never materialised — no
// permission.asked envelope, no ring entry — and the tool call fails with the
// Deny message. Ask and Allow roots are untouched.

func denyMachine(t *testing.T, mode permrules.Action) (*machine, *ruleBackend, string) {
	t.Helper()
	mc, rb, dir := newRuleMachine(t, policy.Default())
	mc.installPermissions()
	rb.mu.Lock()
	if rb.sel == nil {
		rb.sel = map[string]permrules.Selector{}
	}
	rb.sel["s1"] = permrules.Selector{Mode: mode}
	rb.mu.Unlock()
	return mc, rb, dir
}

func waitReplies(t *testing.T, rb *ruleBackend, n int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		rb.mu.Lock()
		got := len(rb.replies)
		rb.mu.Unlock()
		if got >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d replies, have %d", n, got)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A root ask in Deny mode is rejected with the Deny message and never
// appended to the ring.
func TestDenyFilterRejectsARootAskWithNoCard(t *testing.T) {
	mc, rb, dir := denyMachine(t, permrules.Deny)
	askFor(mc, "per_1", "bash")
	waitReplies(t, rb, 1)
	rb.mu.Lock()
	d, msg := rb.replies[0], rb.messages[0]
	rb.mu.Unlock()
	if d != backend.DecisionReject {
		t.Errorf("reply = %s, want reject", d)
	}
	if msg != denyRejectMessage {
		t.Errorf("reply message = %q, want the Deny message", msg)
	}
	if n := mc.mat.PendingPermissions("s1"); n != 0 {
		t.Errorf("pending = %d, want 0: the ask must never be materialised", n)
	}
	var perms []map[string]any
	for _, r := range auditRows(t, dir) {
		if r["action"] == "permission" {
			perms = append(perms, r)
		}
	}
	if len(perms) != 1 {
		t.Fatalf("audit permission rows = %v, want exactly the rejection", perms)
	}
	row := perms[0]
	if row["decision"] != "reject" || row["by"] != "galopin" || row["session"] != "s1" || row["requestId"] != "per_1" {
		t.Errorf("audit row = %v, want decision reject by galopin", row)
	}
	if row["reason"] != denyRejectMessage {
		t.Errorf("audit reason = %v, want the Deny message", row["reason"])
	}
}

// A child ask whose root is on Deny is rejected the same way.
func TestDenyFilterRejectsAChildAsk(t *testing.T) {
	mc, rb, _ := denyMachine(t, permrules.Deny)
	ctx := context.Background()
	mc.mat.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/x", SessionID: "kid", Event: backend.Event{
		Kind: backend.EventSession, Session: &backend.Session{ID: "kid", ParentID: "s1"},
	}})
	mc.mat.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/x", SessionID: "kid", Event: backend.Event{
		Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: "per_k", SessionID: "kid", Tool: "edit", Patterns: []string{"a.go"}},
	}})
	waitReplies(t, rb, 1)
	rb.mu.Lock()
	d := rb.replies[0]
	rb.mu.Unlock()
	if d != backend.DecisionReject {
		t.Errorf("child reply = %s, want reject", d)
	}
	if n := mc.mat.PendingPermissions("kid"); n != 0 {
		t.Errorf("pending = %d, want 0", n)
	}
}

// Ask and Allow roots are left alone: the ask is materialised, nothing is
// answered, and the child-ask hook still fires for child asks.
func TestDenyFilterLeavesAskAndAllowRootsAlone(t *testing.T) {
	for _, mode := range []permrules.Action{permrules.Ask, permrules.Allow} {
		mc, rb, _ := denyMachine(t, mode)
		askFor(mc, "per_1", "bash")
		deadline := time.Now().Add(2 * time.Second)
		for {
			rb.mu.Lock()
			n := len(rb.replies)
			rb.mu.Unlock()
			if n > 0 {
				t.Fatalf("%s: the filter answered an ask it must leave alone", mode)
			}
			if time.Now().After(deadline) {
				break
			}
			time.Sleep(25 * time.Millisecond)
		}
		if n := mc.mat.PendingPermissions("s1"); n != 1 {
			t.Errorf("%s: pending = %d, want the materialised ask", mode, n)
		}
	}
}

// Switching a root to Deny rejects the asks already showing for it and its
// subagents: each goes out with DecisionReject + the Deny message, audited
// like rejectDenyAsk, and none is left pending.
func TestSwitchToDenyRejectsPendingAsks(t *testing.T) {
	mc, rb, dir := denyMachine(t, permrules.Allow)
	ctx := context.Background()
	askFor(mc, "per_1", "bash")
	mc.mat.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/x", SessionID: "kid", Event: backend.Event{
		Kind: backend.EventSession, Session: &backend.Session{ID: "kid", ParentID: "s1"},
	}})
	mc.mat.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/x", SessionID: "kid", Event: backend.Event{
		Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: "per_k", SessionID: "kid", Tool: "edit", Patterns: []string{"a.go"}},
	}})
	if n := mc.mat.PendingPermissions("s1") + mc.mat.PendingPermissions("kid"); n != 2 {
		t.Fatalf("pending = %d, want the two materialised asks", n)
	}
	if _, operr := mc.Handle(ctx, "session.setPermissionMode", mustJSONArgs(t, map[string]any{"sessionId": "s1", "mode": "deny"})); operr != nil {
		t.Fatalf("mode switch: %+v", operr)
	}
	waitReplies(t, rb, 2)
	rb.mu.Lock()
	defer rb.mu.Unlock()
	for i, d := range rb.replies {
		if d != backend.DecisionReject {
			t.Errorf("reply %d = %s, want reject", i, d)
		}
		if rb.messages[i] != denyRejectMessage {
			t.Errorf("reply %d message = %q, want the Deny message", i, rb.messages[i])
		}
	}
	if n := mc.mat.PendingPermissions("s1") + mc.mat.PendingPermissions("kid"); n != 0 {
		t.Errorf("pending = %d, want nothing left", n)
	}
	var rejects int
	for _, r := range auditRows(t, dir) {
		if r["action"] == "permission" && r["decision"] == "reject" && r["by"] == "galopin" && r["reason"] == denyRejectMessage {
			rejects++
		}
	}
	if rejects != 2 {
		t.Errorf("galopin Deny rejections in the audit = %d, want 2 (root + child)", rejects)
	}
}

// A backend whose transcript seeds one pending ask: the shape a galopin
// restart finds in opencode's history for a session whose ask was showing.
type seededRuleBackend struct {
	*ruleBackend
	perms []backend.PermissionRequest
}

func (s *seededRuleBackend) Transcript(context.Context, string, string) (backend.Transcript, error) {
	return backend.Transcript{Permissions: s.perms}, nil
}

// A sync that seeds a Deny root sweeps its seeded pending asks the same way
// a mode switch does: DecisionReject + the Deny message, audited like
// rejectDenyAsk, none left pending.
func TestSyncSweepRejectsSeededDenyAsk(t *testing.T) {
	stateDir := t.TempDir()
	reg, err := workspaces.Load(filepath.Join(stateDir, "workspaces.json"))
	if err != nil {
		t.Fatal(err)
	}
	ws, err := reg.Create("ws", t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	rb := &seededRuleBackend{
		ruleBackend: &ruleBackend{fakeBackend: &fakeBackend{}},
		perms: []backend.PermissionRequest{
			{ID: "per_seed", SessionID: "s1", Tool: "bash", Patterns: []string{"rm -rf /"}},
		},
	}
	mat := sessions.New(rb, policy.Default())
	mc := newMachine(reg, rb, mat, policy.Default())
	audit, err := newAuditLogger(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = audit.Close() })
	mc.AttachAudit(audit)
	mc.installPermissions()
	rb.mu.Lock()
	rb.sel = map[string]permrules.Selector{"s1": {Mode: permrules.Deny}}
	rb.mu.Unlock()
	mc.trackSession(ws, backend.Session{ID: "s1"})

	if _, operr := mc.Handle(context.Background(), "session.sync", mustJSONArgs(t, map[string]any{"sessionId": "s1"})); operr != nil {
		t.Fatalf("session.sync: %+v", operr)
	}
	waitReplies(t, rb.ruleBackend, 1)
	rb.mu.Lock()
	defer rb.mu.Unlock()
	if rb.replies[0] != backend.DecisionReject {
		t.Errorf("reply = %s, want reject", rb.replies[0])
	}
	if rb.messages[0] != denyRejectMessage {
		t.Errorf("reply message = %q, want the Deny message", rb.messages[0])
	}
	if n := mc.mat.PendingPermissions("s1"); n != 0 {
		t.Errorf("pending = %d, want the seeded ask swept", n)
	}
	var rejects int
	for _, r := range auditRows(t, stateDir) {
		if r["action"] == "permission" && r["decision"] == "reject" && r["by"] == "galopin" && r["reason"] == denyRejectMessage {
			rejects++
		}
	}
	if rejects != 1 {
		t.Errorf("galopin Deny rejections in the audit = %d, want 1", rejects)
	}
}

// A gp_ ask from a Deny root is consumed too: under Deny nothing runs without
// a card, and there are no cards.
func TestDenyFilterConsumesGalopinAsks(t *testing.T) {
	mc, rb, _ := denyMachine(t, permrules.Deny)
	mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{
		WorkspaceDir: "/x", SessionID: "s1", Event: backend.Event{
			Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: "gp_1", SessionID: "s1", Tool: "session_spawn", Patterns: []string{"*"}},
		}})
	waitReplies(t, rb, 1)
	if n := mc.mat.PendingPermissions("s1"); n != 0 {
		t.Errorf("pending = %d, want 0", n)
	}
}

// The two hooks cannot answer the same request: answerChildAsk never touches
// a Deny root (the filter owns those), and the filter never touches a root
// answerChildAsk could allow.
func TestAnswerChildAskSkipsDenyRoots(t *testing.T) {
	mc, rb, _ := denyMachine(t, permrules.Deny)
	mc.answerChildAsk("/x", backend.PermissionRequest{ID: "per_1", SessionID: "s1", Tool: "bash", Patterns: []string{"ls"}})
	rb.mu.Lock()
	n := len(rb.replies)
	rb.mu.Unlock()
	if n != 0 {
		t.Errorf("answerChildAsk answered under a Deny root: the filter owns those")
	}
	if !strings.HasPrefix(denyRejectMessage, "This session is set to Deny:") {
		t.Errorf("the Deny message changed shape: %q", denyRejectMessage)
	}
}
