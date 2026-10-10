package sessions

import (
	"context"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/policy"
)

// The subagent contract (PROTOCOL.md §5 "event" frame, §7): every envelope
// carries its root, a child's permission.asked reaches the root's watcher
// with that root tagged. Nothing answers an ask for a person here.

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
	m := New(fb, policy.Default())
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

// TestParentLearnedFromTaskPart pins the parent-side learning path: the
// parent's task tool part names the child it spawned, so the tree edge
// exists before the child's own first event ever arrives.
func TestParentLearnedFromTaskPart(t *testing.T) {
	fb := newFakeBackend()
	m := New(fb, policy.Default())
	ctx := context.Background()
	m.Track("/ws", backend.Session{ID: "parent"})

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

	if len(fb.replies) != 0 {
		t.Fatalf("backend replies = %+v, want none: nothing answers a child's ask for a person", fb.replies)
	}
	if got := m.RootOf("child"); got != "parent" {
		t.Errorf("RootOf(child) = %q, want parent", got)
	}
	// A later event of the child's own is rooted at the parent too.
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "child", Event: backend.Event{Kind: backend.EventStatus, Status: backend.StatusBusy}})
	events := syncEvents(t, m, "child")
	if len(events) != 2 || events[0].RootSessionID != "parent" || events[1].RootSessionID != "parent" {
		t.Fatalf("events = %+v, want the ask and the status, both rooted at parent", events)
	}
}

// TestParentLearnedFromSessionEvent pins the child-side learning path: a
// session event carrying ParentID links a child the materializer never
// Tracked.
func TestParentLearnedFromSessionEvent(t *testing.T) {
	m := New(newFakeBackend(), policy.Default())
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

// OnChild is told of a subagent a live event reveals — from the child's own
// session event or from the parent's task call — once, and not of one a startup
// listing names.
func TestOnChildFiresForLiveChildrenOnly(t *testing.T) {
	m := New(newFakeBackend(), policy.Default())
	var got []string
	m.OnChild(func(dir, id string) { got = append(got, dir+":"+id) })
	ctx := context.Background()
	m.Track("/ws", backend.Session{ID: "parent"})
	m.Track("/ws", backend.Session{ID: "old", ParentID: "parent"})
	m.Track("/ws", backend.Session{ID: "old"}) // a second listing naming no parent is no news either
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "old", Event: backend.Event{Kind: backend.EventStatus, Status: backend.StatusIdle}})
	if len(got) != 0 {
		t.Fatalf("a startup child fired the hook: %v", got)
	}

	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "kid", Event: backend.Event{
		Kind: backend.EventSession, Session: &backend.Session{ID: "kid", ParentID: "parent"},
	}})
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "kid", Event: backend.Event{
		Kind: backend.EventSession, Session: &backend.Session{ID: "kid", ParentID: "parent"},
	}})
	if len(got) != 1 || got[0] != "/ws:kid" {
		t.Fatalf("hook calls = %v, want exactly /ws:kid once", got)
	}
}

func TestChildAgentIsReadFromTheParentsTaskCall(t *testing.T) {
	m := New(newFakeBackend(), policy.Default())
	ctx := context.Background()
	m.Track("/ws", backend.Session{ID: "parent"})
	if got := m.ChildAgent("kid"); got != "" {
		t.Fatalf("an unknown child's agent = %q", got)
	}
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "parent", Event: backend.Event{
		Kind: backend.EventPart,
		Part: &backend.Part{
			ID: "p1", MessageID: "m1", Role: "assistant", Type: backend.PartTool, CallID: "c", Tool: "task",
			ToolStatus: backend.ToolRunning, SubtaskSessionID: "kid", Input: map[string]any{"subagent_type": "explore"},
		},
	}})
	if got := m.ChildAgent("kid"); got != "explore" {
		t.Errorf("ChildAgent = %q, want explore", got)
	}
}

// ReconcileChildren drops the edges whose child the backend's /children
// answer no longer has, so ChildSummary counts only children opencode still
// has — a deleted subagent must stop being counted. The dropped child's own
// transcript state is kept.
func TestReconcileChildrenDropsDeletedEdges(t *testing.T) {
	m := New(newFakeBackend(), policy.Default())
	m.Track("/ws", backend.Session{ID: "parent"})
	m.Track("/ws", backend.Session{ID: "a", ParentID: "parent"})
	m.Track("/ws", backend.Session{ID: "b", ParentID: "parent"})
	// Both edges were learned long before this reconcile's answer.
	m.mu.Lock()
	m.sessions["a"].parentSince = time.Now().Add(-2 * spawnEdgeGrace)
	m.sessions["b"].parentSince = time.Now().Add(-2 * spawnEdgeGrace)
	m.mu.Unlock()

	m.ReconcileChildren("parent", []string{"a"})

	sum := m.ChildSummary("parent")
	if sum == nil || sum.Children != 1 {
		t.Fatalf("parent summary = %+v, want 1 child", sum)
	}
	if got := m.RootOf("b"); got != "b" {
		t.Errorf("RootOf(b) = %q, want b itself: the edge was dropped", got)
	}
	// An empty answer drops the last edge too.
	m.ReconcileChildren("parent", nil)
	if got := m.ChildSummary("parent"); got != nil {
		t.Errorf("parent summary after an empty answer = %+v, want nil", got)
	}
}

// The spawn race: a child spawned while its parent's /children answer was in
// flight has an edge the answer could not name, and one reconcile must not
// read it as a deletion. Edges younger than spawnEdgeGrace are spared; an
// edge learned before the answer and missing from it is a real deletion.
func TestReconcileChildrenSparesAFreshEdge(t *testing.T) {
	m := New(newFakeBackend(), policy.Default())
	m.Track("/ws", backend.Session{ID: "parent"})
	m.Track("/ws", backend.Session{ID: "old", ParentID: "parent"})
	m.mu.Lock()
	m.sessions["old"].parentSince = time.Now().Add(-2 * spawnEdgeGrace)
	m.mu.Unlock()
	// The fresh spawn: learned from the parent's task part a moment ago.
	m.Track("/ws", backend.Session{ID: "fresh", ParentID: "parent"})

	// The answer, taken before the fresh spawn existed, names neither child.
	m.ReconcileChildren("parent", nil)

	sum := m.ChildSummary("parent")
	if sum == nil || sum.Children != 1 {
		t.Fatalf("parent summary = %+v, want the fresh child kept", sum)
	}
	if got := m.RootOf("fresh"); got != "parent" {
		t.Errorf("RootOf(fresh) = %q, want parent", got)
	}
	if got := m.RootOf("old"); got != "old" {
		t.Errorf("RootOf(old) = %q, want old itself: the stale edge was dropped", got)
	}
}
