package main

import (
	"context"
	"strings"
	"testing"

	"galopin/internal/backend"
)

// A session created by session_spawn is a delegate of its spawner (ADR 0099):
// between the two, with no card, the spawner reads and sends to the delegate
// and the delegate sends to the spawner. Everything else stays gated.

func TestSpawnerReadsItsDelegateWithNoCard(t *testing.T) {
	r := newCoordRig(t, nil) // default policy, the session's word is Ask
	r.markSpawned("peer", "caller")
	r.say("peer", "assistant", "found the bug in parser.go", t0)
	out, err := r.call("caller", "session_read", map[string]any{"target": "peer"})
	if err != nil || !strings.Contains(out, "found the bug") {
		t.Fatalf("read of a delegate: %v %q", err, out)
	}
	if a := r.asks(); len(a) != 0 {
		t.Fatalf("a spawner's read of its delegate raised %d card(s): %+v", len(a), a)
	}
}

func TestSpawnerSendsToDelegateAndDelegateRepliesWithNoCard(t *testing.T) {
	r := newCoordRig(t, nil)
	r.markSpawned("peer", "caller")
	if _, err := r.call("caller", "session_send", map[string]any{"target": "peer", "text": "also run the tests"}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.call("peer", "session_send", map[string]any{"target": "caller", "text": "done"}); err != nil {
		t.Fatal(err)
	}
	if a := r.asks(); len(a) != 0 {
		t.Fatalf("delegate pair sends raised cards: %+v", a)
	}
	if ps := r.prompts(); len(ps) != 2 {
		t.Fatalf("prompts = %d, want 2", len(ps))
	}
}

func TestDelegateRelationIsDirectAndOneWayForReads(t *testing.T) {
	r := newCoordRig(t, nil)
	r.markSpawned("peer", "caller")
	r.say("caller", "assistant", "the person's plans", t0)
	// The delegate does not read its spawner without a card.
	if _, err := r.call("peer", "session_read", map[string]any{"target": "caller"}); err != nil {
		t.Fatal(err)
	}
	if a := r.asks(); len(a) != 1 || a[0].Tool != "session_read" {
		t.Fatalf("delegate reading its spawner: asks = %+v, want one card", a)
	}
}

func TestUnrelatedSessionsStillAsk(t *testing.T) {
	r := newCoordRig(t, nil)
	r.addSession(r.w1, "third", "Third", "")
	r.markSpawned("peer", "caller") // peer is caller's delegate, not third's
	r.say("peer", "assistant", "x", t0)
	if _, err := r.call("third", "session_read", map[string]any{"target": "peer"}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.call("third", "session_send", map[string]any{"target": "peer", "text": "hi"}); err != nil {
		t.Fatal(err)
	}
	// Not transitive: a grandchild is no delegate of the root.
	r.addSession(r.w1, "grand", "Grand", "")
	r.markSpawned("grand", "peer")
	if _, err := r.call("caller", "session_read", map[string]any{"target": "grand"}); err != nil {
		t.Fatal(err)
	}
	if a := r.asks(); len(a) != 3 {
		t.Fatalf("asks = %d, want 3 cards (unrelated read, unrelated send, grandchild read): %+v", len(a), a)
	}
}

func TestDelegateAcrossWorkspacesStillAsks(t *testing.T) {
	r := newCoordRig(t, nil)
	r.markSpawned("other", "caller") // marker says delegate, but it lives in another workspace
	r.say("other", "assistant", "x", t0)
	if _, err := r.call("caller", "session_read", map[string]any{"target": "other"}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.call("caller", "session_send", map[string]any{"target": "other", "text": "hi"}); err != nil {
		t.Fatal(err)
	}
	if a := r.asks(); len(a) != 2 {
		t.Fatalf("cross-workspace delegate calls: asks = %d, want 2", len(a))
	}
}

func TestMachineCeilingBeatsTheDelegateRelation(t *testing.T) {
	for _, tool := range []string{"session_read", "session_send"} {
		r := newCoordRig(t, withMax(tool, "ask"))
		r.markSpawned("peer", "caller")
		r.say("peer", "assistant", "x", t0)
		args := map[string]any{"target": "peer"}
		if tool == "session_send" {
			args["text"] = "hi"
		}
		if _, err := r.call("caller", tool, args); err != nil {
			t.Fatal(err)
		}
		if a := r.asks(); len(a) != 1 {
			t.Fatalf("%s with a machine ceiling at ask: asks = %d, want 1", tool, len(a))
		}
		r2 := newCoordRig(t, withMax(tool, "deny"))
		r2.markSpawned("peer", "caller")
		_, err := r2.call("caller", tool, args)
		refusedWith(t, err, "do not allow")
	}
}

func TestDelegateSendPastHopLimitStillAsks(t *testing.T) {
	r := newCoordRig(t, nil)
	r.markSpawned("peer", "caller")
	r.mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{WorkspaceDir: r.w1.Path, SessionID: "peer", Event: backend.Event{
		Kind: backend.EventMessage, Message: &backend.Message{ID: "m1", Role: "user", SentBy: &backend.MessageSender{SessionID: "caller", Hop: 3}},
	}})
	if _, err := r.call("peer", "session_send", map[string]any{"target": "caller", "text": "x"}); err != nil {
		t.Fatal(err)
	}
	if a := r.asks(); len(a) != 1 {
		t.Fatalf("hop 4 delegate send: asks = %d, want 1", len(a))
	}
}
