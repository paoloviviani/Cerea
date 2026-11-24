package acp

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
)

// waitQueue reads events until a queue event lists exactly these ids.
func waitQueue(t *testing.T, ch <-chan backend.BackendEvent, sessionID string, want ...string) backend.Event {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-ch:
			if ev.SessionID != sessionID || ev.Event.Kind != backend.EventQueue {
				continue
			}
			var got []string
			for _, q := range ev.Event.Queued {
				got = append(got, q.ID)
			}
			if strings.Join(got, ",") == strings.Join(want, ",") {
				return ev.Event
			}
		case <-deadline:
			t.Fatalf("no queue event listing %v", want)
		}
	}
}

func startRunning(t *testing.T, b *Backend, fa *fakeAgent) (backend.Session, fakePromptReq, <-chan backend.BackendEvent) {
	t.Helper()
	ctx := context.Background()
	sess, err := b.CreateSession(ctx, "/work", backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	events, _ := b.Subscribe(ctx)
	if err := b.Prompt(ctx, "/work", sess.ID, backend.Prompt{Text: "first"}); err != nil {
		t.Fatal(err)
	}
	select {
	case pr := <-fa.promptReqs:
		return sess, pr, events
	case <-time.After(5 * time.Second):
		t.Fatal("the agent never saw the first prompt")
	}
	return sess, fakePromptReq{}, events
}

func noPrompt(t *testing.T, fa *fakeAgent, why string) {
	t.Helper()
	select {
	case <-fa.promptReqs:
		t.Fatal(why)
	case <-time.After(200 * time.Millisecond):
	}
}

// A prompt sent while a turn runs is held, not sent to the agent (a second session/prompt
// would clobber the running turn's state), announced as waiting, and sent in order when
// the turn ends.
func TestPromptWhileBusyIsQueuedAndSentInOrderWhenTheTurnEnds(t *testing.T) {
	b, fa := newTestBackend(t)
	ctx := context.Background()
	if !b.Capabilities().Queue {
		t.Fatal("the queue capability is off")
	}
	sess, first, events := startRunning(t, b, fa)

	if err := b.Prompt(ctx, "/work", sess.ID, backend.Prompt{Text: "second", ClientMessageID: "c2"}); err != nil {
		t.Fatalf("a prompt mid-turn must be queued, not refused: %v", err)
	}
	if err := b.Prompt(ctx, "/work", sess.ID, backend.Prompt{Text: "third", ClientMessageID: "c3"}); err != nil {
		t.Fatal(err)
	}
	ev := waitQueue(t, events, sess.ID, "c2", "c3")
	if ev.Queued[0].Text != "second" {
		t.Errorf("queue = %+v", ev.Queued)
	}
	noPrompt(t, fa, "a queued prompt reached the agent mid-turn")
	tr, _ := b.Transcript(ctx, "/work", sess.ID)
	users := 0
	for _, m := range tr.Messages {
		if m.Message.Role == "user" {
			users++
		}
	}
	if users != 1 {
		t.Errorf("transcript has %d user messages before the turn ended, want 1", users)
	}

	fa.respond(first.id, map[string]any{"stopReason": "end_turn"})
	var second fakePromptReq
	select {
	case second = <-fa.promptReqs:
	case <-time.After(5 * time.Second):
		t.Fatal("the queued prompt was not sent when the turn ended")
	}
	if p := (<-fa.promptParams); p["sessionId"] != sess.ID { // the first turn's params
		t.Fatalf("params = %v", p)
	}
	p := <-fa.promptParams
	blocks, _ := p["prompt"].([]any)
	if len(blocks) == 0 || !strings.Contains(strings.ToLower(jsonText(blocks)), "second") {
		t.Fatalf("the second prompt was not 'second': %v", p["prompt"])
	}
	waitQueue(t, events, sess.ID, "c3")
	noPrompt(t, fa, "the third prompt went out before the second turn ended")
	fa.respond(second.id, map[string]any{"stopReason": "end_turn"})
	select {
	case <-fa.promptReqs:
	case <-time.After(5 * time.Second):
		t.Fatal("the third prompt was not sent")
	}
	waitQueue(t, events, sess.ID)
}

func jsonText(v any) string {
	var sb strings.Builder
	var walk func(any)
	walk = func(x any) {
		switch t := x.(type) {
		case string:
			sb.WriteString(t + " ")
		case []any:
			for _, e := range t {
				walk(e)
			}
		case map[string]any:
			for _, e := range t {
				walk(e)
			}
		}
	}
	walk(v)
	return sb.String()
}

func TestDequeueWithdrawsAWaitingPromptAndAStoppedTurnClearsTheQueue(t *testing.T) {
	b, fa := newTestBackend(t)
	ctx := context.Background()
	sess, first, events := startRunning(t, b, fa)
	for _, id := range []string{"c2", "c3"} {
		if err := b.Prompt(ctx, "/work", sess.ID, backend.Prompt{Text: id, ClientMessageID: id}); err != nil {
			t.Fatal(err)
		}
	}
	waitQueue(t, events, sess.ID, "c2", "c3")
	if err := b.Dequeue(ctx, "/work", sess.ID, "c2"); err != nil {
		t.Fatal(err)
	}
	waitQueue(t, events, sess.ID, "c3")
	if err := b.Dequeue(ctx, "/work", sess.ID, "c2"); !errors.Is(err, backend.ErrNotQueued) {
		t.Fatalf("dequeued twice: %v", err)
	}
	// Stop: what waits is dropped, so nothing is sent when the turn ends
	if err := b.Cancel(ctx, "/work", sess.ID); err != nil {
		t.Fatal(err)
	}
	waitQueue(t, events, sess.ID)
	fa.respond(first.id, map[string]any{"stopReason": "cancelled"})
	noPrompt(t, fa, "a prompt queued before Stop was sent after it")
}

func TestQueueIsBoundedAndARetryDoesNotDuplicate(t *testing.T) {
	b, fa := newTestBackend(t)
	ctx := context.Background()
	sess, _, _ := startRunning(t, b, fa)
	for i := 0; i < maxQueued; i++ {
		if err := b.Prompt(ctx, "/work", sess.ID, backend.Prompt{Text: "x", ClientMessageID: string(rune('a' + i))}); err != nil {
			t.Fatal(err)
		}
	}
	if err := b.Prompt(ctx, "/work", sess.ID, backend.Prompt{Text: "x", ClientMessageID: "a"}); err != nil {
		t.Fatalf("a retry of a waiting prompt: %v", err)
	}
	if err := b.Prompt(ctx, "/work", sess.ID, backend.Prompt{Text: "overflow", ClientMessageID: "zz"}); !errors.Is(err, backend.ErrSessionBusy) {
		t.Fatalf("overflow = %v, want ErrSessionBusy", err)
	}
}

// A command is not queued: it runs now or not at all.
func TestCommandsAreStillRefusedWhileBusy(t *testing.T) {
	b, fa := newTestBackend(t)
	sess, _, _ := startRunning(t, b, fa)
	err := b.RunCommand(context.Background(), "/work", sess.ID, backend.CommandRun{Name: "compact"})
	if !errors.Is(err, backend.ErrSessionBusy) {
		t.Fatalf("RunCommand mid-turn = %v, want ErrSessionBusy", err)
	}
}

// A follow-up arriving exactly as the turn ends neither overtakes the queue nor is lost.
func TestFollowUpAtTurnEndQueuesBehindAndNothingIsLost(t *testing.T) {
	for i := 0; i < 25; i++ {
		b, fa := newTestBackend(t)
		ctx := context.Background()
		sess, first, events := startRunning(t, b, fa)
		if err := b.Prompt(ctx, "/work", sess.ID, backend.Prompt{Text: "c2", ClientMessageID: "c2"}); err != nil {
			t.Fatal(err)
		}
		waitQueue(t, events, sess.ID, "c2")
		done := make(chan error, 1)
		go func() { done <- b.Prompt(ctx, "/work", sess.ID, backend.Prompt{Text: "c3", ClientMessageID: "c3"}) }()
		fa.respond(first.id, map[string]any{"stopReason": "end_turn"})
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		<-fa.promptParams // the first turn's own
		var order []string
		for len(order) < 2 {
			select {
			case pr := <-fa.promptReqs:
				p := <-fa.promptParams
				txt := strings.TrimSpace(jsonText(p["prompt"]))
				order = append(order, txt)
				fa.respond(pr.id, map[string]any{"stopReason": "end_turn"})
			case <-time.After(5 * time.Second):
				t.Fatalf("iteration %d: only %v went out", i, order)
			}
		}
		// first's params were consumed too: order holds c2 then c3
		if !strings.Contains(order[0], "c2") || !strings.Contains(order[1], "c3") {
			t.Fatalf("iteration %d: order %v", i, order)
		}
	}
}

func TestRetryOfASentPromptIsNotSentTwiceAndCompactWaitsForTheQueue(t *testing.T) {
	b, fa := newTestBackend(t)
	ctx := context.Background()
	sess, first, events := startRunning(t, b, fa)
	if err := b.Prompt(ctx, "/work", sess.ID, backend.Prompt{Text: "again", ClientMessageID: "c2"}); err != nil {
		t.Fatal(err)
	}
	waitQueue(t, events, sess.ID, "c2")
	err := b.RunCommand(ctx, "/work", sess.ID, backend.CommandRun{Name: "help"})
	if !errors.Is(err, backend.ErrSessionBusy) {
		t.Fatalf("a command with a queue waiting = %v", err)
	}
	fa.respond(first.id, map[string]any{"stopReason": "end_turn"})
	pr := <-fa.promptReqs
	<-fa.promptParams
	<-fa.promptParams
	// the running (formerly queued) prompt is retried: dropped, not queued again
	if err := b.Prompt(ctx, "/work", sess.ID, backend.Prompt{Text: "again", ClientMessageID: "c2"}); err != nil {
		t.Fatal(err)
	}
	fa.respond(pr.id, map[string]any{"stopReason": "end_turn"})
	noPrompt(t, fa, "a retried prompt was sent twice")
}

func TestHiddenCommandsAreNeitherListedNorRun(t *testing.T) {
	b, _ := newTestBackendCfg(t, false, func(c *Config) { c.HiddenCommands = []string{"reload"} })
	ctx := context.Background()
	sess, err := b.CreateSession(ctx, "/work", backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := b.RunCommand(ctx, "/work", sess.ID, backend.CommandRun{Name: "reload"}); err == nil {
		t.Fatal("/reload ran")
	}
	if err := b.Prompt(ctx, "/work", sess.ID, backend.Prompt{Text: "  /Reload now"}); err == nil {
		t.Fatal("a typed /reload went through")
	}
}
