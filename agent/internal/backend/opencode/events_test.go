package opencode

import (
	"strings"
	"testing"

	"galopin/internal/backend"
)

// A compaction part rides the ordinary message.part.updated SSE event, like
// any other part type (PROTOCOL.md §7) — no dedicated event kind.
func TestTranslateEventCompactionPart(t *testing.T) {
	b := New(Config{})
	events := b.translateEvent("/ws", "message.part.updated", map[string]any{
		"part": map[string]any{
			"id": "prt_1", "messageID": "msg_1", "sessionID": "ses_1", "type": "compaction", "auto": true,
		},
	})
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	part := events[0].Event.Part
	if part == nil || part.Type != backend.PartCompaction || !part.Auto {
		t.Fatalf("Part = %+v, want a compaction part with Auto=true", part)
	}
	if events[0].SessionID != "ses_1" {
		t.Errorf("SessionID = %q, want ses_1", events[0].SessionID)
	}
}

// An assistant message.updated event with tokens caches the session's usage
// (session.get/list read it back, PROTOCOL.md §7) alongside emitting the
// live usage event.
func TestTranslateEventMessageUpdatedCachesUsage(t *testing.T) {
	b := New(Config{})
	events := b.translateEvent("/ws", "message.updated", map[string]any{
		"info": map[string]any{
			"id": "msg_1", "sessionID": "ses_1", "role": "assistant",
			"tokens": map[string]any{"input": float64(10), "output": float64(5)},
		},
	})
	var sawUsage bool
	for _, ev := range events {
		if ev.Event.Kind == backend.EventUsage {
			sawUsage = true
		}
	}
	if !sawUsage {
		t.Fatal("expected a usage event alongside the message event")
	}
	cached := b.withUsage(backend.Session{ID: "ses_1"})
	if cached.Usage == nil || cached.Usage.Input != 10 || cached.Usage.Output != 5 {
		t.Fatalf("cached usage = %+v, want Input=10 Output=5", cached.Usage)
	}
}

// question.asked carries the whole ask, verified live against opencode
// 1.18.31's built-in "question" tool (PROTOCOL.md's user-question tool
// design): {id, sessionID, questions: [{question, header, options,
// multiple}], tool: {callID}}.
func TestTranslateEventQuestionAsked(t *testing.T) {
	b := New(Config{})
	events := b.translateEvent("/ws", "question.asked", map[string]any{
		"id":        "que_1",
		"sessionID": "ses_1",
		"questions": []any{
			map[string]any{
				"question": "Which approach?",
				"header":   "Approach",
				"options": []any{
					map[string]any{"label": "A", "description": "Do A"},
					map[string]any{"label": "B", "description": "Do B"},
				},
				"multiple": false,
			},
		},
		"tool": map[string]any{"messageID": "msg_1", "callID": "call_1"},
	})
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	ev := events[0]
	if ev.SessionID != "ses_1" {
		t.Errorf("SessionID = %q, want ses_1", ev.SessionID)
	}
	if ev.Event.Kind != backend.EventQuestionAsked {
		t.Fatalf("Kind = %v, want EventQuestionAsked", ev.Event.Kind)
	}
	if ev.Event.QuestionRequestID != "que_1" || ev.Event.QuestionCallID != "call_1" {
		t.Errorf("RequestID/CallID = %q/%q", ev.Event.QuestionRequestID, ev.Event.QuestionCallID)
	}
	if len(ev.Event.Questions) != 1 || ev.Event.Questions[0].Question != "Which approach?" ||
		ev.Event.Questions[0].Header != "Approach" || len(ev.Event.Questions[0].Options) != 2 ||
		ev.Event.Questions[0].Options[0].Label != "A" || ev.Event.Questions[0].MultiSelect {
		t.Fatalf("Questions = %+v", ev.Event.Questions)
	}
}

// question.replied and question.rejected both normalize to
// EventQuestionResolved (the same "replied"/"rejected" -> one resolved
// event unification permission.replied already does for its own decisions).
func TestTranslateEventQuestionResolved(t *testing.T) {
	b := New(Config{})

	replied := b.translateEvent("/ws", "question.replied", map[string]any{
		"sessionID": "ses_1", "requestID": "que_1",
		"answers": []any{[]any{"A"}, []any{"X", "Y"}},
	})
	if len(replied) != 1 {
		t.Fatalf("got %d events, want 1", len(replied))
	}
	ev := replied[0].Event
	if ev.Kind != backend.EventQuestionResolved || ev.QuestionRequestID != "que_1" || ev.QuestionDecision != "answered" {
		t.Fatalf("replied event = %+v", ev)
	}
	if len(ev.QuestionAnswers) != 2 || ev.QuestionAnswers[0][0] != "A" || len(ev.QuestionAnswers[1]) != 2 {
		t.Fatalf("QuestionAnswers = %+v", ev.QuestionAnswers)
	}

	rejected := b.translateEvent("/ws", "question.rejected", map[string]any{
		"sessionID": "ses_1", "requestID": "que_2",
	})
	if len(rejected) != 1 {
		t.Fatalf("got %d events, want 1", len(rejected))
	}
	ev2 := rejected[0].Event
	if ev2.Kind != backend.EventQuestionResolved || ev2.QuestionRequestID != "que_2" || ev2.QuestionDecision != "rejected" {
		t.Fatalf("rejected event = %+v", ev2)
	}
}

// session.error carries the error object under properties.error, not
// flattened properties (verified against 1.18.34): an APIError's message and
// HTTP status live in data. The event must carry the provider's own text and
// the status — and never the response headers or body, which can hold
// account details. Real payload from a Cortecs 401.
func TestTranslateEventSessionErrorCarriesProviderDetail(t *testing.T) {
	b := New(Config{})
	events := b.translateEvent("/ws", "session.error", map[string]any{
		"sessionID": "ses_1",
		"error": map[string]any{
			"name": "APIError",
			"data": map[string]any{
				"message":         "AuthenticationError: Insufficient Balance.",
				"statusCode":      float64(401),
				"isRetryable":     false,
				"responseHeaders": map[string]any{"x-request-id": "req_secret"},
				"responseBody":    `{"detail":"account_secret"}`,
			},
		},
	})
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	ev := events[0].Event
	if ev.Kind != backend.EventError {
		t.Fatalf("Kind = %v, want EventError", ev.Kind)
	}
	if ev.ErrorMessage != "AuthenticationError: Insufficient Balance." {
		t.Errorf("ErrorMessage = %q", ev.ErrorMessage)
	}
	if ev.ErrorCode != "401" {
		t.Errorf("ErrorCode = %q, want 401", ev.ErrorCode)
	}
	if strings.Contains(ev.ErrorMessage, "secret") || strings.Contains(ev.ErrorCode, "secret") {
		t.Errorf("response headers/body leaked into the event: %q / %q", ev.ErrorMessage, ev.ErrorCode)
	}
}

// An error object without a statusCode (UnknownError) still carries its
// message, with no code invented for it.
func TestTranslateEventSessionErrorWithoutStatus(t *testing.T) {
	b := New(Config{})
	events := b.translateEvent("/ws", "session.error", map[string]any{
		"sessionID": "ses_1",
		"error": map[string]any{
			"name": "UnknownError",
			"data": map[string]any{"message": "Something went wrong", "ref": "evt_1"},
		},
	})
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	ev := events[0].Event
	if ev.ErrorMessage != "Something went wrong" || ev.ErrorCode != "" {
		t.Errorf("event = %+v, want the message and no code", ev)
	}
}

// A Stop is not a failure: opencode records the abort as MessageAbortedError
// and the idle that follows ends the turn, so the event must not reach Cerea
// as a failed turn.
func TestTranslateEventSessionErrorAbortedIsDropped(t *testing.T) {
	b := New(Config{})
	events := b.translateEvent("/ws", "session.error", map[string]any{
		"sessionID": "ses_1",
		"error": map[string]any{
			"name": "MessageAbortedError",
			"data": map[string]any{"message": "Aborted"},
		},
	})
	if len(events) != 0 {
		t.Fatalf("got %d events, want none for an abort", len(events))
	}
}

// A session.status retry carries why the session waits (PROTOCOL.md §7): the
// provider's message, the attempt and the next try. The status's `action` is
// never forwarded, and an overlong message is clipped.
func TestTranslateEventStatusRetry(t *testing.T) {
	b := New(Config{})
	events := b.translateEvent("/ws", "session.status", map[string]any{
		"sessionID": "ses_1",
		"status": map[string]any{
			"type": "retry", "attempt": float64(3), "message": "Rate limit exceeded", "next": float64(1760000000000),
			"action": map[string]any{"title": "Upgrade", "link": "https://example.test/billing"},
		},
	})
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	ev := events[0].Event
	if ev.Status != backend.StatusRetry || ev.Retry == nil {
		t.Fatalf("event = %+v, want a retry status with Retry set", ev)
	}
	if *ev.Retry != (backend.RetryInfo{Attempt: 3, Message: "Rate limit exceeded", Next: 1760000000000}) {
		t.Errorf("Retry = %+v", *ev.Retry)
	}

	long := b.translateEvent("/ws", "session.status", map[string]any{
		"sessionID": "ses_1",
		"status":    map[string]any{"type": "retry", "attempt": float64(1), "message": strings.Repeat("x", 1000)},
	})
	if n := len([]rune(long[0].Event.Retry.Message)); n > maxErrorMessage+1 {
		t.Errorf("message not clipped: %d runes", n)
	}

	busy := b.translateEvent("/ws", "session.status", map[string]any{
		"sessionID": "ses_1", "status": map[string]any{"type": "busy"},
	})
	if busy[0].Event.Status != backend.StatusBusy || busy[0].Event.Retry != nil {
		t.Errorf("busy = %+v, want no Retry", busy[0].Event)
	}
}
