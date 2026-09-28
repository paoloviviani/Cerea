package acp

import (
	"context"
	"errors"
	"testing"
	"time"

	"galopin/internal/backend"
)

// The commands capability over ACP (PROTOCOL.md §6 backend.commands /
// session.command), pinned on the things that are easy to get wrong: the
// list is the agent's own available_commands_update and nothing more
// (empty before the first one — no guessing), a run is the ordinary prompt
// path with the invocation as its text, the marker rides on the message
// this backend synthesizes, and a busy session refuses with the A0
// sentinel instead of clobbering the turn.

func TestCapabilitiesAdvertiseCommands(t *testing.T) {
	b, _ := newTestBackend(t)
	if !b.Capabilities().Commands {
		t.Fatal("Capabilities().Commands = false, want true (the per-session list is the contract)")
	}
}

func TestListCommandsIsEmptyBeforeTheFirstUpdate(t *testing.T) {
	b, _ := newTestBackend(t)
	commands, err := b.ListCommands(context.Background(), "/work", "sess-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 0 {
		t.Fatalf("commands = %+v, want empty before any available_commands_update", commands)
	}
}

func TestListCommandsMapsTheAgentsUpdate(t *testing.T) {
	b, fa := newTestBackend(t)
	ctx := context.Background()

	sess, err := b.CreateSession(ctx, "/work", backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	fa.update(sess.ID, map[string]any{
		"sessionUpdate": "available_commands_update",
		"availableCommands": []any{
			map[string]any{"name": "review", "description": "review changes", "input": map[string]any{"hint": "[commit|branch|pr]"}},
			map[string]any{"name": "deploy", "description": "ship it"},
		},
	})

	// The notification is asynchronous; the cache is populated when the
	// read loop has processed it.
	var commands []backend.Command
	deadline := time.Now().Add(5 * time.Second)
	for {
		var err error
		commands, err = b.ListCommands(ctx, "/work", sess.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(commands) == 2 || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(commands) != 2 {
		t.Fatalf("commands = %+v, want two", commands)
	}
	review := commands[0]
	if review.Name != "review" || review.Description != "review changes" {
		t.Errorf("first command = %+v, want the update's own fields", review)
	}
	if len(review.Hints) != 1 || review.Hints[0] != "[commit|branch|pr]" {
		t.Errorf("hints = %v, want input.hint verbatim", review.Hints)
	}
	// Nothing the update did not say: shell unknown, no origin, no hash.
	if review.Shell != nil {
		t.Error("shell must be nil (unknown) for an ACP command")
	}
	if review.Origin != "" || review.TemplateHash != "" {
		t.Errorf("origin = %q, hash = %q, want neither claimed", review.Origin, review.TemplateHash)
	}
	// A different session still has nothing: the list is per session.
	other, err := b.ListCommands(ctx, "/work", "sess-other")
	if err != nil {
		t.Fatal(err)
	}
	if len(other) != 0 {
		t.Fatalf("another session's list = %+v, want empty", other)
	}
}

func TestRunCommandSendsTheInvocationAndMarksTheMessage(t *testing.T) {
	b, fa := newTestBackend(t)
	ctx := context.Background()
	dir := "/work"

	sess, err := b.CreateSession(ctx, dir, backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	events, _ := b.Subscribe(ctx)

	if err := b.RunCommand(ctx, dir, sess.ID, backend.CommandRun{
		Name: "review", Arguments: "HEAD~1", ClientMessageID: "cm-9",
	}); err != nil {
		t.Fatalf("RunCommand: %v", err)
	}

	select {
	case <-fa.promptReqs:
	case <-time.After(5 * time.Second):
		t.Fatal("fake agent never saw the session/prompt")
	}
	sent := <-fa.promptParams
	if sent["sessionId"] != sess.ID {
		t.Fatalf("session/prompt sessionId = %v, want %q", sent["sessionId"], sess.ID)
	}
	blocks := sent["prompt"].([]any)
	first := blocks[0].(map[string]any)
	if first["type"] != "text" || first["text"] != "/review HEAD~1" {
		t.Fatalf("prompt text block = %v, want the invocation as text", first)
	}

	// The user message this backend synthesized carries the marker.
	evs := drainEvents(t, events, sess.ID, 5*time.Second, func(ev backend.Event) bool {
		return ev.Kind == backend.EventMessage && ev.Message != nil && ev.Message.Role == "user"
	})
	for _, ev := range evs {
		if ev.Message.Command == nil {
			continue
		}
		if ev.Message.Command.Name != "review" || ev.Message.Command.Arguments != "HEAD~1" {
			t.Fatalf("marker = %+v, want review HEAD~1", ev.Message.Command)
		}
		if ev.Message.ClientMessageID != "cm-9" {
			t.Errorf("ClientMessageID = %q, want cm-9 carried through the prompt path", ev.Message.ClientMessageID)
		}
		return
	}
	t.Fatal("no user message carried a command marker")
}

func TestRunCommandRefusesWhileBusy(t *testing.T) {
	b, fa := newTestBackend(t)
	ctx := context.Background()
	dir := "/work"

	sess, err := b.CreateSession(ctx, dir, backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	events, _ := b.Subscribe(ctx)

	if err := b.Prompt(ctx, dir, sess.ID, backend.Prompt{Text: "first"}); err != nil {
		t.Fatal(err)
	}
	var first fakePromptReq
	select {
	case first = <-fa.promptReqs:
	case <-time.After(5 * time.Second):
		t.Fatal("fake agent never saw the first session/prompt")
	}

	if err := b.RunCommand(ctx, dir, sess.ID, backend.CommandRun{Name: "review"}); !errors.Is(err, backend.ErrSessionBusy) {
		t.Fatalf("RunCommand while busy = %v, want ErrSessionBusy (a second prompt would clobber the turn ids)", err)
	}

	// Nothing reached the agent: the refusal happened before the wire.
	select {
	case pr := <-fa.promptReqs:
		t.Fatalf("a command's prompt reached a busy session for %s", pr.sessionID)
	case <-time.After(200 * time.Millisecond):
	}

	// Once the turn ends, the same run goes through.
	fa.respond(first.id, map[string]any{"stopReason": "end_turn"})
	drainEvents(t, events, sess.ID, 5*time.Second, isIdle)
	if err := b.RunCommand(ctx, dir, sess.ID, backend.CommandRun{Name: "review"}); err != nil {
		t.Fatalf("RunCommand after the turn ended: %v", err)
	}
	select {
	case <-fa.promptReqs:
	case <-time.After(5 * time.Second):
		t.Fatal("fake agent never saw the post-turn command prompt")
	}
}
