package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"galopin/internal/backend"
)

// bigReplay is the history of a long Claude Code style session: turns of a
// user message, agent text, and tool calls, some with a title and kind, some
// announced with neither, some seen only as a bare tool_call_update.
func bigReplay(turns int) []map[string]any {
	text := func(kind, id, s string) map[string]any {
		return map[string]any{"sessionUpdate": kind, "messageId": id, "content": map[string]any{"type": "text", "text": s}}
	}
	var out []map[string]any
	for i := 0; i < turns; i++ {
		out = append(out, text("user_message_chunk", fmt.Sprintf("u%d", i), fmt.Sprintf("question %d", i)))
		out = append(out, text("agent_message_chunk", fmt.Sprintf("a%d", i), fmt.Sprintf("thinking about %d", i)))
		out = append(out,
			map[string]any{"sessionUpdate": "tool_call", "toolCallId": fmt.Sprintf("t%d-1", i), "title": "Read file", "kind": "read", "status": "pending"},
			map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": fmt.Sprintf("t%d-1", i), "status": "completed", "content": []any{map[string]any{"type": "content", "content": map[string]any{"type": "text", "text": "package x"}}}},
			map[string]any{"sessionUpdate": "tool_call", "toolCallId": fmt.Sprintf("t%d-2", i), "status": "pending"},                                    // no title, no kind
			map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": fmt.Sprintf("t%d-3", i), "status": "completed"},                           // never announced
			map[string]any{"sessionUpdate": "tool_call", "toolCallId": fmt.Sprintf("t%d-4", i), "title": "Edit", "kind": "edit", "status": "completed"}, // edit: must not snapshot files
		)
		out = append(out, text("agent_message_chunk", fmt.Sprintf("a%d", i), fmt.Sprintf(" done %d", i)))
	}
	return out
}

func TestLargeReplayIsFastQuietAndPaged(t *testing.T) {
	const turns = 1000 // 7000 updates
	b, fa := newBackend(t, func(fa *fakeAgent) { fa.replay = bigReplay(turns) })
	ctx := context.Background()
	ch, _ := b.Subscribe(ctx)
	var events atomic.Int64
	go func() {
		for range ch {
			events.Add(1)
		}
	}()

	start := time.Now()
	tr, err := b.Transcript(ctx, "/w", "big")
	took := time.Since(start)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("replay of %d updates: Transcript took %s, %d messages", len(fa.replay), took, len(tr.Messages))
	if took > 5*time.Second {
		t.Errorf("Transcript took %s", took)
	}
	if n := events.Load(); n != 0 {
		t.Errorf("%d events went out during a replay", n)
	}
	for _, m := range tr.Messages {
		for _, p := range m.Parts {
			if p.Type == backend.PartTool && p.Tool == "" {
				t.Fatalf("nameless tool part %+v", p)
			}
		}
	}
	if len(fa.called("session/load")) != 1 {
		t.Fatalf("session/load calls = %d", len(fa.called("session/load")))
	}

	// Page back from the newest 50 messages to the start.
	before := tr.Messages[len(tr.Messages)-50].Message.ID
	seen, pages := 50, 0
	for before != "" {
		page, err := b.History(ctx, "/w", "big", before, 200)
		if err != nil {
			t.Fatal(err)
		}
		pages++
		seen += len(page.Entries)
		if !page.HasMore {
			break
		}
		before = page.Before
	}
	if seen != len(tr.Messages) {
		t.Errorf("paging saw %d messages of %d (%d pages)", seen, len(tr.Messages), pages)
	}
	// the size of the whole snapshot against one page
	whole, _ := json.Marshal(tr)
	page, _ := b.History(ctx, "/w", "big", tr.Messages[len(tr.Messages)-1].Message.ID, 50)
	one, _ := json.Marshal(page.Entries)
	t.Logf("whole snapshot %d KiB, one 50-message page %d KiB", len(whole)/1024, len(one)/1024)
}

func TestReplayedTranscriptsAreBounded(t *testing.T) {
	b, _ := newBackend(t, func(fa *fakeAgent) { fa.replay = bigReplay(2) })
	ctx := context.Background()
	for i := 0; i < maxReplayedSessions+3; i++ {
		if _, err := b.Transcript(ctx, "/w", fmt.Sprintf("s%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	held := 0
	for _, st := range b.reg.all() {
		if len(st.messages) > 0 {
			held++
		}
	}
	if held > maxReplayedSessions {
		t.Errorf("%d replayed transcripts held, bound %d", held, maxReplayedSessions)
	}
	// an evicted one replays again on the next look
	tr, err := b.Transcript(ctx, "/w", "s0")
	if err != nil || len(tr.Messages) == 0 {
		t.Errorf("re-open of an evicted session: %v, %d messages", err, len(tr.Messages))
	}
}
