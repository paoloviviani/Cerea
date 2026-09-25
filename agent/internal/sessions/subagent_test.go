package sessions

import (
	"context"
	"testing"

	"galopin/internal/backend"
	"galopin/internal/policy"
)

// The subagent contract (PROTOCOL.md §5 "event" frame, §7): every envelope
// carries its root, a child's permission.asked reaches the root's watcher
// with that root tagged, and auto-accept is inherited up the tree — unless
// the machine policy vetoes it, or the ask is a handoff approval.

func allowPolicy() policy.Policy { return policy.Policy{AutoAccept: policy.AutoAcceptAllowed} }

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

// TestChildAutoAcceptInheritedFromParent pins that a child without its own
// flag auto-replies when its parent has auto-accept on and the policy
// allows it.
func TestChildAutoAcceptInheritedFromParent(t *testing.T) {
	fb := newFakeBackend()
	m := New(fb, allowPolicy())
	ctx := context.Background()
	m.Track("/ws", backend.Session{ID: "parent"})
	m.Track("/ws", backend.Session{ID: "child", ParentID: "parent"})
	if err := m.SetAutoAccept("parent", true); err != nil {
		t.Fatal(err)
	}

	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "child", Event: askEvent("perm1", "child")})

	if len(fb.replies) != 1 || fb.replies[0].sessionID != "child" || fb.replies[0].requestID != "perm1" {
		t.Fatalf("backend replies = %+v, want one 'once' reply to the child's perm1", fb.replies)
	}
	events := syncEvents(t, m, "child")
	if len(events) != 1 || events[0].Event.Kind != backend.EventPermissionReplied || events[0].Event.By != "auto" {
		t.Fatalf("events = %+v, want exactly one permission.replied by=auto", events)
	}
	if events[0].RootSessionID != "parent" {
		t.Errorf("rootSessionId = %q, want parent", events[0].RootSessionID)
	}
	if m.PendingPermissions("child") != 0 {
		t.Errorf("pending permissions = %d, want 0 after inherited auto-accept", m.PendingPermissions("child"))
	}
}

// TestChildAutoAcceptInheritedFromGrandparent pins the walk goes all the
// way to the root, not just one level up.
func TestChildAutoAcceptInheritedFromGrandparent(t *testing.T) {
	fb := newFakeBackend()
	m := New(fb, allowPolicy())
	ctx := context.Background()
	m.Track("/ws", backend.Session{ID: "root"})
	m.Track("/ws", backend.Session{ID: "mid", ParentID: "root"})
	m.Track("/ws", backend.Session{ID: "leaf", ParentID: "mid"})
	if err := m.SetAutoAccept("root", true); err != nil {
		t.Fatal(err)
	}

	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "leaf", Event: askEvent("perm1", "leaf")})

	if len(fb.replies) != 1 || fb.replies[0].sessionID != "leaf" {
		t.Fatalf("backend replies = %+v, want one reply to the leaf's ask", fb.replies)
	}
	events := syncEvents(t, m, "leaf")
	if len(events) != 1 || events[0].Event.Kind != backend.EventPermissionReplied {
		t.Fatalf("events = %+v, want the auto reply", events)
	}
	if events[0].RootSessionID != "root" {
		t.Errorf("rootSessionId = %q, want root", events[0].RootSessionID)
	}
}

// TestChildAutoAcceptVetoedByPolicy pins the machine's veto wins over an
// inherited flag: under a denied policy nothing can turn auto-accept on,
// so the child's ask is forwarded untouched.
func TestChildAutoAcceptVetoedByPolicy(t *testing.T) {
	fb := newFakeBackend()
	m := New(fb, policy.Default()) // autoAccept: denied
	ctx := context.Background()
	m.Track("/ws", backend.Session{ID: "parent"})
	m.Track("/ws", backend.Session{ID: "child", ParentID: "parent"})
	if err := m.SetAutoAccept("parent", true); err != ErrAutoAcceptForbidden {
		t.Fatalf("err = %v, want ErrAutoAcceptForbidden", err)
	}

	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "child", Event: askEvent("perm1", "child")})

	if len(fb.replies) != 0 {
		t.Fatalf("backend replies = %+v, want none under a denied policy", fb.replies)
	}
	events := syncEvents(t, m, "child")
	if len(events) != 1 || events[0].Event.Kind != backend.EventPermissionAsked {
		t.Fatalf("events = %+v, want the ask forwarded", events)
	}
}

// TestHandoffApprovalNeverAutoAccepted pins that a handoff approval is
// forwarded even when the parent has auto-accept on and the policy allows
// it — moving work across a trust boundary always needs a person.
func TestHandoffApprovalNeverAutoAccepted(t *testing.T) {
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
		Event: backend.Event{
			Kind:    backend.EventPermissionAsked,
			Request: &backend.PermissionRequest{ID: "perm-h", SessionID: "child", Tool: "handoff", Title: "hand off"},
		},
	})

	if len(fb.replies) != 0 {
		t.Fatalf("backend replies = %+v, want none for a handoff approval", fb.replies)
	}
	events := syncEvents(t, m, "child")
	if len(events) != 1 || events[0].Event.Kind != backend.EventPermissionAsked {
		t.Fatalf("events = %+v, want the handoff ask forwarded", events)
	}
	if m.PendingPermissions("child") != 1 {
		t.Errorf("pending permissions = %d, want 1", m.PendingPermissions("child"))
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
