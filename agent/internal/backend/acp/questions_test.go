package acp

import (
	"context"
	"errors"
	"testing"
	"time"

	"galopin/internal/backend"
)

func nextQuestionEvent(t *testing.T, ch <-chan backend.BackendEvent, kind backend.EventKind) backend.Event {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-ch:
			if ev.Event.Kind == kind {
				return ev.Event
			}
		case <-deadline:
			t.Fatalf("no %s event", kind)
		}
	}
}

func TestAskQuestionsRaisesACardAndReturnsTheAnswers(t *testing.T) {
	b, _ := newTestBackendWith(t, true, true)
	if !b.Capabilities().Questions {
		t.Fatal("questions off although the agent has galopin's tools")
	}
	ctx := context.Background()
	events, _ := b.Subscribe(ctx)
	qs := []backend.QuestionItem{{Question: "Which?", Options: []backend.QuestionOption{{Label: "a"}, {Label: "b"}}}}
	type result struct {
		ans [][]string
		err error
	}
	done := make(chan result, 1)
	go func() {
		a, err := b.AskQuestions(ctx, "/w", "s1", qs)
		done <- result{a, err}
	}()
	asked := nextQuestionEvent(t, events, backend.EventQuestionAsked)
	if asked.QuestionRequestID == "" || len(asked.Questions) != 1 {
		t.Fatalf("asked = %+v", asked)
	}
	// another session cannot answer it
	if err := b.ReplyQuestion(ctx, "/w", "other", asked.QuestionRequestID, [][]string{{"a"}}); !errors.Is(err, backend.ErrQuestionGone) {
		t.Fatalf("a foreign session answered: %v", err)
	}
	if err := b.ReplyQuestion(ctx, "/w", "s1", asked.QuestionRequestID, [][]string{{"b"}}); err != nil {
		t.Fatal(err)
	}
	r := <-done
	if r.err != nil || len(r.ans) != 1 || r.ans[0][0] != "b" {
		t.Fatalf("result = %+v", r)
	}
	res := nextQuestionEvent(t, events, backend.EventQuestionResolved)
	if res.QuestionDecision != "answered" || res.QuestionRequestID != asked.QuestionRequestID {
		t.Fatalf("resolved = %+v", res)
	}
	if err := b.ReplyQuestion(ctx, "/w", "s1", asked.QuestionRequestID, nil); !errors.Is(err, backend.ErrQuestionGone) {
		t.Fatalf("answered twice: %v", err)
	}
}

func TestAskQuestionsRejectedCancelledAndStopped(t *testing.T) {
	b, _ := newTestBackendWith(t, true, true)
	ctx := context.Background()
	events, _ := b.Subscribe(ctx)
	ask := func(c context.Context, sid string) chan error {
		ch := make(chan error, 1)
		go func() { _, err := b.AskQuestions(c, "/w", sid, []backend.QuestionItem{{Question: "q"}}); ch <- err }()
		return ch
	}

	// dismissed by the person
	ch := ask(ctx, "s1")
	e := nextQuestionEvent(t, events, backend.EventQuestionAsked)
	if err := b.RejectQuestion(ctx, "/w", "s1", e.QuestionRequestID); err != nil {
		t.Fatal(err)
	}
	if err := <-ch; !errors.Is(err, backend.ErrQuestionDismissed) {
		t.Fatalf("rejected: %v", err)
	}
	if r := nextQuestionEvent(t, events, backend.EventQuestionResolved); r.QuestionDecision != "rejected" {
		t.Fatalf("resolved = %+v", r)
	}

	// the call is aborted (the agent gave up): the card is withdrawn
	cctx, cancel := context.WithCancel(ctx)
	ch = ask(cctx, "s1")
	nextQuestionEvent(t, events, backend.EventQuestionAsked)
	cancel()
	if err := <-ch; !errors.Is(err, backend.ErrQuestionDismissed) {
		t.Fatalf("cancelled: %v", err)
	}
	if r := nextQuestionEvent(t, events, backend.EventQuestionResolved); r.QuestionDecision != "rejected" {
		t.Fatalf("withdrawn = %+v", r)
	}

	// Stop (the turn is cancelled) dismisses what the session holds
	ch = ask(ctx, "s2")
	nextQuestionEvent(t, events, backend.EventQuestionAsked)
	if err := b.Cancel(ctx, "/w", "s2"); err != nil {
		t.Fatal(err)
	}
	if err := <-ch; !errors.Is(err, backend.ErrQuestionDismissed) {
		t.Fatalf("stopped: %v", err)
	}
}

func TestQuestionsOffWithoutTools(t *testing.T) {
	b, _ := newTestBackend(t)
	if b.Capabilities().Questions {
		t.Fatal("questions on for an agent without galopin's tools")
	}
}

func TestAskQuestionsTimesOutWithdrawsAndAllowsOnePerSession(t *testing.T) {
	b, _ := newTestBackendWith(t, true, true)
	b.questionTimeout = 150 * time.Millisecond
	ctx := context.Background()
	events, _ := b.Subscribe(ctx)
	qs := []backend.QuestionItem{{Question: "q"}}
	ch := make(chan error, 1)
	go func() { _, err := b.AskQuestions(ctx, "/w", "s1", qs); ch <- err }()
	nextQuestionEvent(t, events, backend.EventQuestionAsked)
	if _, err := b.AskQuestions(ctx, "/w", "s1", qs); !errors.Is(err, backend.ErrQuestionPending) {
		t.Fatalf("a second question in the session = %v", err)
	}
	if err := <-ch; !errors.Is(err, backend.ErrQuestionTimeout) {
		t.Fatalf("timed out = %v", err)
	}
	if r := nextQuestionEvent(t, events, backend.EventQuestionResolved); r.QuestionDecision != "rejected" {
		t.Fatalf("the card was not withdrawn: %+v", r)
	}
	// another session is not blocked, and the first can ask again
	go func() { _, _ = b.AskQuestions(ctx, "/w", "s2", qs) }()
	nextQuestionEvent(t, events, backend.EventQuestionAsked)
}
