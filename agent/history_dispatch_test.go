package main

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"galopin/internal/backend"
)

// seededBackend is fakeBackend's floor with a Transcript that seeds the
// materializer: enough for the session.sync snapshot tests, and — with
// fakeBackend's own Capabilities — a backend that cannot page history.
type seededBackend struct {
	*fakeBackend
	entries []backend.TranscriptEntry
}

func (f *seededBackend) Transcript(context.Context, string, string) (backend.Transcript, error) {
	return backend.Transcript{Messages: f.entries}, nil
}

// seededHistoryBackend is seededBackend with backend.HistoryPager added: the
// shape a backend that can page history has.
type seededHistoryBackend struct {
	seededBackend
	page backend.HistoryPage
	err  error
}

func (f *seededHistoryBackend) Capabilities() backend.Capabilities {
	return backend.Capabilities{HistoryPaging: true}
}

func (f *seededHistoryBackend) History(_ context.Context, _, _, _ string, _ int) (backend.HistoryPage, error) {
	return f.page, f.err
}

var _ backend.HistoryPager = (*seededHistoryBackend)(nil)

func seedEntries(n int) []backend.TranscriptEntry {
	entries := make([]backend.TranscriptEntry, 0, n)
	for i := 1; i <= n; i++ {
		entries = append(entries, backend.TranscriptEntry{
			Message: backend.Message{ID: strconv.Itoa(i), Role: "user"},
		})
	}
	return entries
}

func syncResult(t *testing.T, mc *machine, args string) map[string]any {
	t.Helper()
	res, operr := mc.Handle(context.Background(), "session.sync", json.RawMessage(args))
	if operr != nil {
		t.Fatalf("session.sync: %+v", operr)
	}
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// Without a limit the snapshot is the whole transcript, exactly as an older
// Cerea has always received it — no hasMore, no before.
func TestSessionSyncWithoutLimitKeepsTheWholeSnapshot(t *testing.T) {
	mc := newTestMachine(t, &seededHistoryBackend{seededBackend: seededBackend{entries: seedEntries(4)}})
	trackTestSession(t, mc, "s1")
	out := syncResult(t, mc, `{"sessionId":"s1"}`)
	snap := out["snapshot"].(map[string]any)
	if len(snap["messages"].([]any)) != 4 {
		t.Fatalf("snapshot holds %d messages, want all 4", len(snap["messages"].([]any)))
	}
	if _, ok := snap["hasMore"]; ok {
		t.Fatalf("unlimited snapshot carries hasMore: %s", out)
	}
}

// With a limit the snapshot holds only the newest page, plus hasMore and
// before — the cursor the next session.history names. The rest of the
// snapshot (status, permissions, questions, todos, usage) stays exactly as
// it was.
func TestSessionSyncWithLimitTrimsToTheNewestPage(t *testing.T) {
	mc := newTestMachine(t, &seededHistoryBackend{seededBackend: seededBackend{entries: seedEntries(10)}})
	trackTestSession(t, mc, "s1")
	out := syncResult(t, mc, `{"sessionId":"s1","limit":3}`)
	snap := out["snapshot"].(map[string]any)
	messages := snap["messages"].([]any)
	if len(messages) != 3 {
		t.Fatalf("snapshot holds %d messages, want the newest 3", len(messages))
	}
	if first := messages[0].(map[string]any)["message"].(map[string]any)["id"]; first != "8" {
		t.Fatalf("oldest kept message = %v, want 8 (10 - 3 + 1)", first)
	}
	if snap["hasMore"] != true {
		t.Fatalf("hasMore = %v, want true", snap["hasMore"])
	}
	if snap["before"] != "8" {
		t.Fatalf("before = %v, want 8 (the page's oldest)", snap["before"])
	}
	if _, ok := snap["status"]; !ok {
		t.Fatalf("the trimmed snapshot lost its status: %s", snap)
	}
}

// A page that fits carries hasMore false and no before — the top of the
// session is in it.
func TestSessionSyncWithLimitAndNoOlderMessages(t *testing.T) {
	mc := newTestMachine(t, &seededHistoryBackend{seededBackend: seededBackend{entries: seedEntries(2)}})
	trackTestSession(t, mc, "s1")
	out := syncResult(t, mc, `{"sessionId":"s1","limit":10}`)
	snap := out["snapshot"].(map[string]any)
	if len(snap["messages"].([]any)) != 2 {
		t.Fatalf("snapshot holds %d messages, want both", len(snap["messages"].([]any)))
	}
	if snap["hasMore"] != false {
		t.Fatalf("hasMore = %v, want false", snap["hasMore"])
	}
	if _, ok := snap["before"]; ok {
		t.Fatalf("a full-history page names no before: %s", snap)
	}
}

// A limit is refused a trim on a backend that cannot also serve the older
// pages: hasMore must never promise a page session.history cannot give.
func TestSessionSyncLimitIgnoredWithoutHistoryPaging(t *testing.T) {
	mc := newTestMachine(t, &seededBackend{entries: seedEntries(2)})
	trackTestSession(t, mc, "s1")
	out := syncResult(t, mc, `{"sessionId":"s1","limit":1}`)
	snap := out["snapshot"].(map[string]any)
	if len(snap["messages"].([]any)) != 2 {
		t.Fatalf("a backend without historyPaging must keep the whole snapshot, got %s", snap)
	}
	if _, ok := snap["hasMore"]; ok {
		t.Fatalf("no hasMore without the capability: %s", snap)
	}
}

func TestSessionHistoryValidatesItsArgs(t *testing.T) {
	mc := newTestMachine(t, &seededHistoryBackend{})
	trackTestSession(t, mc, "s1")
	for name, args := range map[string]string{
		"no before":  `{"sessionId":"s1","limit":5}`,
		"no limit":   `{"sessionId":"s1","before":"msg_1"}`,
		"zero limit": `{"sessionId":"s1","before":"msg_1","limit":0}`,
	} {
		_, operr := mc.Handle(context.Background(), "session.history", json.RawMessage(args))
		if operr == nil || operr.Code != "invalid" {
			t.Fatalf("%s: operr = %+v, want invalid", name, operr)
		}
	}
}

func TestSessionHistoryUnsupportedWithoutThePager(t *testing.T) {
	mc := newTestMachine(t, &fakeBackend{})
	trackTestSession(t, mc, "s1")
	_, operr := mc.Handle(context.Background(), "session.history", json.RawMessage(`{"sessionId":"s1","before":"msg_1","limit":5}`))
	if operr == nil || operr.Code != "unsupported" {
		t.Fatalf("operr = %+v, want unsupported", operr)
	}
}

func TestSessionHistoryServesThePage(t *testing.T) {
	back := &seededHistoryBackend{page: backend.HistoryPage{
		Entries: []backend.TranscriptEntry{{Message: backend.Message{ID: "msg_1", Role: "user"}}},
		HasMore: true,
		Before:  "msg_1",
	}}
	mc := newTestMachine(t, back)
	trackTestSession(t, mc, "s1")
	res, operr := mc.Handle(context.Background(), "session.history", json.RawMessage(`{"sessionId":"s1","before":"msg_2","limit":5}`))
	if operr != nil {
		t.Fatalf("session.history: %+v", operr)
	}
	out := res.(map[string]any)
	if len(out["messages"].([]backend.TranscriptEntry)) != 1 {
		t.Fatalf("messages = %v", out["messages"])
	}
	if out["hasMore"] != true || out["before"] != "msg_1" {
		t.Fatalf("hasMore/before = %v/%v", out["hasMore"], out["before"])
	}
	// The wire carries nothing but the page: no permissions, questions,
	// status or usage — live state no older page holds.
	raw, _ := json.Marshal(out)
	for _, forbidden := range []string{"permissions", "questions", "status", "usage"} {
		if strings.Contains(string(raw), `"`+forbidden+`"`) {
			t.Fatalf("session.history result carries %s: %s", forbidden, raw)
		}
	}
}
