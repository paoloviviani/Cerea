package acp

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/permrules"
)

func runTurnIn(t *testing.T, b *Backend, fa *fakeAgent, events <-chan backend.BackendEvent, dir, sid, text, entry string) {
	t.Helper()
	if err := b.Prompt(context.Background(), dir, sid, backend.Prompt{Text: text}); err != nil {
		t.Fatal(err)
	}
	pr := <-fa.promptReqs
	<-fa.promptParams
	userEcho(fa, sid, entry, text)
	fa.respond(pr.id, map[string]any{"stopReason": "end_turn"})
	drainEvents(t, events, sid, 5*time.Second, isIdle)
}

func userIDsIn(t *testing.T, b *Backend, dir, sid string) []string {
	t.Helper()
	tr, err := b.Transcript(context.Background(), dir, sid)
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
	if err := b.Revert(ctx, t.TempDir(), sess.ID, users[1]); err != nil {
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
	if err := b.Revert(ctx, t.TempDir(), sess.ID, "nope"); err == nil {
		t.Fatal("an unknown message was rolled back")
	}
}

func TestForkNamesTheUserMessageOfTheChosenTurnAndCopiesTheHistory(t *testing.T) {
	// an agent without session/close: the fork cannot be reloaded, galopin's copy stands
	b, fa := newTestBackendCfg(t, false, func(c *Config) { c.Fork = true }, func(fa *fakeAgent) {
		fa.capsFn = func(caps map[string]any) { delete(caps["sessionCapabilities"].(map[string]any), "close") }
	})
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
	if getMap(forkParams, "_meta")["messageId"] != "e1" {
		t.Fatalf("fork params = %v, want _meta.messageId e1 (the user message of the chosen answer's turn)", forkParams)
	}
	if child.ID != "forked-1" || child.Title != "Fork: x" {
		t.Fatalf("child = %+v", child)
	}
	if got := userIDs(t, b, child.ID); len(got) != 1 {
		t.Fatalf("the fork's history = %v", got)
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

func TestRewindPathsOutsideTheWorkspaceOrThroughSymlinksAreRefused(t *testing.T) {
	root := t.TempDir()
	home := t.TempDir()
	bashrc := filepath.Join(home, ".bashrc")
	if err := os.WriteFile(bashrc, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(bashrc, filepath.Join(root, "link.txt")); err != nil {
		t.Skip("no symlinks")
	}
	if err := os.Symlink(home, filepath.Join(root, "linkdir")); err != nil {
		t.Skip("no symlinks")
	}
	if err := os.WriteFile(filepath.Join(root, "ok.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	b := New(Config{Protect: func(_, p string) bool { return filepath.Base(p) == ".env" }})
	for name, p := range map[string]string{
		"outside":                 bashrc,
		"parent escape":           filepath.Join(root, "..", "elsewhere.txt"),
		"a symlink to a file":     filepath.Join(root, "link.txt"),
		"through a symlinked dir": filepath.Join(root, "linkdir", "new.txt"),
		"protected":               filepath.Join(root, ".env"),
	} {
		if err := b.checkRewindPaths(root, []string{p}); err == nil {
			t.Errorf("%s: %s was accepted", name, p)
		}
	}
	for _, p := range []string{filepath.Join(root, "ok.txt"), "ok.txt", filepath.Join(root, "sub", "deleted", "new.go")} {
		if err := b.checkRewindPaths(root, []string{p}); err != nil {
			t.Errorf("%s refused: %v", p, err)
		}
	}
}

func TestRevertWithAnEscapingPreviewNeverCallsRewindTo(t *testing.T) {
	b, fa := newTestBackendCfg(t, false, func(c *Config) { c.Rewind = true })
	root := t.TempDir()
	toCalls := 0
	fa.hook = func(fa *fakeAgent, id json.RawMessage, method string, p map[string]any) bool {
		switch method {
		case "_rewind/preview":
			fa.respond(id, map[string]any{"paths": []any{"/etc/passwd"}})
			return true
		case "_rewind/to":
			toCalls++
		}
		return false
	}
	ctx := context.Background()
	sess, _ := b.CreateSession(ctx, root, backend.CreateSessionOptions{})
	events, _ := b.Subscribe(ctx)
	runTurnIn(t, b, fa, events, root, sess.ID, "one", "e1")
	users := userIDsIn(t, b, root, sess.ID)
	if err := b.Revert(ctx, root, sess.ID, users[0]); err == nil || toCalls != 0 {
		t.Fatalf("revert = %v, rewind/to called %d times", err, toCalls)
	}
	if len(userIDsIn(t, b, root, sess.ID)) != 1 {
		t.Fatal("the transcript changed although nothing was rewound")
	}
}

func TestRestoreErrorsAreReturnedAndTheHistoryStillRolledBack(t *testing.T) {
	b, fa := newTestBackendCfg(t, false, func(c *Config) { c.Rewind = true })
	fa.hook = func(fa *fakeAgent, id json.RawMessage, method string, p map[string]any) bool {
		if method == "_rewind/to" {
			fa.respond(id, map[string]any{"messageContent": "x", "restoreErrors": []any{"cannot write a.txt"}})
			return true
		}
		return false
	}
	ctx := context.Background()
	sess, _ := b.CreateSession(ctx, "/work", backend.CreateSessionOptions{})
	events, _ := b.Subscribe(ctx)
	runTurn(t, b, fa, events, sess.ID, "one", "e1")
	runTurn(t, b, fa, events, sess.ID, "two", "e2")
	users := userIDs(t, b, sess.ID)
	err := b.Revert(ctx, t.TempDir(), sess.ID, users[1])
	var partial *backend.PartialRevertError
	if !errors.As(err, &partial) || !strings.Contains(partial.Detail, "a.txt") {
		t.Fatalf("revert = %v", err)
	}
	if len(userIDs(t, b, sess.ID)) != 1 {
		t.Fatal("the history was not rolled back")
	}
}

func TestPromptDuringARewindIsQueuedAndSentAfterIt(t *testing.T) {
	b, fa := newTestBackendCfg(t, false, func(c *Config) { c.Rewind = true })
	hold := make(chan struct{})
	fa.hook = func(fa *fakeAgent, id json.RawMessage, method string, p map[string]any) bool {
		if method == "_rewind/to" {
			go func() { <-hold; fa.respond(id, map[string]any{"messageContent": "x"}) }()
			return true
		}
		return false
	}
	ctx := context.Background()
	sess, _ := b.CreateSession(ctx, "/work", backend.CreateSessionOptions{})
	events, _ := b.Subscribe(ctx)
	runTurn(t, b, fa, events, sess.ID, "one", "e1")
	users := userIDs(t, b, sess.ID)
	done := make(chan error, 1)
	go func() { done <- b.Revert(ctx, t.TempDir(), sess.ID, users[0]) }()
	deadline := time.After(5 * time.Second)
	for !b.sessionBusy(sess.ID) {
		select {
		case <-deadline:
			t.Fatal("the rewind never reserved the session")
		case <-time.After(5 * time.Millisecond):
		}
	}
	if err := b.Prompt(ctx, "/work", sess.ID, backend.Prompt{Text: "meanwhile", ClientMessageID: "q1"}); err != nil {
		t.Fatalf("a prompt during a rewind must queue: %v", err)
	}
	if err := b.RunCommand(ctx, "/work", sess.ID, backend.CommandRun{Name: "help"}); !errors.Is(err, backend.ErrSessionBusy) {
		t.Fatalf("a command during a rewind = %v", err)
	}
	if err := b.Revert(ctx, t.TempDir(), sess.ID, users[0]); !errors.Is(err, backend.ErrSessionBusy) {
		t.Fatalf("a second rewind = %v", err)
	}
	noPrompt(t, fa, "a prompt reached the agent during the rewind")
	close(hold)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	// what was typed meanwhile goes out once the rewind is done
	select {
	case <-fa.promptReqs:
	case <-time.After(5 * time.Second):
		t.Fatal("the prompt queued during the rewind was never sent")
	}
}

func TestOnlyTheFirstMatchingEchoIsAbsorbed(t *testing.T) {
	b, fa := newTestBackendCfg(t, false, func(c *Config) { c.Rewind = true })
	ctx := context.Background()
	sess, _ := b.CreateSession(ctx, "/work", backend.CreateSessionOptions{})
	events, _ := b.Subscribe(ctx)
	if err := b.Prompt(ctx, "/work", sess.ID, backend.Prompt{Text: "hello there"}); err != nil {
		t.Fatal(err)
	}
	pr := <-fa.promptReqs
	<-fa.promptParams
	userEcho(fa, sess.ID, "e1", "hello there")    // the echo: absorbed
	userEcho(fa, sess.ID, "e2", "something else") // another user chunk: a real message
	userEcho(fa, sess.ID, "e3", "hello there")    // a second echo: a real message
	fa.respond(pr.id, map[string]any{"stopReason": "end_turn"})
	drainEvents(t, events, sess.ID, 5*time.Second, isIdle)
	if got := userIDs(t, b, sess.ID); len(got) != 3 {
		t.Fatalf("user messages = %v, want the prompt plus the two extra chunks", got)
	}
	st, _ := b.reg.get(sess.ID)
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.entryIDs[st.userMsgID] != "e1" {
		t.Fatalf("entry ids = %v", st.entryIDs)
	}
}

func TestRevertRefusesANonUserMessageAndReopensAnInactiveSession(t *testing.T) {
	b, fa := newTestBackendCfg(t, false, func(c *Config) { c.Rewind = true })
	ctx := context.Background()
	sess, _ := b.CreateSession(ctx, "/work", backend.CreateSessionOptions{})
	events, _ := b.Subscribe(ctx)
	runTurn(t, b, fa, events, sess.ID, "one", "e1")
	tr, _ := b.Transcript(ctx, "/work", sess.ID)
	var asst string
	for _, e := range tr.Messages {
		if e.Message.Role == "assistant" {
			asst = e.Message.ID
		}
	}
	if err := b.Revert(ctx, t.TempDir(), sess.ID, asst); err == nil {
		t.Fatal("an assistant message was a rollback target")
	}
	// the agent restarted: the session is not active, and is reopened before the rewind
	b.reg.deactivateAll()
	before := len(fa.called("session/load")) + len(fa.called("session/resume"))
	_ = b.Revert(ctx, t.TempDir(), sess.ID, userIDs(t, b, sess.ID)[0])
	if after := len(fa.called("session/load")) + len(fa.called("session/resume")); after <= before {
		t.Fatal("an inactive session was rewound without being reopened")
	}
}

func TestForkInheritsThePermissionSelectorAndSubagentsEmitAndAreDeletedWithTheParent(t *testing.T) {
	b, fa := newTestBackendCfg(t, false, func(c *Config) { c.Fork = true; c.Subagents = true })
	fa.hook = func(fa *fakeAgent, id json.RawMessage, method string, p map[string]any) bool {
		if method == "session/fork" {
			fa.respond(id, map[string]any{"sessionId": "forked-1", "configOptions": []any{}})
			return true
		}
		return false
	}
	ctx := context.Background()
	sess, _ := b.CreateSession(ctx, "/work", backend.CreateSessionOptions{})
	events, _ := b.Subscribe(ctx)
	_ = b.SetPermissionMode(ctx, "/work", sess.ID, permrules.Deny) // Plan
	runTurn(t, b, fa, events, sess.ID, "one", "e1")
	child, err := b.Fork(ctx, "/work", sess.ID, "", "Fork")
	if err != nil {
		t.Fatal(err)
	}
	if b.PermissionMode(child.ID) != permrules.Deny {
		t.Fatalf("the fork is on %v, want Plan like its parent", b.PermissionMode(child.ID))
	}

	// a subagent: status changes are announced, and it goes with its parent
	if err := b.Prompt(ctx, "/work", sess.ID, backend.Prompt{Text: "delegate"}); err != nil {
		t.Fatal(err)
	}
	pr := <-fa.promptReqs
	<-fa.promptParams
	fa.update(sess.ID, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "c1", "kind": "think", "status": "in_progress",
		"_meta": map[string]any{"effect_kind": "subagent", "task": "look", "agent": "x", "child_session_id": "kid-1"}})
	fa.respond(pr.id, map[string]any{"stopReason": "end_turn"})
	var sawBusy, sawIdle bool
	deadline := time.After(5 * time.Second)
	for !(sawBusy && sawIdle) {
		select {
		case e := <-events:
			if e.SessionID == "kid-1" && e.Event.Kind == backend.EventSession && e.Event.Session != nil {
				sawBusy = sawBusy || e.Event.Session.Status == backend.StatusBusy
				sawIdle = sawIdle || e.Event.Session.Status == backend.StatusIdle
			}
		case <-deadline:
			t.Fatalf("child session events: busy %v idle %v", sawBusy, sawIdle)
		}
	}
	if err := b.Prompt(ctx, "/work", "kid-1", backend.Prompt{Text: "hi"}); err == nil {
		t.Fatal("a subagent's session was prompted")
	}
	if err := b.DeleteSession(ctx, "/work", sess.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := b.reg.get("kid-1"); ok {
		t.Fatal("the subagent outlived its parent")
	}
}

func TestAnAttachmentsOnlyPromptsEchoIsStillTheTurnsEntryID(t *testing.T) {
	b, fa := newTestBackendCfg(t, false, func(c *Config) { c.Rewind = true })
	ctx := context.Background()
	sess, _ := b.CreateSession(ctx, "/work", backend.CreateSessionOptions{})
	events, _ := b.Subscribe(ctx)
	if err := b.Prompt(ctx, "/work", sess.ID, backend.Prompt{Text: ""}); err != nil {
		t.Fatal(err)
	}
	pr := <-fa.promptReqs
	<-fa.promptParams
	fa.update(sess.ID, map[string]any{"sessionUpdate": "user_message_chunk", "messageId": "img1", "content": map[string]any{"type": "image", "data": "x", "mimeType": "image/png"}})
	fa.respond(pr.id, map[string]any{"stopReason": "end_turn"})
	drainEvents(t, events, sess.ID, 5*time.Second, isIdle)
	st, _ := b.reg.get(sess.ID)
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.entryIDs[st.userMsgID] != "img1" {
		t.Fatalf("entry ids = %v", st.entryIDs)
	}
}

func TestEchoMatchesAnEmptyPromptOnItsFirstEcho(t *testing.T) {
	if !echoMatches("whatever the agent echoes", "") || echoMatches("a", "b") || !echoMatches("  b  ", "b") {
		t.Fatal("echoMatches")
	}
}

// A fork whose reload fails keeps galopin's copy of the history it shares.
func TestForkReloadFailureKeepsTheCopiedHistory(t *testing.T) {
	b, fa := newTestBackendCfg(t, false, func(c *Config) { c.Fork = true })
	fa.hook = func(fa *fakeAgent, id json.RawMessage, method string, p map[string]any) bool {
		switch method {
		case "session/fork":
			fa.respond(id, map[string]any{"sessionId": "forked-1", "configOptions": []any{}})
			return true
		case "session/load":
			if p["sessionId"] == "forked-1" {
				_ = fa.conn.respond(id, nil, &rpcError{Code: -32603, Message: "boom"})
				return true
			}
		}
		return false
	}
	ctx := context.Background()
	sess, _ := b.CreateSession(ctx, "/work", backend.CreateSessionOptions{})
	events, _ := b.Subscribe(ctx)
	runTurn(t, b, fa, events, sess.ID, "one", "e1")
	child, err := b.Fork(ctx, "/work", sess.ID, "", "Fork")
	if err != nil {
		t.Fatal(err)
	}
	if got := userIDs(t, b, child.ID); len(got) != 1 {
		t.Fatalf("the fork lost its history when the reload failed: %v", got)
	}
}
