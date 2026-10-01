package main

import (
	"context"
	"encoding/json"
	"testing"

	"galopin/internal/backend"
)

// pendingListBackend is a Backend whose sessions are canned per directory —
// the floor permissions.pending's title/workspace join reads from.
type pendingListBackend struct {
	byDir map[string][]backend.Session
}

func (f *pendingListBackend) ID() string                         { return "fake" }
func (f *pendingListBackend) Version() string                    { return "0.0.0" }
func (f *pendingListBackend) Capabilities() backend.Capabilities { return backend.Capabilities{} }
func (f *pendingListBackend) ListSessions(_ context.Context, dir string) ([]backend.Session, error) {
	return f.byDir[dir], nil
}
func (f *pendingListBackend) GetSession(context.Context, string, string) (backend.Session, error) {
	panic("not used by these tests")
}
func (f *pendingListBackend) CreateSession(context.Context, string, backend.CreateSessionOptions) (backend.Session, error) {
	panic("not used by these tests")
}
func (f *pendingListBackend) RenameSession(context.Context, string, string, string) (backend.Session, error) {
	panic("not used by these tests")
}
func (f *pendingListBackend) DeleteSession(context.Context, string, string) error {
	panic("not used by these tests")
}
func (f *pendingListBackend) Prompt(context.Context, string, string, backend.Prompt) error {
	panic("not used by these tests")
}
func (f *pendingListBackend) Cancel(context.Context, string, string) error {
	panic("not used by these tests")
}
func (f *pendingListBackend) SetMode(context.Context, string, string, string) (backend.Session, error) {
	panic("not used by these tests")
}
func (f *pendingListBackend) SetModel(context.Context, string, string, string) (backend.Session, error) {
	panic("not used by these tests")
}
func (f *pendingListBackend) ReplyPermission(context.Context, string, string, string, backend.Decision, string) error {
	return nil
}
func (f *pendingListBackend) Modes(context.Context, string) ([]backend.Mode, error) {
	panic("not used by these tests")
}
func (f *pendingListBackend) Models(context.Context, string) ([]backend.Model, error) {
	panic("not used by these tests")
}
func (f *pendingListBackend) Transcript(context.Context, string, string) (backend.Transcript, error) {
	return backend.Transcript{}, nil
}
func (f *pendingListBackend) Subscribe(context.Context) (<-chan backend.BackendEvent, error) {
	panic("not used by these tests")
}

var _ backend.Backend = (*pendingListBackend)(nil)

func pendingResult(t *testing.T, res any) (perms []map[string]any, asks []map[string]any) {
	t.Helper()
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Permissions []map[string]any `json:"permissions"`
		Questions   []map[string]any `json:"questions"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Permissions == nil || decoded.Questions == nil {
		t.Fatalf("decoded = %+v, want both lists present (never null)", decoded)
	}
	return decoded.Permissions, decoded.Questions
}

// An empty machine answers two empty lists, never nulls — Cerea iterates
// them without a nil check.
func TestPermissionsPendingEmpty(t *testing.T) {
	back := &pendingListBackend{byDir: map[string][]backend.Session{}}
	mc := newTestMachine(t, back)
	res, operr := mc.Handle(context.Background(), "permissions.pending", json.RawMessage(`{}`))
	if operr != nil {
		t.Fatalf("unexpected error: %+v", operr)
	}
	perms, asks := pendingResult(t, res)
	if len(perms) != 0 || len(asks) != 0 {
		t.Fatalf("perms=%v asks=%v, want both empty", perms, asks)
	}
}

// One permission and one question across two sessions come back with the
// session context the inbox needs to render and deep-link them.
func TestPermissionsPendingListsBoth(t *testing.T) {
	back := &pendingListBackend{byDir: map[string][]backend.Session{}}
	mc := newTestMachine(t, back)
	ctx := context.Background()

	trackTestSession(t, mc, "s1")
	trackTestSession(t, mc, "s2")
	dir1, _ := mc.mat.WorkspaceDir("s1")
	dir2, _ := mc.mat.WorkspaceDir("s2")
	back.byDir[dir1] = []backend.Session{{ID: "s1", Title: "First"}}
	back.byDir[dir2] = []backend.Session{{ID: "s2", Title: "Second"}}

	mc.mat.ApplyBackendEvent(ctx, backend.BackendEvent{SessionID: "s1", Event: backend.Event{
		Kind:    backend.EventPermissionAsked,
		Request: &backend.PermissionRequest{ID: "perm-1", SessionID: "s1", Tool: "bash", Title: "run tests"},
	}})
	mc.mat.ApplyBackendEvent(ctx, backend.BackendEvent{SessionID: "s2", Event: backend.Event{
		Kind:              backend.EventQuestionAsked,
		QuestionRequestID: "que-1",
		Questions:         []backend.QuestionItem{{Question: "Which?", Options: []backend.QuestionOption{{Label: "A"}}}},
	}})

	res, operr := mc.Handle(ctx, "permissions.pending", json.RawMessage(`{}`))
	if operr != nil {
		t.Fatalf("unexpected error: %+v", operr)
	}
	perms, asks := pendingResult(t, res)
	if len(perms) != 1 {
		t.Fatalf("perms = %v, want 1", perms)
	}
	if perms[0]["sessionId"] != "s1" || perms[0]["sessionTitle"] != "First" {
		t.Fatalf("perm = %v, want s1/First", perms[0])
	}
	if _, ok := perms[0]["request"]; !ok {
		t.Fatalf("perm = %v, want a request", perms[0])
	}
	if len(asks) != 1 {
		t.Fatalf("asks = %v, want 1", asks)
	}
	if asks[0]["sessionId"] != "s2" || asks[0]["sessionTitle"] != "Second" {
		t.Fatalf("ask = %v, want s2/Second", asks[0])
	}
}

// A replied permission leaves the listing — the same event that clears the
// agent card clears the inbox.
func TestPermissionsPendingClearsOnReply(t *testing.T) {
	back := &pendingListBackend{byDir: map[string][]backend.Session{}}
	mc := newTestMachine(t, back)
	ctx := context.Background()

	trackTestSession(t, mc, "s1")
	dir1, _ := mc.mat.WorkspaceDir("s1")
	back.byDir[dir1] = []backend.Session{{ID: "s1", Title: "First"}}

	mc.mat.ApplyBackendEvent(ctx, backend.BackendEvent{SessionID: "s1", Event: backend.Event{
		Kind:    backend.EventPermissionAsked,
		Request: &backend.PermissionRequest{ID: "perm-1", SessionID: "s1", Tool: "bash", Title: "run"},
	}})
	mc.mat.ApplyBackendEvent(ctx, backend.BackendEvent{SessionID: "s1", Event: backend.Event{
		Kind: backend.EventPermissionReplied, RequestID: "perm-1", Decision: backend.DecisionOnce, By: "user",
	}})

	res, operr := mc.Handle(ctx, "permissions.pending", json.RawMessage(`{}`))
	if operr != nil {
		t.Fatalf("unexpected error: %+v", operr)
	}
	perms, asks := pendingResult(t, res)
	if len(perms) != 0 || len(asks) != 0 {
		t.Fatalf("perms=%v asks=%v, want both empty after the reply", perms, asks)
	}
}

// Unknown ops still answer unsupported — the new op did not swallow the
// default branch.
func TestPermissionsPendingUnknownOpStillUnsupported(t *testing.T) {
	back := &pendingListBackend{byDir: map[string][]backend.Session{}}
	mc := newTestMachine(t, back)
	_, operr := mc.Handle(context.Background(), "permissions.bogus", json.RawMessage(`{}`))
	if operr == nil || operr.Code != "unsupported" {
		t.Fatalf("operr = %+v, want unsupported", operr)
	}
}
