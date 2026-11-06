package acp

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/filediff"
)

// A session reloaded after a galopin restart has the agent's replayed history
// as its transcript, for an agent (goose) that advertises loadSession without
// sessionCapabilities.resume and sends no message ids.
func TestTranscriptCapturesSessionLoadReplay(t *testing.T) {
	b, fa := newTestBackend(t)
	fa.noResume = true
	chunk := func(kind, text string) map[string]any {
		return map[string]any{"sessionUpdate": kind, "content": map[string]any{"type": "text", "text": text}}
	}
	fa.replay = []map[string]any{
		chunk("user_message_chunk", "fix "),
		chunk("user_message_chunk", "the bug"),
		chunk("agent_message_chunk", "Looking"),
		chunk("agent_message_chunk", " now."),
		{"sessionUpdate": "tool_call", "toolCallId": "c1", "title": "write", "kind": "edit", "status": "completed"},
		chunk("agent_message_chunk", "Done."),
		chunk("user_message_chunk", "thanks"),
	}
	tr, err := b.Transcript(context.Background(), "/work", "old-session")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range tr.Messages {
		var texts []string
		for _, p := range e.Parts {
			if p.Type == backend.PartTool {
				texts = append(texts, "tool:"+p.CallID)
			} else {
				texts = append(texts, p.Text)
			}
		}
		got = append(got, e.Message.Role+"="+strings.Join(texts, "|"))
	}
	want := []string{"user=fix the bug", "assistant=Looking now.", "assistant=tool:c1", "assistant=Done.", "user=thanks"}
	if strings.Join(got, ";") != strings.Join(want, ";") {
		t.Fatalf("transcript = %q, want %q", got, want)
	}
	// A second sync is served from memory: no second replay.
	tr2, err := b.Transcript(context.Background(), "/work", "old-session")
	if err != nil || len(tr2.Messages) != len(want) {
		t.Fatalf("second Transcript = %d messages, err %v; want %d", len(tr2.Messages), err, len(want))
	}
	if n := len(fa.newParams); n != 1 {
		t.Errorf("session/load called %d times, want 1", n)
	}
}

// A session the agent merely listed (never loaded) still replays on first sync.
func TestTranscriptLoadsAListedSession(t *testing.T) {
	b, fa := newTestBackend(t)
	fa.replay = []map[string]any{{"sessionUpdate": "agent_message_chunk", "messageId": "m1", "content": map[string]any{"type": "text", "text": "hi"}}}
	b.reg.getOrCreate("listed", "/work")
	tr, err := b.Transcript(context.Background(), "/work", "listed")
	if err != nil || len(tr.Messages) != 1 {
		t.Fatalf("Transcript = %+v, err %v; want 1 message", tr, err)
	}
}

func waitDiffs(t *testing.T, b *Backend, sid string, n int) []backend.FileDiff {
	t.Helper()
	var d []backend.FileDiff
	for i := 0; i < 100; i++ {
		d, _ = b.Diff(context.Background(), "", sid)
		if len(d) >= n {
			return d
		}
		time.Sleep(20 * time.Millisecond)
	}
	return d
}

// An edit the agent runs after an ask is diffed from galopin's own snapshots:
// the file is read when the ask arrives (before the tool runs) and again when
// the call completes.
func TestEditToolCallProducesDiff(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	b, fa := newTestBackend(t)
	b.diffs = filediff.New(func(_, p string) bool { return filepath.Base(p) == ".env" })
	ctx := context.Background()
	sess, err := b.CreateSession(ctx, dir, backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	events, _ := b.Subscribe(ctx)
	if err := b.Prompt(ctx, dir, sess.ID, backend.Prompt{Text: "edit"}); err != nil {
		t.Fatal(err)
	}
	pr := <-fa.promptReqs
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("K=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fa.update(pr.sessionID, map[string]any{
		"sessionUpdate": "tool_call", "toolCallId": "e1", "title": "edit", "kind": "edit", "status": "pending",
		"locations": []any{map[string]any{"path": "a.txt"}},
	})
	fa.update(pr.sessionID, map[string]any{
		"sessionUpdate": "tool_call", "toolCallId": "e2", "title": "write", "kind": "edit", "status": "pending",
		"rawInput": map[string]any{"path": filepath.Join(dir, "new.txt")},
	})
	fa.update(pr.sessionID, map[string]any{
		"sessionUpdate": "tool_call", "toolCallId": "e3", "title": "edit", "kind": "edit", "status": "pending",
		"locations": []any{map[string]any{"path": ".env"}},
	})
	// the tool calls run
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\nTWO\nthree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "new.txt"), []byte("fresh\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("K=2-longer\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"e1", "e2", "e3"} {
		fa.update(pr.sessionID, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": id, "status": "completed"})
	}
	fa.respond(pr.id, map[string]any{"stopReason": "end_turn"})
	drainEvents(t, events, sess.ID, 5*time.Second, isIdle)

	d := waitDiffs(t, b, sess.ID, 3)
	by := map[string]backend.FileDiff{}
	for _, f := range d {
		by[f.Path] = f
	}
	if len(d) != 3 {
		t.Fatalf("diffs = %+v, want 3", d)
	}
	if f := by["a.txt"]; f.Status != backend.FileModified || f.Before != "one\ntwo\n" || f.After != "one\nTWO\nthree\n" || f.Additions != 2 || f.Deletions != 1 {
		t.Errorf("a.txt = %+v", f)
	}
	if f := by["new.txt"]; f.Status != backend.FileAdded || f.After != "fresh\n" || f.Before != "" {
		t.Errorf("new.txt = %+v", f)
	}
	if f := by[".env"]; f.After != filediff.MarkerProtected || strings.Contains(f.Before+f.After, "K=") {
		t.Errorf(".env = %+v, want no content", f)
	}
}

func TestDiffNeedsNoEngineSupport(t *testing.T) {
	b, _ := newTestBackend(t)
	d, err := b.Diff(context.Background(), "/work", "nope")
	if err != nil || d == nil || len(d) != 0 {
		t.Fatalf("Diff of an unknown session = %v, %v; want an empty list", d, err)
	}
}
