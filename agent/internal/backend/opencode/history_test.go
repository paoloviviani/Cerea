package opencode

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

// historyFake answers the endpoints History touches, recording the paged
// message request's query so a test can assert the cursor galopin built.
// messages is the page GET .../message answers with (2.x entries, newest
// first, as order=desc gives); revertID, when set, is the session's
// revert.messageID; goneID is a message the cursor names that no longer
// exists (the list answers 404 for it).
func historyFake(t *testing.T, messages string, revertID, goneID string) (*Backend, *string) {
	t.Helper()
	var lastQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/message"):
			lastQuery = r.URL.RawQuery
			if goneID != "" {
				if raw, err := base64.RawURLEncoding.DecodeString(r.URL.Query().Get("cursor")); err == nil && strings.Contains(string(raw), goneID) {
					http.NotFound(w, r)
					return
				}
			}
			_, _ = io.WriteString(w, `{"data":`+messages+`,"cursor":{}}`)
		case r.URL.Path == "/api/session/ses_1":
			if revertID != "" {
				_, _ = io.WriteString(w, `{"data":{"id":"ses_1","revert":{"messageID":"`+revertID+`"}}}`)
			} else {
				_, _ = io.WriteString(w, `{"data":{"id":"ses_1"}}`)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ := strconv.Atoi(portStr)
	return New(Config{Hostname: host, Port: port, Password: "x"}), &lastQuery
}

// twoEntries is two messages, newest first (2.x shapes).
const twoEntries = `[{"id":"msg_2","type":"assistant","agent":"build","model":{"id":"m","providerID":"p"},"content":[],"time":{"created":2000}},{"id":"msg_1","type":"user","text":"hi","time":{"created":1000}}]`

func TestHistoryPagesBelowTheCursor(t *testing.T) {
	b, lastQuery := historyFake(t, twoEntries, "", "")
	page, err := b.History(context.Background(), "/ws", "ses_1", "msg_3", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Entries) != 1 || page.Entries[0].Message.ID != "msg_2" {
		t.Fatalf("page = %+v, want the newest message below the cursor, msg_2", page.Entries)
	}
	if !page.HasMore || page.Before != "msg_2" {
		t.Fatalf("hasMore/before = %v/%q, want true/msg_2 (an older message remains)", page.HasMore, page.Before)
	}
	q, _ := url.ParseQuery(*lastQuery)
	raw, err := base64.RawURLEncoding.DecodeString(q.Get("cursor"))
	if err != nil {
		t.Fatalf("cursor is not base64url: %v (query %s)", err, *lastQuery)
	}
	var cursor struct {
		ID, Order, Direction string
	}
	if err := json.Unmarshal(raw, &cursor); err != nil {
		t.Fatalf("cursor payload: %v (%s)", err, raw)
	}
	if cursor.ID != "msg_3" || cursor.Order != "desc" || cursor.Direction != "next" {
		t.Fatalf("cursor = %+v, want msg_3 desc/next", cursor)
	}
	if q.Has("order") {
		t.Errorf("query = %s: the cursor carries the order and the server refuses both", *lastQuery)
	}
}

func TestHistoryAscendsAndMapsParts(t *testing.T) {
	b, _ := historyFake(t, twoEntries, "", "")
	page, err := b.History(context.Background(), "/ws", "ses_1", "msg_3", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Entries) != 2 || page.Entries[0].Message.ID != "msg_1" || page.Entries[1].Message.ID != "msg_2" {
		t.Fatalf("page = %+v, want msg_1,msg_2 ascending", page.Entries)
	}
	if page.Entries[0].Parts[0].Text != "hi" {
		t.Fatalf("first entry's parts = %+v, want the mapped text part", page.Entries[0].Parts)
	}
	if page.HasMore {
		t.Fatalf("hasMore = true for a 2-of-5 page, want false")
	}
	if page.Before != "msg_1" {
		t.Fatalf("before = %q, want msg_1 (the page's oldest, still named)", page.Before)
	}
}

func TestHistoryEmptyPage(t *testing.T) {
	b, _ := historyFake(t, `[]`, "", "")
	page, err := b.History(context.Background(), "/ws", "ses_1", "msg_1", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Entries) != 0 || page.HasMore || page.Before != "" {
		t.Fatalf("page = %+v, want empty with no more and no cursor", page)
	}
}

func TestHistoryCursorMessageGone(t *testing.T) {
	// A message the storage no longer holds (a revert's cleanup deleted it)
	// is a 404 on the cursor: the walk ends with an empty page, not a failure.
	b, _ := historyFake(t, twoEntries, "", "msg_9")
	page, err := b.History(context.Background(), "/ws", "ses_1", "msg_9", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Entries) != 0 || page.HasMore {
		t.Fatalf("page = %+v, want empty with no more", page)
	}
}

func TestHistoryCutsAtTheRevertPoint(t *testing.T) {
	// The page's own tail sits at the revert point: like Transcript, History
	// hides it — a page can never resurrect a rolled-back turn.
	three := `[{"id":"msg_3","type":"user","text":"x","time":{"created":3000}},` + twoEntries[1:]
	b, _ := historyFake(t, three, "msg_3", "")
	page, err := b.History(context.Background(), "/ws", "ses_1", "msg_4", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Entries) != 2 || page.Entries[1].Message.ID != "msg_2" {
		t.Fatalf("page = %+v, want msg_1,msg_2 with msg_3 cut", page.Entries)
	}
	if page.HasMore {
		t.Fatalf("hasMore = true for a page the revert cut short, want false")
	}
}

// A server that answers more than the page asked for is cut to the limit, with
// the older remainder reported.
func TestHistoryCutsAnOversizedAnswerToTheLimit(t *testing.T) {
	three := `[{"id":"msg_3","type":"user","text":"c","time":{"created":3000}},` + twoEntries[1:]
	b, _ := historyFake(t, three, "", "")
	page, err := b.History(context.Background(), "/ws", "ses_1", "msg_4", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Entries) != 2 || page.Entries[0].Message.ID != "msg_2" || page.Entries[1].Message.ID != "msg_3" || !page.HasMore {
		t.Fatalf("page = %+v hasMore=%v, want msg_2,msg_3 and more behind", page.Entries, page.HasMore)
	}
}

func TestHistoryValidatesItsArgs(t *testing.T) {
	b, _ := historyFake(t, twoEntries, "", "")
	if _, err := b.History(context.Background(), "/ws", "ses_1", "", 5); err == nil {
		t.Fatal("an empty before must be refused")
	}
	if _, err := b.History(context.Background(), "/ws", "ses_1", "msg_1", 0); err == nil {
		t.Fatal("a zero limit must be refused")
	}
}

func TestMessageCursorMatchesTheServerShape(t *testing.T) {
	// base64url without padding of {"id","order","direction"}: what the 2.x
	// message list hands back as cursor.next.
	encoded, err := messageCursor("msg_3")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("cursor is not unpadded base64url: %v", err)
	}
	if string(raw) != `{"id":"msg_3","order":"desc","direction":"next"}` {
		t.Fatalf("cursor payload = %s", raw)
	}
}
