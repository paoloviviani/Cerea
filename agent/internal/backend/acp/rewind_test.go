package acp

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"galopin/internal/backend"
)

func userEcho(fa *fakeAgent, sid, entry, text string) {
	fa.update(sid, map[string]any{"sessionUpdate": "user_message_chunk", "messageId": entry, "content": map[string]any{"type": "text", "text": text}})
}

// runTurn sends a prompt, has the agent echo it with its own id and end the turn.
func runTurn(t *testing.T, b *Backend, fa *fakeAgent, events <-chan backend.BackendEvent, sid, text, entry string) {
	t.Helper()
	if err := b.Prompt(context.Background(), "/work", sid, backend.Prompt{Text: text}); err != nil {
		t.Fatal(err)
	}
	pr := <-fa.promptReqs
	<-fa.promptParams
	userEcho(fa, sid, entry, text)
	fa.update(sid, map[string]any{"sessionUpdate": "agent_message_chunk", "messageId": "a-" + entry, "content": map[string]any{"type": "text", "text": "re: " + text}})
	fa.respond(pr.id, map[string]any{"stopReason": "end_turn"})
	drainEvents(t, events, sid, 5*time.Second, isIdle)
}

func userIDs(t *testing.T, b *Backend, sid string) []string {
	t.Helper()
	tr, err := b.Transcript(context.Background(), "/work", sid)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range tr.Messages {
		if e.Message.Role == "user" {
			out = append(out, e.Message.ID)
		}
	}
	return out
}

func TestRevertRewindsByTheAgentsOwnEntryIDAndTruncatesTheTranscript(t *testing.T) {
	b, fa := newTestBackendCfg(t, false, func(c *Config) { c.Rewind = true })
	var rewound map[string]any
	fa.hook = func(fa *fakeAgent, id json.RawMessage, method string, p map[string]any) bool {
		if method == "_rewind/to" {
			rewound = p
			fa.respond(id, map[string]any{"messageContent": "x", "restoredPaths": []any{}, "restoreErrors": []any{}})
			return true
		}
		return false
	}
	caps := b.Capabilities()
	if !caps.Revert || !caps.RevertFiles || caps.Unrevert {
		t.Fatalf("caps %+v", caps)
	}
	ctx := context.Background()
	sess, _ := b.CreateSession(ctx, "/work", backend.CreateSessionOptions{})
	events, _ := b.Subscribe(ctx)
	runTurn(t, b, fa, events, sess.ID, "one", "e1")
	runTurn(t, b, fa, events, sess.ID, "two", "e2")
	users := userIDs(t, b, sess.ID)
	if len(users) != 2 {
		t.Fatalf("the echo duplicated the user message: %v", users)
	}
	if err := b.Revert(ctx, "/work", sess.ID, users[1]); err != nil {
		t.Fatal(err)
	}
	if rewound["messageId"] != "e2" || rewound["restoreFiles"] != true {
		t.Fatalf("rewind params = %v", rewound)
	}
	if got := userIDs(t, b, sess.ID); len(got) != 1 || got[0] != users[0] {
		t.Fatalf("after the rollback: %v", got)
	}
	if err := b.Unrevert(ctx, "/work", sess.ID); err == nil {
		t.Fatal("unrevert worked")
	}
	if err := b.Revert(ctx, "/work", sess.ID, "nope"); err == nil {
		t.Fatal("an unknown message was rolled back")
	}
}

func TestForkNamesTheNextUserMessageAndCopiesTheHistoryBefore(t *testing.T) {
	b, fa := newTestBackendCfg(t, false, func(c *Config) { c.Fork = true })
	var forkParams map[string]any
	fa.hook = func(fa *fakeAgent, id json.RawMessage, method string, p map[string]any) bool {
		if method == "session/fork" {
			forkParams = p
			fa.respond(id, map[string]any{"sessionId": "forked-1", "configOptions": []any{}})
			return true
		}
		return false
	}
	ctx := context.Background()
	sess, _ := b.CreateSession(ctx, "/work", backend.CreateSessionOptions{})
	events, _ := b.Subscribe(ctx)
	runTurn(t, b, fa, events, sess.ID, "one", "e1")
	runTurn(t, b, fa, events, sess.ID, "two", "e2")
	tr, _ := b.Transcript(ctx, "/work", sess.ID)
	var firstAssistant string
	for _, e := range tr.Messages {
		if e.Message.Role == "assistant" && firstAssistant == "" {
			firstAssistant = e.Message.ID
		}
	}
	child, err := b.Fork(ctx, "/work", sess.ID, firstAssistant, "Fork: x")
	if err != nil {
		t.Fatal(err)
	}
	if forkParams["message_id"] != "e2" {
		t.Fatalf("fork params = %v, want message_id e2 (the user message after the chosen answer)", forkParams)
	}
	if child.ID != "forked-1" || child.Title != "Fork: x" {
		t.Fatalf("child = %+v", child)
	}
	if got := userIDs(t, b, child.ID); len(got) != 1 {
		t.Fatalf("the fork's history = %v", got)
	}
	// from the last turn: the whole session, no message_id
	var last string
	for _, e := range tr.Messages {
		if e.Message.Role == "assistant" {
			last = e.Message.ID
		}
	}
	if _, err := b.Fork(ctx, "/work", sess.ID, last, ""); err != nil {
		t.Fatal(err)
	}
	if _, has := forkParams["message_id"]; has {
		t.Fatalf("fork of the last turn sent %v", forkParams)
	}
}

func TestSubagentToolCallBecomesATaskCardAndAChildSession(t *testing.T) {
	b, fa := newTestBackendCfg(t, false, func(c *Config) { c.Subagents = true })
	ctx := context.Background()
	sess, _ := b.CreateSession(ctx, "/work", backend.CreateSessionOptions{})
	events, _ := b.Subscribe(ctx)
	if err := b.Prompt(ctx, "/work", sess.ID, backend.Prompt{Text: "delegate"}); err != nil {
		t.Fatal(err)
	}
	pr := <-fa.promptReqs
	<-fa.promptParams
	call := func(status string, meta map[string]any) {
		fa.update(sess.ID, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "c1", "kind": "think", "title": "Starting scout",
			"status": status, "rawInput": map[string]any{"task": "look around", "agent": "explore"}, "_meta": meta})
	}
	call("in_progress", map[string]any{"effect_kind": "subagent", "agent": "explore", "task": "look around"})
	call("completed", map[string]any{"effect_kind": "subagent", "agent": "explore", "task": "look around", "child_session_id": "child-1", "response": "found it", "turn_count": 3})
	fa.respond(pr.id, map[string]any{"stopReason": "end_turn"})
	drainEvents(t, events, sess.ID, 5*time.Second, isIdle)

	tr, _ := b.Transcript(ctx, "/work", sess.ID)
	var card *backend.Part
	for _, e := range tr.Messages {
		for i, p := range e.Parts {
			if p.Type == backend.PartTool {
				card = &e.Parts[i]
			}
		}
	}
	if card == nil || card.Tool != "task" || card.SubtaskSessionID != "child-1" || card.Input["subagent_type"] != "explore" {
		t.Fatalf("card = %+v", card)
	}
	kids, _ := b.Children(ctx, "/work", sess.ID)
	if len(kids) != 1 || kids[0].ID != "child-1" || kids[0].ParentID != sess.ID || kids[0].Status != backend.StatusIdle {
		t.Fatalf("children = %+v", kids)
	}
	ctr, err := b.Transcript(ctx, "/work", "child-1")
	if err != nil || len(ctr.Messages) != 2 || ctr.Messages[1].Parts[0].Text != "found it" {
		t.Fatalf("child transcript = %+v, %v", ctr, err)
	}
	if !b.Capabilities().Children {
		t.Fatal("children off")
	}
	list, _ := b.ListSessions(ctx, "/work")
	for _, s := range list {
		if s.ID == "child-1" {
			t.Fatal("the child is listed as a session")
		}
	}
}
