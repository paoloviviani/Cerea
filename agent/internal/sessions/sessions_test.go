package sessions

import (
	"context"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/policy"
)

// fakeBackend is the minimal backend.Backend a materializer test needs:
// Transcript is settable per session (for the seeding tests), everything
// else is unused by these tests and panics if called, so an accidental
// dependency on unmocked behaviour fails loudly instead of silently.
type fakeBackend struct {
	transcripts map[string]backend.Transcript
	replies     []replyCall
	replyErr    error
	// afterTranscriptRead runs once the transcript has been read and before it is
	// returned: what a turn does while the backend answers the fetch.
	afterTranscriptRead func()
}

type replyCall struct {
	sessionID string
	requestID string
	decision  backend.Decision
}

func newFakeBackend() *fakeBackend {
	return &fakeBackend{transcripts: map[string]backend.Transcript{}}
}

func (f *fakeBackend) ID() string                         { return "fake" }
func (f *fakeBackend) Version() string                    { return "0.0.0" }
func (f *fakeBackend) Capabilities() backend.Capabilities { return backend.Capabilities{} }
func (f *fakeBackend) ListSessions(context.Context, string) ([]backend.Session, error) {
	panic("not used by these tests")
}
func (f *fakeBackend) GetSession(context.Context, string, string) (backend.Session, error) {
	panic("not used by these tests")
}
func (f *fakeBackend) CreateSession(context.Context, string, backend.CreateSessionOptions) (backend.Session, error) {
	panic("not used by these tests")
}
func (f *fakeBackend) RenameSession(context.Context, string, string, string) (backend.Session, error) {
	panic("not used by these tests")
}
func (f *fakeBackend) DeleteSession(context.Context, string, string) error {
	panic("not used by these tests")
}
func (f *fakeBackend) Prompt(context.Context, string, string, backend.Prompt) error {
	panic("not used by these tests")
}
func (f *fakeBackend) Cancel(context.Context, string, string) error {
	panic("not used by these tests")
}
func (f *fakeBackend) SetMode(context.Context, string, string, string) (backend.Session, error) {
	panic("not used by these tests")
}
func (f *fakeBackend) SetModel(context.Context, string, string, string) (backend.Session, error) {
	panic("not used by these tests")
}
func (f *fakeBackend) ReplyPermission(_ context.Context, _ string, sessionID, requestID string, decision backend.Decision, _ string) error {
	f.replies = append(f.replies, replyCall{sessionID: sessionID, requestID: requestID, decision: decision})
	return f.replyErr
}
func (f *fakeBackend) Modes(context.Context, string) ([]backend.Mode, error) {
	panic("not used by these tests")
}
func (f *fakeBackend) Models(context.Context, string) ([]backend.Model, error) {
	panic("not used by these tests")
}
func (f *fakeBackend) Transcript(_ context.Context, _ string, sessionID string) (backend.Transcript, error) {
	tr := f.transcripts[sessionID]
	if f.afterTranscriptRead != nil {
		f.afterTranscriptRead()
	}
	return tr, nil
}
func (f *fakeBackend) Subscribe(context.Context) (<-chan backend.BackendEvent, error) {
	panic("not used by these tests: they drive ApplyBackendEvent directly")
}

func textPart(msgID, partID, text string) backend.Event {
	return backend.Event{
		Kind: backend.EventPart,
		Part: &backend.Part{ID: partID, MessageID: msgID, Role: "assistant", Type: backend.PartText, Text: text},
	}
}

// The ask pre-filter (PROTOCOL.md §6 "Permissions", Deny): a consumed ask is
// never recorded in the ring, never published, and never reaches onAsk — no
// permission.asked envelope exists for it anywhere. An ask the filter leaves
// alone flows exactly as without one.
func TestAskFilterConsumesBeforeAnythingIsRecorded(t *testing.T) {
	ctx := context.Background()
	ask := func(id, session string) backend.BackendEvent {
		return backend.BackendEvent{WorkspaceDir: "/ws", SessionID: session, Event: backend.Event{
			Kind:    backend.EventPermissionAsked,
			Request: &backend.PermissionRequest{ID: id, SessionID: session, Tool: "bash", Patterns: []string{"ls"}},
		}}
	}
	// Consumed: nothing in the ring, nothing on the child-ask hook.
	m := New(newFakeBackend(), policy.Default())
	m.Track("/ws", backend.Session{ID: "s1"})
	var childAsks int
	m.OnChildAsk(func(string, backend.PermissionRequest) { childAsks++ })
	m.OnAskFilter(func(string, backend.PermissionRequest) bool { return true })
	m.ApplyBackendEvent(ctx, ask("per_1", "s1"))
	// A child ask is consumed the same way.
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "kid", Event: backend.Event{
		Kind: backend.EventSession, Session: &backend.Session{ID: "kid", ParentID: "s1"},
	}})
	m.ApplyBackendEvent(ctx, ask("per_k", "kid"))
	if n := m.PendingPermissions("s1") + m.PendingPermissions("kid"); n != 0 {
		t.Errorf("consumed asks are pending: %d", n)
	}
	if childAsks != 0 {
		t.Errorf("onAsk fired %d times for consumed asks", childAsks)
	}
	res, err := m.Sync(ctx, "s1", m.Epoch(), 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range res.Events {
		if e.Event.Kind == backend.EventPermissionAsked {
			t.Errorf("a consumed ask reached the ring: %+v", e.Event.Request)
		}
	}
	// Left alone: recorded, counted and forwarded to onAsk for a child.
	m2 := New(newFakeBackend(), policy.Default())
	var childAsks2 int
	m2.OnChildAsk(func(string, backend.PermissionRequest) { childAsks2++ })
	consulted := 0
	m2.OnAskFilter(func(string, backend.PermissionRequest) bool { consulted++; return false })
	m2.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "kid", Event: backend.Event{
		Kind: backend.EventSession, Session: &backend.Session{ID: "kid", ParentID: "s1"},
	}})
	m2.ApplyBackendEvent(ctx, ask("per_k", "kid"))
	if consulted != 1 {
		t.Errorf("filter consulted %d times, want 1", consulted)
	}
	if n := m2.PendingPermissions("kid"); n != 1 {
		t.Errorf("pending = %d, want the ask the filter left alone", n)
	}
	if childAsks2 != 1 {
		t.Errorf("onAsk fired %d times, want 1", childAsks2)
	}
}

// full upsert; later growth becomes a suffix delta; a stale (shorter)
// resend is dropped; a genuinely different resend re-baselines as a fresh
// upsert — and concat(first text, deltas...) always equals the latest text.
// TestTextContract pins PROTOCOL.md §7: the first sighting of a part is a
func TestTextContract(t *testing.T) {
	m := New(newFakeBackend(), policy.Default())
	m.Track("/ws", backend.Session{ID: "s1"})
	ctx := context.Background()
	apply := func(ev backend.Event) {
		m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "s1", Event: ev})
	}

	apply(textPart("m1", "p1", "Hello"))
	apply(textPart("m1", "p1", "Hello world"))
	apply(textPart("m1", "p1", "Hello wor")) // stale, shorter resend: must be dropped
	apply(textPart("m1", "p1", "Hello world!"))
	apply(textPart("m1", "p1", "Hello world!")) // exact resend of current text: no new info

	res, err := m.Sync(ctx, "s1", m.Epoch(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Events) == 0 {
		t.Fatal("expected buffered events")
	}

	var kinds []backend.EventKind
	assembled := ""
	for i, env := range res.Events {
		if env.Seq != int64(i+1) {
			t.Fatalf("seq[%d] = %d, want %d (strictly increasing, no gaps)", i, env.Seq, i+1)
		}
		kinds = append(kinds, env.Event.Kind)
		switch env.Event.Kind {
		case backend.EventPart:
			assembled = env.Event.Part.Text
		case backend.EventDelta:
			assembled += env.Event.Delta
		}
	}
	if assembled != "Hello world!" {
		t.Fatalf("assembled text = %q, want %q", assembled, "Hello world!")
	}
	// Exactly 3 emissions expected: the first upsert, one delta for the
	// " world" growth, one delta for the "!" growth. The stale shorter
	// resend and the exact-duplicate resend must produce nothing.
	wantKinds := []backend.EventKind{backend.EventPart, backend.EventDelta, backend.EventDelta}
	if len(kinds) != len(wantKinds) {
		t.Fatalf("emitted %d events %v, want %v", len(kinds), kinds, wantKinds)
	}
	for i := range wantKinds {
		if kinds[i] != wantKinds[i] {
			t.Errorf("event[%d].Kind = %q, want %q", i, kinds[i], wantKinds[i])
		}
	}
}

// TestSyncAfterGap pins that a client resuming from an afterSeq the ring
// still holds gets exactly the missing tail, with seq strictly increasing
// and no gaps across the whole run.
func TestSyncAfterGap(t *testing.T) {
	m := New(newFakeBackend(), policy.Default())
	m.Track("/ws", backend.Session{ID: "s1"})
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		m.ApplyBackendEvent(ctx, backend.BackendEvent{
			WorkspaceDir: "/ws", SessionID: "s1",
			Event: backend.Event{Kind: backend.EventStatus, Status: backend.StatusBusy},
		})
	}

	res, err := m.Sync(ctx, "s1", m.Epoch(), 2)
	if err != nil {
		t.Fatal(err)
	}
	if res.Snapshot != nil {
		t.Fatal("a gap the ring still holds must not fall back to a snapshot")
	}
	if len(res.Events) != 3 {
		t.Fatalf("got %d events after afterSeq=2 of 5, want 3", len(res.Events))
	}
	for i, env := range res.Events {
		wantSeq := int64(3 + i)
		if env.Seq != wantSeq {
			t.Errorf("event[%d].Seq = %d, want %d", i, env.Seq, wantSeq)
		}
	}
	if res.Seq != 5 {
		t.Errorf("res.Seq = %d, want 5", res.Seq)
	}
}

// TestSeqStrictlyIncreasingAcrossSessions pins that seq is per-session
// (starts at 1, increases by exactly 1 per emission) and independent
// between sessions — one session's traffic never perturbs another's
// numbering.
func TestSeqStrictlyIncreasingAcrossSessions(t *testing.T) {
	m := New(newFakeBackend(), policy.Default())
	m.Track("/ws", backend.Session{ID: "s1"})
	m.Track("/ws", backend.Session{ID: "s2"})
	ctx := context.Background()

	emit := func(sessionID string) {
		m.ApplyBackendEvent(ctx, backend.BackendEvent{
			WorkspaceDir: "/ws", SessionID: sessionID,
			Event: backend.Event{Kind: backend.EventStatus, Status: backend.StatusIdle},
		})
	}
	emit("s1")
	emit("s2")
	emit("s1")
	emit("s1")
	emit("s2")

	res1, err := m.Sync(ctx, "s1", m.Epoch(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if res1.Seq != 3 {
		t.Fatalf("s1 seq = %d, want 3", res1.Seq)
	}
	for i, env := range res1.Events {
		if env.Seq != int64(i+1) {
			t.Errorf("s1 event[%d].Seq = %d, want %d", i, env.Seq, i+1)
		}
	}

	res2, err := m.Sync(ctx, "s2", m.Epoch(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if res2.Seq != 2 {
		t.Fatalf("s2 seq = %d, want 2", res2.Seq)
	}
}

// TestSyncEpochMismatchFallsBackToSnapshot pins that a client presenting a
// stale epoch (a prior process run) gets a full snapshot, seeded from the
// backend's persisted transcript, never a diff against buffered events that
// belong to a different epoch.
func TestSyncEpochMismatchFallsBackToSnapshot(t *testing.T) {
	fb := newFakeBackend()
	completedAt := time.Now()
	fb.transcripts["s1"] = backend.Transcript{
		Messages: []backend.TranscriptEntry{{
			Message: backend.Message{ID: "m1", Role: "assistant", CompletedAt: &completedAt},
			Parts:   []backend.Part{{ID: "p1", MessageID: "m1", Type: backend.PartText, Text: "from before restart"}},
		}},
		Status: backend.StatusIdle,
	}
	m := New(fb, policy.Default())
	m.Track("/ws", backend.Session{ID: "s1"})
	ctx := context.Background()

	// Some live activity happens in this (new) epoch too.
	m.ApplyBackendEvent(ctx, backend.BackendEvent{
		WorkspaceDir: "/ws", SessionID: "s1",
		Event: textPart("m2", "p2", "live text"),
	})

	res, err := m.Sync(ctx, "s1", "some-other-process's-epoch", 5)
	if err != nil {
		t.Fatal(err)
	}
	if res.Events != nil {
		t.Fatal("an epoch mismatch must never return an events tail")
	}
	if res.Epoch != m.Epoch() {
		t.Errorf("returned epoch = %q, want the current epoch %q", res.Epoch, m.Epoch())
	}
	if res.Snapshot == nil {
		t.Fatal("an epoch mismatch must return a snapshot")
	}
	if len(res.Snapshot.Messages) != 2 {
		t.Fatalf("snapshot has %d messages, want 2 (seeded + live)", len(res.Snapshot.Messages))
	}
	if res.Snapshot.Messages[0].Message.ID != "m1" {
		t.Errorf("snapshot message order lost the seeded (older) message first: %+v", res.Snapshot.Messages)
	}
	if res.Snapshot.Messages[1].Parts[0].Text != "live text" {
		t.Errorf("snapshot lost live activity: %+v", res.Snapshot.Messages[1])
	}
}

// TestSyncNoPriorEpochIsSnapshot pins that a client's first-ever sync (no
// epoch to present at all) always gets a snapshot, not an attempt to diff
// against an epoch it never had.
func TestSyncNoPriorEpochIsSnapshot(t *testing.T) {
	m := New(newFakeBackend(), policy.Default())
	m.Track("/ws", backend.Session{ID: "s1"})
	ctx := context.Background()
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "s1", Event: textPart("m1", "p1", "hi")})

	res, err := m.Sync(ctx, "s1", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if res.Snapshot == nil || res.Events != nil {
		t.Fatalf("first sync with no epoch must be a snapshot, got %+v", res)
	}
}

// TestPermissionAskedIsForwardedAndCounted pins that an ask reaches the client
// as-is (nothing answers it for a person) and counts toward PendingPermissions
// until replied.
func TestPermissionAskedIsForwardedAndCounted(t *testing.T) {
	m := New(newFakeBackend(), policy.Default())
	m.Track("/ws", backend.Session{ID: "s1"})
	ctx := context.Background()
	m.ApplyBackendEvent(ctx, backend.BackendEvent{
		WorkspaceDir: "/ws", SessionID: "s1",
		Event: backend.Event{Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: "perm1", SessionID: "s1"}},
	})
	if m.PendingPermissions("s1") != 1 {
		t.Fatalf("pending permissions = %d, want 1", m.PendingPermissions("s1"))
	}
	res, err := m.Sync(ctx, "s1", m.Epoch(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Events) != 1 || res.Events[0].Event.Kind != backend.EventPermissionAsked {
		t.Fatalf("events = %+v, want the ask forwarded", res.Events)
	}

	m.ApplyBackendEvent(ctx, backend.BackendEvent{
		WorkspaceDir: "/ws", SessionID: "s1",
		Event: backend.Event{Kind: backend.EventPermissionReplied, RequestID: "perm1", Decision: backend.DecisionReject, By: "user"},
	})
	if m.PendingPermissions("s1") != 0 {
		t.Errorf("pending permissions = %d after reply, want 0", m.PendingPermissions("s1"))
	}
}

func TestSyncUnknownSession(t *testing.T) {
	m := New(newFakeBackend(), policy.Default())
	if _, err := m.Sync(context.Background(), "nope", "", 0); err != ErrUnknownSession {
		t.Fatalf("err = %v, want ErrUnknownSession", err)
	}
}

// TestPartsInheritMessageRole: opencode keeps the role on the message only;
// the materializer must put it on every part and delta it forwards, and on
// snapshot parts, or Cerea renders the person's prompt as agent text.
func TestPartsInheritMessageRole(t *testing.T) {
	m := New(newFakeBackend(), policy.Default())
	m.Track("/ws", backend.Session{ID: "s1"})
	ctx := context.Background()
	apply := func(ev backend.Event) {
		m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "s1", Event: ev})
	}
	apply(backend.Event{Kind: backend.EventMessage, Message: &backend.Message{ID: "m1", Role: "user"}})
	apply(backend.Event{Kind: backend.EventPart, Part: &backend.Part{ID: "p1", MessageID: "m1", Type: backend.PartText, Text: "say"}})
	apply(backend.Event{Kind: backend.EventDelta, MessageID: "m1", PartID: "p1", Field: "text", Delta: " hello"})

	res, err := m.Sync(ctx, "s1", m.Epoch(), 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, env := range res.Events {
		switch env.Event.Kind {
		case backend.EventPart:
			if env.Event.Part.Role != "user" {
				t.Errorf("forwarded part role = %q, want user", env.Event.Part.Role)
			}
		case backend.EventDelta:
			if env.Event.Role != "user" {
				t.Errorf("forwarded delta role = %q, want user", env.Event.Role)
			}
		}
	}
	snap, err := m.Sync(ctx, "s1", "another-epoch", 0)
	if err != nil || snap.Snapshot == nil {
		t.Fatalf("want a snapshot, got %+v, %v", snap, err)
	}
	if got := snap.Snapshot.Messages[0].Parts[0]; got.Role != "user" || got.Text != "say hello" {
		t.Errorf("snapshot part = %+v, want role user and text %q", got, "say hello")
	}
}

// TestSnapshotOffersUnansweredQuestions pins that a question-tool ask stays
// in the snapshot until resolved: a client mounting from a snapshot (a
// reload) would otherwise never see an ask the turn is blocked on. Asks the
// backend already holds when the session is first seeded are offered too.
func TestSnapshotOffersUnansweredQuestions(t *testing.T) {
	fb := newFakeBackend()
	fb.transcripts["s1"] = backend.Transcript{Questions: []backend.QuestionRequest{
		{ID: "que_seeded", Questions: []backend.QuestionItem{{Question: "Seeded?"}}},
	}}
	m := New(fb, policy.Default())
	m.Track("/ws", backend.Session{ID: "s1"})
	ctx := context.Background()
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "s1", Event: backend.Event{
		Kind: backend.EventQuestionAsked, QuestionRequestID: "que_1", QuestionCallID: "call_q",
		Questions: []backend.QuestionItem{{Question: "Which approach?", Header: "Approach"}},
	}})

	ids := func() []string {
		res, err := m.Sync(ctx, "s1", "", 0)
		if err != nil || res.Snapshot == nil {
			t.Fatalf("sync = %+v, %v; want a snapshot", res, err)
		}
		var out []string
		for _, q := range res.Snapshot.Questions {
			out = append(out, q.ID+"/"+q.CallID)
		}
		return out
	}
	if got := ids(); len(got) != 2 || got[0] != "que_seeded/" || got[1] != "que_1/call_q" {
		t.Fatalf("pending questions = %v, want the seeded one then que_1", got)
	}
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "s1", Event: backend.Event{
		Kind: backend.EventQuestionResolved, QuestionRequestID: "que_1", QuestionDecision: "answered",
		QuestionAnswers: [][]string{{"A"}},
	}})
	if got := ids(); len(got) != 1 || got[0] != "que_seeded/" {
		t.Fatalf("after answering que_1, pending = %v", got)
	}
}

// TestChildSummariesMatchesChildSummary pins that the bulk ChildSummaries
// pass (session.list's shared computation, dispatch.go's enrichAll) answers
// exactly what calling the per-session ChildSummary would for every tracked
// session — the O(N²) session.list used to pay, one ChildSummary() scan per
// listed session.
func TestChildSummariesMatchesChildSummary(t *testing.T) {
	m := New(newFakeBackend(), policy.Default())
	ctx := context.Background()
	m.Track("/ws", backend.Session{ID: "root"})
	m.Track("/ws", backend.Session{ID: "a", ParentID: "root", Status: backend.StatusBusy})
	m.Track("/ws", backend.Session{ID: "b", ParentID: "root", Status: backend.StatusIdle})
	m.Track("/ws", backend.Session{ID: "c", ParentID: "b", Status: backend.StatusIdle})
	m.Track("/ws", backend.Session{ID: "other"})
	// c has a pending permission: every ancestor up to root (b, root) counts
	// one waiting descendant; a and other, with no pending permission
	// anywhere below them, do not.
	m.ApplyBackendEvent(ctx, backend.BackendEvent{
		WorkspaceDir: "/ws", SessionID: "c",
		Event: backend.Event{Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: "perm1", SessionID: "c"}},
	})

	all := []string{"root", "a", "b", "c", "other"}
	bulk := m.ChildSummaries()
	for _, id := range all {
		want := m.ChildSummary(id)
		got := bulk[id]
		if (want == nil) != (got == nil) {
			t.Fatalf("%s: ChildSummaries = %+v, ChildSummary = %+v", id, got, want)
		}
		if want != nil && *want != *got {
			t.Fatalf("%s: ChildSummaries = %+v, ChildSummary = %+v", id, *got, *want)
		}
	}
	root := bulk["root"]
	if root == nil || root.Children != 2 || root.Running != 1 || root.Waiting != 1 {
		t.Fatalf("root summary = %+v, want {Children:2 Running:1 Waiting:1}", root)
	}
	b := bulk["b"]
	if b == nil || b.Children != 1 || b.Running != 0 || b.Waiting != 1 {
		t.Fatalf("b summary = %+v, want {Children:1 Running:0 Waiting:1}", b)
	}
	for _, id := range []string{"a", "c", "other"} {
		if bulk[id] != nil {
			t.Errorf("%s summary = %+v, want nil (no known child)", id, bulk[id])
		}
	}
}

// A resync (the backend skipped an event it could not read) re-reads the
// transcript and announces its tool parts again, images included.
func TestResyncReannouncesToolPartsFromTheTranscript(t *testing.T) {
	back := newFakeBackend()
	mat := New(back, policy.Default())
	mat.Track("/work", backend.Session{ID: "s1"})
	back.transcripts["s1"] = backend.Transcript{
		Status: backend.StatusIdle,
		Messages: []backend.TranscriptEntry{{
			Message: backend.Message{ID: "m1", Role: "assistant"},
			Parts: []backend.Part{
				{ID: "t1", MessageID: "m1", Type: backend.PartText, Text: "hi"},
				{ID: "p1", MessageID: "m1", Type: backend.PartTool, CallID: "c1", Tool: "shot", ToolStatus: backend.ToolCompleted,
					Attachments: []backend.ToolAttachment{{SHA256: "a", Mime: "image/png", Size: 3}}},
			},
		}},
	}
	mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{WorkspaceDir: "/work", SessionID: "s1", Event: backend.Event{Kind: backend.EventResync}})

	select {
	case env := <-mat.Events():
		if env.SessionID != "s1" || env.Event.Kind != backend.EventPart || env.Event.Part.CallID != "c1" || len(env.Event.Part.Attachments) != 1 {
			t.Fatalf("envelope = %+v", env)
		}
		if env.Event.Part.Role != "assistant" {
			t.Fatalf("role not filled: %q", env.Event.Part.Role)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no part re-announced")
	}
	// The held history is the fresh transcript, and a snapshot carries it.
	res, err := mat.Sync(context.Background(), "s1", "", 0)
	if err != nil || res.Snapshot == nil || len(res.Snapshot.Messages) != 1 {
		t.Fatalf("sync: %+v %v", res, err)
	}
	// An unknown session is ignored, never created.
	mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{SessionID: "ghost", Event: backend.Event{Kind: backend.EventResync}})
	time.Sleep(100 * time.Millisecond)
	if _, err := mat.Sync(context.Background(), "ghost", "", 0); err == nil {
		t.Fatal("resync created an unknown session")
	}
}

func TestWithdrawPendingClosesEveryAsk(t *testing.T) {
	m := New(newFakeBackend(), policy.Default())
	m.Track("/ws", backend.Session{ID: "s1"})
	ctx := context.Background()
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "s1",
		Event: backend.Event{Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: "perm1", SessionID: "s1", Tool: "edit"}}})
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "s1",
		Event: backend.Event{Kind: backend.EventQuestionAsked, QuestionRequestID: "q1"}})
	m.WithdrawPending()
	if m.PendingPermissions("s1") != 0 || len(m.PendingQuestionRequests("s1")) != 0 {
		t.Fatal("asks survived the withdrawal")
	}
	res, err := m.Sync(ctx, "s1", m.Epoch(), 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Events) != 2 || res.Events[0].Event.Kind != backend.EventPermissionReplied || res.Events[0].Event.Decision != backend.DecisionReject ||
		res.Events[1].Event.Kind != backend.EventQuestionResolved {
		t.Errorf("events = %+v, want a rejected replied then a resolved", res.Events)
	}
}

// A page opened mid-retry still learns why the session waits: the snapshot
// carries the retry detail, and the next non-retry status clears it.
func TestSnapshotCarriesRetryUntilStatusChanges(t *testing.T) {
	m := New(newFakeBackend(), policy.Default())
	m.Track("/ws", backend.Session{ID: "s1"})
	ctx := context.Background()
	apply := func(ev backend.Event) {
		m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "s1", Event: ev})
	}
	snap := func() backend.Transcript {
		res, err := m.Sync(ctx, "s1", "", 0)
		if err != nil || res.Snapshot == nil {
			t.Fatalf("Sync = %+v, %v; want a snapshot", res, err)
		}
		return *res.Snapshot
	}

	info := &backend.RetryInfo{Attempt: 2, Message: "Rate limit exceeded", Next: 42}
	apply(backend.Event{Kind: backend.EventStatus, Status: backend.StatusRetry, Retry: info})
	tr := snap()
	if tr.Status != backend.StatusRetry || tr.Retry == nil || *tr.Retry != *info {
		t.Fatalf("snapshot = status %q retry %+v, want retry %+v", tr.Status, tr.Retry, info)
	}
	apply(backend.Event{Kind: backend.EventStatus, Status: backend.StatusBusy})
	if tr := snap(); tr.Retry != nil {
		t.Errorf("Retry = %+v after busy, want nil", tr.Retry)
	}
}

// A resync fetches the transcript and swaps it in. A turn running while the fetch is
// out writes parts the fetched copy never had: the swap must keep them, or every
// later snapshot (a page reload) shows the finished reply with no text.
func TestResyncKeepsWhatARunningTurnWroteDuringTheFetch(t *testing.T) {
	ctx := context.Background()
	back := newFakeBackend()
	mat := New(back, policy.Default())
	mat.Track("/work", backend.Session{ID: "s1"})
	back.transcripts["s1"] = backend.Transcript{
		Status: backend.StatusBusy,
		Messages: []backend.TranscriptEntry{
			{Message: backend.Message{ID: "u1", Role: "user"}, Parts: []backend.Part{{ID: "pu1", MessageID: "u1", Role: "user", Type: backend.PartText, Text: "question"}}},
			{Message: backend.Message{ID: "a1", Role: "assistant"}},
		},
	}
	live := func(ev backend.Event) {
		mat.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/work", SessionID: "s1", Event: ev})
	}
	// The fetch has read the transcript (an empty assistant message); the reply is written
	// before the swap lands.
	back.afterTranscriptRead = func() {
		back.afterTranscriptRead = nil
		live(textPart("a1", "t1", "Answer two, again."))
	}
	mat.resync(ctx, "/work", "s1")

	res, err := mat.Sync(ctx, "s1", "", 0)
	if err != nil || res.Snapshot == nil {
		t.Fatalf("sync: %+v %v", res, err)
	}
	var got string
	var ids []string
	for _, e := range res.Snapshot.Messages {
		ids = append(ids, e.Message.ID)
		for _, p := range e.Parts {
			if e.Message.ID == "a1" {
				got += p.Text
			}
		}
	}
	if got != "Answer two, again." {
		t.Fatalf("the reply's text was lost to the swap: %q (messages %v)", got, ids)
	}
	if len(ids) != 2 || ids[0] != "u1" || ids[1] != "a1" {
		t.Fatalf("messages = %v, want [u1 a1]", ids)
	}
}

func partsOf(t *testing.T, mat *Materializer, session, msg string) map[string]backend.Part {
	t.Helper()
	res, err := mat.Sync(context.Background(), session, "", 0)
	if err != nil || res.Snapshot == nil {
		t.Fatalf("sync: %+v %v", res, err)
	}
	out := map[string]backend.Part{}
	for _, e := range res.Snapshot.Messages {
		if e.Message.ID == msg {
			for _, p := range e.Parts {
				out[p.ID] = p
			}
		}
	}
	return out
}

// What a resync is for: the transcript holds state the live events never delivered (a dropped
// oversized line). A live event for the same message during the fetch must not make the stale
// live copy of an untouched part win.
func TestResyncTakesTheTranscriptsPartsThatNoLiveEventTouchedOnARunningMessage(t *testing.T) {
	ctx := context.Background()
	back := newFakeBackend()
	mat := New(back, policy.Default())
	mat.Track("/work", backend.Session{ID: "s1"})
	live := func(ev backend.Event) {
		mat.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/work", SessionID: "s1", Event: ev})
	}
	live(backend.Event{Kind: backend.EventMessage, Message: &backend.Message{ID: "a1", Role: "assistant"}})
	// The tool is running as far as live events know; its completion was a dropped line.
	live(backend.Event{Kind: backend.EventPart, Part: &backend.Part{ID: "p2", MessageID: "a1", Role: "assistant", Type: backend.PartTool, CallID: "c2", Tool: "shot", ToolStatus: backend.ToolRunning}})
	// A text part whose deltas were partly lost.
	live(textPart("a1", "t1", "Hel"))
	back.transcripts["s1"] = backend.Transcript{
		Status: backend.StatusBusy,
		Messages: []backend.TranscriptEntry{{
			Message: backend.Message{ID: "a1", Role: "assistant"},
			Parts: []backend.Part{
				{ID: "t1", MessageID: "a1", Role: "assistant", Type: backend.PartText, Text: "Hello wor"},
				{ID: "p2", MessageID: "a1", Role: "assistant", Type: backend.PartTool, CallID: "c2", Tool: "shot", ToolStatus: backend.ToolCompleted,
					Attachments: []backend.ToolAttachment{{SHA256: "a", Mime: "image/png", Size: 3}}},
			},
		}},
	}
	// During the fetch the running turn writes to the same message, but not to p2 or t1.
	back.afterTranscriptRead = func() {
		back.afterTranscriptRead = nil
		live(backend.Event{Kind: backend.EventMessage, Message: &backend.Message{ID: "a1", Role: "assistant", ModelID: "m"}})
	}
	mat.resync(ctx, "/work", "s1")

	parts := partsOf(t, mat, "s1", "a1")
	if got := parts["p2"]; got.ToolStatus != backend.ToolCompleted || len(got.Attachments) != 1 {
		t.Fatalf("the tool part kept its stale live copy: %+v", got)
	}
	if got := parts["t1"].Text; got != "Hello wor" {
		t.Fatalf("the text kept its truncated live copy: %q", got)
	}
	// Later deltas apply on top of the transcript's text.
	live(backend.Event{Kind: backend.EventDelta, MessageID: "a1", PartID: "t1", Field: "text", Delta: "ld"})
	if got := partsOf(t, mat, "s1", "a1")["t1"].Text; got != "Hello world" {
		t.Fatalf("text after a later delta = %q", got)
	}
	// The completed tool part is announced to connected viewers.
	announced := false
	for {
		select {
		case env := <-mat.Events():
			if env.Event.Kind == backend.EventPart && env.Event.Part != nil && env.Event.Part.CallID == "c2" && env.Event.Part.ToolStatus == backend.ToolCompleted {
				announced = true
			}
			continue
		default:
		}
		break
	}
	if !announced {
		t.Fatal("the completed tool part was not re-announced")
	}
}

// After a gap, deltas keep arriving while the fetch is out: the live copy of the text part wins
// over the transcript's older read, and opencode's final part.updated heals whatever the gap lost.
func TestResyncTextStreamingDuringTheFetchKeepsLiveDeltasAndHealsOnTheFinalPart(t *testing.T) {
	ctx := context.Background()
	back := newFakeBackend()
	mat := New(back, policy.Default())
	mat.Track("/work", backend.Session{ID: "s1"})
	live := func(ev backend.Event) {
		mat.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/work", SessionID: "s1", Event: ev})
	}
	live(backend.Event{Kind: backend.EventMessage, Message: &backend.Message{ID: "a1", Role: "assistant"}})
	live(textPart("a1", "t1", "Hel"))
	back.transcripts["s1"] = backend.Transcript{
		Status: backend.StatusBusy,
		Messages: []backend.TranscriptEntry{{
			Message: backend.Message{ID: "a1", Role: "assistant"},
			Parts:   []backend.Part{{ID: "t1", MessageID: "a1", Role: "assistant", Type: backend.PartText, Text: "Hel"}},
		}},
	}
	back.afterTranscriptRead = func() {
		back.afterTranscriptRead = nil
		live(backend.Event{Kind: backend.EventDelta, MessageID: "a1", PartID: "t1", Field: "text", Delta: "lo wor"})
	}
	mat.resync(ctx, "/work", "s1")
	if got := partsOf(t, mat, "s1", "a1")["t1"].Text; got != "Hello wor" {
		t.Fatalf("live deltas lost to the swap: %q", got)
	}
	live(textPart("a1", "t1", "Hello world"))
	if got := partsOf(t, mat, "s1", "a1")["t1"].Text; got != "Hello world" {
		t.Fatalf("final part did not heal the text: %q", got)
	}
}

// A part removed live while the fetch is out must not come back from the transcript's older
// copy, and a removed tool part must not be re-announced.
func TestResyncDoesNotResurrectAPartRemovedDuringTheFetch(t *testing.T) {
	ctx := context.Background()
	back := newFakeBackend()
	mat := New(back, policy.Default())
	mat.Track("/work", backend.Session{ID: "s1"})
	live := func(ev backend.Event) {
		mat.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/work", SessionID: "s1", Event: ev})
	}
	live(backend.Event{Kind: backend.EventMessage, Message: &backend.Message{ID: "a1", Role: "assistant"}})
	live(textPart("a1", "t1", "keep"))
	live(backend.Event{Kind: backend.EventPart, Part: &backend.Part{ID: "p2", MessageID: "a1", Role: "assistant", Type: backend.PartTool, CallID: "c2", Tool: "shot", ToolStatus: backend.ToolCompleted}})
	back.transcripts["s1"] = backend.Transcript{
		Status: backend.StatusBusy,
		Messages: []backend.TranscriptEntry{{
			Message: backend.Message{ID: "a1", Role: "assistant"},
			Parts: []backend.Part{
				{ID: "t1", MessageID: "a1", Role: "assistant", Type: backend.PartText, Text: "keep"},
				{ID: "p2", MessageID: "a1", Role: "assistant", Type: backend.PartTool, CallID: "c2", Tool: "shot", ToolStatus: backend.ToolCompleted},
			},
		}},
	}
	for drained := false; !drained; {
		select {
		case <-mat.Events():
		default:
			drained = true
		}
	}
	back.afterTranscriptRead = func() {
		back.afterTranscriptRead = nil
		live(backend.Event{Kind: backend.EventPartRemoved, MessageID: "a1", PartID: "p2"})
	}
	mat.resync(ctx, "/work", "s1")
	parts := partsOf(t, mat, "s1", "a1")
	if _, back := parts["p2"]; back {
		t.Fatalf("a part removed during the fetch came back: %+v", parts)
	}
	if parts["t1"].Text != "keep" {
		t.Fatalf("other parts lost: %+v", parts)
	}
	for {
		select {
		case env := <-mat.Events():
			if env.Event.Kind == backend.EventPart && env.Event.Part != nil && env.Event.Part.ID == "p2" {
				t.Fatalf("the removed tool part was re-announced")
			}
			continue
		default:
		}
		break
	}
}

// Two resyncs can overlap (a reconnect and an oversized line). The one whose fetch began earlier
// must not apply after the newer one, or it reverts what the newer one took.
func TestOverlappingResyncsDoNotLetTheOlderFetchWin(t *testing.T) {
	ctx := context.Background()
	back := newFakeBackend()
	mat := New(back, policy.Default())
	mat.Track("/work", backend.Session{ID: "s1"})
	live := func(ev backend.Event) {
		mat.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/work", SessionID: "s1", Event: ev})
	}
	tr := func(text string) backend.Transcript {
		return backend.Transcript{Status: backend.StatusBusy, Messages: []backend.TranscriptEntry{{
			Message: backend.Message{ID: "a1", Role: "assistant"},
			Parts:   []backend.Part{{ID: "t1", MessageID: "a1", Role: "assistant", Type: backend.PartText, Text: text}},
		}}}
	}
	back.transcripts["s1"] = tr("old")
	back.afterTranscriptRead = func() {
		// resync A has read "old"; before it applies, a later event and a whole second resync run
		back.afterTranscriptRead = nil
		live(backend.Event{Kind: backend.EventMessage, Message: &backend.Message{ID: "z9", Role: "assistant"}})
		back.transcripts["s1"] = tr("newer")
		mat.resync(ctx, "/work", "s1")
	}
	mat.resync(ctx, "/work", "s1")
	if got := partsOf(t, mat, "s1", "a1")["t1"].Text; got != "newer" {
		t.Fatalf("the older resync reverted the newer one: %q", got)
	}
}

// A resync in flight across a Reseed (a revert) holds the pre-revert transcript: it must not apply.
func TestResyncStartedBeforeAReseedIsDiscarded(t *testing.T) {
	ctx := context.Background()
	back := newFakeBackend()
	mat := New(back, policy.Default())
	mat.Track("/work", backend.Session{ID: "s1"})
	back.transcripts["s1"] = backend.Transcript{Status: backend.StatusIdle, Messages: []backend.TranscriptEntry{{
		Message: backend.Message{ID: "a1", Role: "assistant"},
		Parts:   []backend.Part{{ID: "t1", MessageID: "a1", Role: "assistant", Type: backend.PartText, Text: "reverted away"}},
	}}}
	back.afterTranscriptRead = func() {
		back.afterTranscriptRead = nil
		mat.Reseed("s1")
		back.transcripts["s1"] = backend.Transcript{Status: backend.StatusIdle}
	}
	mat.resync(ctx, "/work", "s1")
	if got := partsOf(t, mat, "s1", "a1"); len(got) != 0 {
		t.Fatalf("the pre-revert transcript was applied: %+v", got)
	}
}

// The waiting follow-ups ride the snapshot, so a reload shows them; an empty list clears them.
func TestSnapshotCarriesTheWaitingFollowUps(t *testing.T) {
	m := New(newFakeBackend(), policy.Default())
	m.Track("/ws", backend.Session{ID: "s1"})
	ctx := context.Background()
	apply := func(q []backend.QueuedPrompt) {
		m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "s1", Event: backend.Event{Kind: backend.EventQueue, Queued: q}})
	}
	queued := func() int {
		res, err := m.Sync(ctx, "s1", "", 0)
		if err != nil || res.Snapshot == nil {
			t.Fatalf("sync = %+v, %v", res, err)
		}
		return len(res.Snapshot.Queued)
	}
	apply([]backend.QueuedPrompt{{ID: "c2", Text: "next"}})
	if queued() != 1 {
		t.Fatal("the snapshot lacks the waiting follow-up")
	}
	apply([]backend.QueuedPrompt{})
	if queued() != 0 {
		t.Fatal("the snapshot still lists a follow-up that was sent")
	}
}

// TreeKnown says whether a session's place in the tree is settled: an id the
// materializer never saw a record for may be a child whose edge is late, so it
// is not known; a recorded top-level session, a child whose chain reaches a
// recorded top, and a session marked after its record could not be read are.
func TestTreeKnownNeedsARecordedTop(t *testing.T) {
	ctx := context.Background()
	m := New(newFakeBackend(), policy.Default())
	if m.TreeKnown("kid") {
		t.Fatal("a session never seen is known")
	}
	m.Track("/ws", backend.Session{ID: "s1"})
	if !m.TreeKnown("s1") {
		t.Error("a tracked top-level session is not known")
	}
	// the edge alone, from the parent's task part, is enough once the parent is recorded
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "kid", Event: backend.Event{
		Kind: backend.EventSession, Session: &backend.Session{ID: "kid", ParentID: "s1"},
	}})
	if !m.TreeKnown("kid") {
		t.Error("a child with a recorded parent chain is not known")
	}
	// a child whose parent was never recorded: the top of its chain is unseen
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "kid2", Event: backend.Event{
		Kind: backend.EventSession, Session: &backend.Session{ID: "kid2", ParentID: "ghost"},
	}})
	if m.TreeKnown("kid2") {
		t.Error("a child under a parent never recorded is known")
	}
	m.MarkTreeKnown("/ws", "kid2")
	if !m.TreeKnown("kid2") {
		t.Error("a marked session is still unknown")
	}
	if got := m.RootOf("kid2"); got != "ghost" {
		t.Errorf("root of kid2 = %q: marking must keep the edge", got)
	}
}

// ReleaseAsk materialises a held ask without consulting the filter again.
func TestReleaseAskSkipsTheFilter(t *testing.T) {
	ctx := context.Background()
	m := New(newFakeBackend(), policy.Default())
	m.Track("/ws", backend.Session{ID: "s1"})
	consulted := 0
	m.OnAskFilter(func(string, backend.PermissionRequest) bool { consulted++; return true })
	m.ReleaseAsk(ctx, "/ws", backend.PermissionRequest{ID: "per_1", SessionID: "s1", Tool: "bash", Patterns: []string{"ls"}})
	if consulted != 0 {
		t.Errorf("filter consulted %d times by ReleaseAsk, want 0", consulted)
	}
	if n := m.PendingPermissions("s1"); n != 1 {
		t.Errorf("pending = %d, want the released ask", n)
	}
}

// A held ask (consumed by the filter, decided later) that was answered or
// withdrawn meanwhile is not brought back as a card by ReleaseAsk.
func TestReleaseAskSkipsAnAskAnsweredOrWithdrawnWhileHeld(t *testing.T) {
	ctx := context.Background()
	ask := func(id string) backend.PermissionRequest {
		return backend.PermissionRequest{ID: id, SessionID: "s1", Tool: "bash", Patterns: []string{"ls"}}
	}
	m := New(newFakeBackend(), policy.Default())
	m.Track("/ws", backend.Session{ID: "s1"})
	for _, id := range []string{"per_ok", "per_replied", "per_withdrawn", "per_dropped"} {
		m.HoldAsk(id)
	}
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "s1", Event: backend.Event{
		Kind: backend.EventPermissionReplied, RequestID: "per_replied", Decision: backend.DecisionReject}})
	m.WithdrawPending()   // marks every ask held at that moment ...
	m.HoldAsk("per_late") // ... and not one held after it
	m.DropHeld("per_dropped")
	for _, id := range []string{"per_ok", "per_replied", "per_withdrawn", "per_late", "per_dropped"} {
		m.ReleaseAsk(ctx, "/ws", ask(id))
	}
	got := map[string]bool{}
	for _, r := range m.PendingPermissionRequests("s1") {
		got[r.ID] = true
	}
	if got["per_ok"] || got["per_replied"] || got["per_withdrawn"] {
		t.Errorf("a held ask that was withdrawn or answered came back: %v", got)
	}
	if !got["per_late"] || !got["per_dropped"] {
		t.Errorf("an ask nobody answered must show its card: %v", got)
	}
}

// Without a hold, ReleaseAsk is the plain unfiltered path (as before).
func TestReleaseAskOfAnAskNeverHeldMaterialises(t *testing.T) {
	m := New(newFakeBackend(), policy.Default())
	m.Track("/ws", backend.Session{ID: "s1"})
	m.ReleaseAsk(context.Background(), "/ws", backend.PermissionRequest{ID: "per_1", SessionID: "s1", Tool: "bash", Patterns: []string{"ls"}})
	if n := m.PendingPermissions("s1"); n != 1 {
		t.Errorf("pending = %d, want 1", n)
	}
}

// The same ask passing the filter twice (a re-delivered event, the sync sweep) is
// held twice: an answer that came between the holds is not forgotten by the second,
// and neither release brings back a card.
func TestAnAskHeldTwiceAndAnsweredShowsNoCardOnEitherRelease(t *testing.T) {
	ctx := context.Background()
	m := New(newFakeBackend(), policy.Default())
	m.Track("/ws", backend.Session{ID: "s1"})
	req := backend.PermissionRequest{ID: "per_dup", SessionID: "s1", Tool: "bash", Patterns: []string{"ls"}}
	m.HoldAsk(req.ID)
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "s1", Event: backend.Event{
		Kind: backend.EventPermissionReplied, RequestID: req.ID, Decision: backend.DecisionReject}})
	m.HoldAsk(req.ID) // the re-delivery
	m.ReleaseAsk(ctx, "/ws", req)
	m.ReleaseAsk(ctx, "/ws", req)
	if n := m.PendingPermissions("s1"); n != 0 {
		t.Errorf("pending = %d, want the answered ask to stay gone", n)
	}
	// once both holds are over the id is forgotten: a fresh ask with it shows its card
	m.HoldAsk(req.ID)
	m.ReleaseAsk(ctx, "/ws", req)
	if n := m.PendingPermissions("s1"); n != 1 {
		t.Errorf("pending = %d after a fresh hold and release, want its card", n)
	}
}

// A top known only from a link (its own record never read) is not given the
// asking child's directory.
func TestMarkTreeKnownDoesNotGiveALinkedTopTheChildsDirectory(t *testing.T) {
	ctx := context.Background()
	m := New(newFakeBackend(), policy.Default())
	m.ApplyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: "/ws", SessionID: "kid", Event: backend.Event{
		Kind: backend.EventSession, Session: &backend.Session{ID: "kid", ParentID: "ghost"}}})
	m.MarkTreeKnown("/ws", "kid")
	if dir, ok := m.WorkspaceDir("ghost"); !ok || dir != "" {
		t.Errorf("the linked top's directory = %q (known %v), want it left empty", dir, ok)
	}
	if !m.TreeKnown("kid") {
		t.Error("the chain is not settled")
	}
	// the session itself, when it is the top, does get its directory
	m.MarkTreeKnown("/ws", "solo")
	if dir, _ := m.WorkspaceDir("solo"); dir != "/ws" {
		t.Errorf("a top that is the asking session has directory %q, want /ws", dir)
	}
}
