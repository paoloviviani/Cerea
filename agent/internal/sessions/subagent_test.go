package sessions

import (
	"context"
	"testing"

	"galopin/internal/backend"
	"galopin/internal/policy"
)

// The subagent contract (PROTOCOL.md §5 "event" frame, §7): every envelope
// carries its root, a child's permission.asked reaches the root's watcher
// with that root tagged, and auto-accept follows the NEAREST ancestor with an
// explicit setting (on or off) — unless the machine does not allow responders.

func allowPolicy() policy.Policy {
	return policy.Policy{Permission: policy.Permission{Responders: policy.TerminalAllowed}}
}

func askEvent(reqID, sessionID string) backend.Event {
	return backend.Event{
		Kind:    backend.EventPermissionAsked,
		Request: &backend.PermissionRequest{ID: reqID, SessionID: sessionID, Tool: "bash", Title: "run"},
	}
}

func syncEvents(t *testing.T, m *Materializer, sessionID string) []Envelope {
	t.Helper()
	res, err := m.Sync(context.Background(), sessionID, m.Epoch(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if res.Snapshot != nil {
		t.Fatalf("expected an events tail for %s, got a snapshot", sessionID)
	}
	return res.Events
}

// TestChildPermissionCarriesRoot pins that a child's permission.asked is
// forwarded (not swallowed) with rootSessionId naming the top-level
// ancestor — the link Cerea's bridge subscribes by.
func TestChildPermissionCarriesRoot(t *testing.T) {
	fb := newFakeBackend()
	m := New(fb, allowPolicy())
	ctx := context.Background()
	m.Track("/ws", backend.Session{ID: "parent"})
	m.Track("/ws", backend.Session{ID: "child", ParentID: "parent"})

	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "child", Event: askEvent("perm1", "child")})

	if len(fb.replies) != 0 {
		t.Fatalf("backend replies = %+v, want none (nothing has auto-accept on)", fb.replies)
	}
	events := syncEvents(t, m, "child")
	if len(events) != 1 || events[0].Event.Kind != backend.EventPermissionAsked {
		t.Fatalf("events = %+v, want the ask forwarded", events)
	}
	if events[0].RootSessionID != "parent" {
		t.Errorf("rootSessionId = %q, want parent", events[0].RootSessionID)
	}
	if m.PendingPermissions("child") != 1 {
		t.Errorf("pending permissions = %d, want 1", m.PendingPermissions("child"))
	}
}

// TestChildWithNoSettingFollowsParentOn is the Amendment: a subagent nobody
// touched is answered by the responder under its parent's setting — otherwise
// every child would re-prompt a person who put the parent on auto-accept so
// as not to be asked.
func TestChildWithNoSettingFollowsParentOn(t *testing.T) {
	fb := newFakeBackend()
	m := New(fb, allowPolicy())
	ctx := context.Background()
	m.Track("/ws", backend.Session{ID: "parent"})
	m.Track("/ws", backend.Session{ID: "child", ParentID: "parent"})
	if err := m.SetAutoAccept("parent", true); err != nil {
		t.Fatal(err)
	}

	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "child", Event: askEvent("perm1", "child")})

	if len(fb.replies) != 1 || fb.replies[0].sessionID != "child" || fb.replies[0].requestID != "perm1" || fb.replies[0].decision != backend.DecisionOnce {
		t.Fatalf("backend replies = %+v, want one 'once' reply to the child's perm1", fb.replies)
	}
	if events := syncEvents(t, m, "child"); len(events) != 0 {
		t.Fatalf("events = %+v, want none (no card, no replied)", events)
	}
	if m.PendingPermissions("child") != 0 {
		t.Errorf("pending permissions = %d, want 0", m.PendingPermissions("child"))
	}
	if !m.AutoAccept("child") {
		t.Error("the child's effective auto-accept must read on")
	}
}

// A child explicitly off overrides a parent that is on.
func TestChildExplicitlyOffOverridesParentOn(t *testing.T) {
	fb := newFakeBackend()
	m := New(fb, allowPolicy())
	ctx := context.Background()
	m.Track("/ws", backend.Session{ID: "parent"})
	m.Track("/ws", backend.Session{ID: "child", ParentID: "parent"})
	if err := m.SetAutoAccept("parent", true); err != nil {
		t.Fatal(err)
	}
	if err := m.SetAutoAccept("child", false); err != nil {
		t.Fatal(err)
	}

	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "child", Event: askEvent("perm1", "child")})

	if len(fb.replies) != 0 {
		t.Fatalf("backend replies = %+v, want none: the child is explicitly off", fb.replies)
	}
	events := syncEvents(t, m, "child")
	if len(events) != 1 || events[0].Event.Kind != backend.EventPermissionAsked || events[0].RootSessionID != "parent" {
		t.Fatalf("events = %+v, want the ask forwarded, rooted at parent", events)
	}
	if m.AutoAccept("child") {
		t.Error("the child's effective auto-accept must read off")
	}
	if !m.AutoAccept("parent") {
		t.Error("the parent stays on")
	}
}

// The nearest explicit ancestor decides, not the root: a grandchild under a
// mid-level session set off is NOT answered even though the root is on, and
// one under a mid-level set on is, even though the root is off.
func TestNearestExplicitAncestorDecides(t *testing.T) {
	ctx := context.Background()
	build := func(root, mid *bool) (*Materializer, *fakeBackend) {
		fb := newFakeBackend()
		m := New(fb, allowPolicy())
		m.Track("/ws", backend.Session{ID: "root"})
		m.Track("/ws", backend.Session{ID: "mid", ParentID: "root"})
		m.Track("/ws", backend.Session{ID: "leaf", ParentID: "mid"})
		if root != nil {
			if err := m.SetAutoAccept("root", *root); err != nil {
				t.Fatal(err)
			}
		}
		if mid != nil {
			if err := m.SetAutoAccept("mid", *mid); err != nil {
				t.Fatal(err)
			}
		}
		return m, fb
	}
	on, off := true, false
	for _, c := range []struct {
		name      string
		root, mid *bool
		answered  bool
	}{
		{"root on, mid unset", &on, nil, true},
		{"root on, mid off", &on, &off, false},
		{"root off, mid on", &off, &on, true},
		{"root on explicitly off below, then nothing", &on, &off, false},
		{"nothing set", nil, nil, false},
		{"root off, mid unset", &off, nil, false},
	} {
		m, fb := build(c.root, c.mid)
		m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "leaf", Event: askEvent("perm1", "leaf")})
		if got := len(fb.replies) == 1; got != c.answered {
			t.Errorf("%s: answered = %v, want %v (replies %+v)", c.name, got, c.answered, fb.replies)
		}
	}
}

// The machine's veto: with no responders allowed nothing can turn auto-accept
// on, so the child's ask is forwarded untouched.
func TestChildAutoAcceptVetoedByMachine(t *testing.T) {
	fb := newFakeBackend()
	m := New(fb, policy.Default()) // responders: denied
	ctx := context.Background()
	m.Track("/ws", backend.Session{ID: "parent"})
	m.Track("/ws", backend.Session{ID: "child", ParentID: "parent"})
	if err := m.SetAutoAccept("parent", true); err != ErrAutoAcceptForbidden {
		t.Fatalf("err = %v, want ErrAutoAcceptForbidden", err)
	}
	// Turning it off is always allowed.
	if err := m.SetAutoAccept("parent", false); err != nil {
		t.Fatalf("turning off: %v", err)
	}

	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "child", Event: askEvent("perm1", "child")})

	if len(fb.replies) != 0 {
		t.Fatalf("backend replies = %+v, want none when responders are denied", fb.replies)
	}
	events := syncEvents(t, m, "child")
	if len(events) != 1 || events[0].Event.Kind != backend.EventPermissionAsked {
		t.Fatalf("events = %+v, want the ask forwarded", events)
	}
}

// A policy edited down after a session was set on is still the machine's say:
// the responder checks the machine at answer time, not only at set time.
func TestResponderChecksTheMachineAtAnswerTime(t *testing.T) {
	fb := newFakeBackend()
	m := New(fb, allowPolicy())
	m.Track("/ws", backend.Session{ID: "s"})
	if err := m.SetAutoAccept("s", true); err != nil {
		t.Fatal(err)
	}
	m.policy = policy.Default()
	m.ApplyBackendEvent(context.Background(), backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "s", Event: askEvent("perm1", "s")})
	if len(fb.replies) != 0 {
		t.Fatalf("replies = %+v, want none", fb.replies)
	}
}

// Galopin's own approvals are never answered by the responder, and neither is a
// question: auto-accept's scope is tool asks.
func TestResponderLeavesGalopinApprovalsAlone(t *testing.T) {
	fb := newFakeBackend()
	m := New(fb, allowPolicy())
	ctx := context.Background()
	m.Track("/ws", backend.Session{ID: "parent"})
	m.Track("/ws", backend.Session{ID: "child", ParentID: "parent"})
	if err := m.SetAutoAccept("parent", true); err != nil {
		t.Fatal(err)
	}
	m.ApplyBackendEvent(ctx, backend.BackendEvent{
		WorkspaceDir: "/ws", SessionID: "child",
		Event: backend.Event{Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{
			ID: "gp_1", SessionID: "child", Tool: "session_spawn", Metadata: map[string]any{"galopin": true},
		}},
	})
	m.ApplyBackendEvent(ctx, backend.BackendEvent{
		WorkspaceDir: "/ws", SessionID: "child",
		Event: backend.Event{Kind: backend.EventQuestionAsked, QuestionRequestID: "q1", Questions: []backend.QuestionItem{{Question: "which?"}}},
	})
	if len(fb.replies) != 0 {
		t.Fatalf("backend replies = %+v, want none for a gp_ approval or a question", fb.replies)
	}
	events := syncEvents(t, m, "child")
	if len(events) != 2 || events[0].Event.Kind != backend.EventPermissionAsked || events[1].Event.Kind != backend.EventQuestionAsked {
		t.Fatalf("events = %+v, want both forwarded", events)
	}
}

// The responder's reply is always "once": it never creates an "always".
func TestResponderNeverAnswersAlways(t *testing.T) {
	fb := newFakeBackend()
	m := New(fb, allowPolicy())
	m.Track("/ws", backend.Session{ID: "s"})
	if err := m.SetAutoAccept("s", true); err != nil {
		t.Fatal(err)
	}
	req := backend.PermissionRequest{ID: "perm1", SessionID: "s", Tool: "edit", Always: []string{"*"}}
	m.ApplyBackendEvent(context.Background(), backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "s", Event: backend.Event{Kind: backend.EventPermissionAsked, Request: &req}})
	if len(fb.replies) != 1 || fb.replies[0].decision != backend.DecisionOnce {
		t.Fatalf("replies = %+v, want exactly one 'once'", fb.replies)
	}
}

// TestParentLearnedFromTaskPart pins the parent-side learning path: the
// parent's task tool part names the child it spawned, so the tree edge
// exists before the child's own first event ever arrives.
func TestParentLearnedFromTaskPart(t *testing.T) {
	fb := newFakeBackend()
	m := New(fb, allowPolicy())
	ctx := context.Background()
	m.Track("/ws", backend.Session{ID: "parent"})
	if err := m.SetAutoAccept("parent", true); err != nil {
		t.Fatal(err)
	}

	// The parent spawns the child; the backend reports the spawn on the call.
	m.ApplyBackendEvent(ctx, backend.BackendEvent{
		WorkspaceDir: "/ws", SessionID: "parent",
		Event: backend.Event{
			Kind: backend.EventPart,
			Part: &backend.Part{
				ID: "p1", MessageID: "m1", Role: "assistant", Type: backend.PartTool,
				CallID: "call_task", Tool: "task", ToolStatus: backend.ToolRunning,
				SubtaskSessionID: "child",
			},
		},
	})
	// The child's ask arrives with no prior Track and no session event.
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "child", Event: askEvent("perm1", "child")})

	if len(fb.replies) != 1 || fb.replies[0].sessionID != "child" {
		t.Fatalf("backend replies = %+v, want the inherited auto-reply to the child", fb.replies)
	}
	if got := m.RootOf("child"); got != "parent" {
		t.Errorf("RootOf(child) = %q, want parent", got)
	}
	// A later event of the child's own is rooted at the parent too.
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "child", Event: backend.Event{Kind: backend.EventStatus, Status: backend.StatusBusy}})
	events := syncEvents(t, m, "child")
	if len(events) != 1 || events[0].RootSessionID != "parent" {
		t.Fatalf("events = %+v, want one envelope rooted at parent", events)
	}
}

// TestParentLearnedFromSessionEvent pins the child-side learning path: a
// session event carrying ParentID links a child the materializer never
// Tracked.
func TestParentLearnedFromSessionEvent(t *testing.T) {
	m := New(newFakeBackend(), allowPolicy())
	ctx := context.Background()
	m.Track("/ws", backend.Session{ID: "parent"})

	m.ApplyBackendEvent(ctx, backend.BackendEvent{
		WorkspaceDir: "/ws", SessionID: "child",
		Event: backend.Event{
			Kind:    backend.EventSession,
			Session: &backend.Session{ID: "child", ParentID: "parent", Status: backend.StatusBusy},
		},
	})
	if got := m.RootOf("child"); got != "parent" {
		t.Errorf("RootOf(child) = %q, want parent", got)
	}
	if got := m.RootOf("parent"); got != "parent" {
		t.Errorf("RootOf(parent) = %q, want itself for a top-level session", got)
	}
}

// TestChildSummaryCountsChildrenAndWaitingDescendants pins the list row's
// numbers: direct children, those mid-turn, and descendants at any depth
// waiting on a permission reply; nil for a session with no child.
func TestChildSummaryCountsChildrenAndWaitingDescendants(t *testing.T) {
	fb := newFakeBackend()
	m := New(fb, policy.Default())
	ctx := context.Background()
	m.Track("/ws", backend.Session{ID: "parent"})
	m.Track("/ws", backend.Session{ID: "a", ParentID: "parent", Status: backend.StatusBusy})
	m.Track("/other", backend.Session{ID: "b", ParentID: "parent", Status: backend.StatusIdle})
	m.Track("/ws", backend.Session{ID: "grandchild", ParentID: "a"})
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "grandchild", Event: askEvent("perm1", "grandchild")})

	sum := m.ChildSummary("parent")
	if sum == nil || sum.Children != 2 || sum.Running != 1 || sum.Waiting != 1 {
		t.Fatalf("parent summary = %+v, want 2 children, 1 running, 1 waiting", sum)
	}
	if got := m.ChildSummary("a"); got == nil || got.Children != 1 || got.Waiting != 1 {
		t.Fatalf("a summary = %+v, want 1 child waiting", got)
	}
	if got := m.ChildSummary("b"); got != nil {
		t.Fatalf("b summary = %+v, want nil (no children)", got)
	}
	if got := m.RootOf("grandchild"); got != "parent" {
		t.Fatalf("root of grandchild = %q, want parent", got)
	}
}
