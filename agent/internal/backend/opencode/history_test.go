package opencode

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// historyFake answers the endpoints History touches, recording the paged
// message request's query so a test can assert the cursor galopin built.
// messages is the body GET .../message answers with (ascending entries);
// revertID, when set, is the session's revert.messageID.
func historyFake(t *testing.T, messages string, revertID, goneID string) (*Backend, *string) {
	t.Helper()
	var lastQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/message") && r.URL.RawQuery != "":
			lastQuery = r.URL.RawQuery
			_, _ = io.WriteString(w, messages)
		case strings.HasPrefix(r.URL.Path, "/session/ses_1/message/"):
			id := strings.TrimPrefix(r.URL.Path, "/session/ses_1/message/")
			if id == goneID {
				http.NotFound(w, r)
				return
			}
			_, _ = io.WriteString(w, `{"info":{"id":"`+id+`","role":"user","time":{"created":3000}},"parts":[]}`)
		case strings.HasSuffix(r.URL.Path, "/message"):
			_, _ = io.WriteString(w, messages)
		case r.URL.Path == "/session/ses_1":
			if revertID != "" {
				_, _ = io.WriteString(w, `{"id":"ses_1","revert":{"messageID":"`+revertID+`"}}`)
			} else {
				_, _ = io.WriteString(w, `{"id":"ses_1"}`)
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

const twoEntries = `[{"info":{"id":"msg_1","role":"user","time":{"created":1000}},"parts":[{"id":"p1","messageID":"msg_1","type":"text","text":"hi"}]},{"info":{"id":"msg_2","role":"assistant","time":{"created":2000}},"parts":[]}]`

func TestHistoryPagesBelowTheCursor(t *testing.T) {
	b, lastQuery := historyFake(t, twoEntries, "", "")
	page, err := b.History(context.Background(), "/ws", "ses_1", "msg_3", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Entries) != 2 || page.Entries[0].Message.ID != "msg_1" || page.Entries[1].Message.ID != "msg_2" {
		t.Fatalf("page = %+v, want msg_1,msg_2 ascending", page.Entries)
	}
	if !page.HasMore || page.Before != "msg_1" {
		t.Fatalf("hasMore/before = %v/%q, want true/msg_1 (a full page has more behind it)", page.HasMore, page.Before)
	}
	// The cursor opencode expects: base64url of {"id","time"} — the id the
	// caller named and that message's own created time, read from the
	// message first (a bare message id is a 400).
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(*lastQuery, "limit=2&before="))
	if err != nil {
		t.Fatalf("cursor is not base64url: %v (query %s)", err, *lastQuery)
	}
	var cursor struct {
		ID   string `json:"id"`
		Time int64  `json:"time"`
	}
	if err := json.Unmarshal(raw, &cursor); err != nil {
		t.Fatalf("cursor payload: %v (%s)", err, raw)
	}
	if cursor.ID != "msg_3" || cursor.Time != 3000 {
		t.Fatalf("cursor = %+v, want msg_3 at 3000", cursor)
	}
	if page.Entries[0].Parts[0].Text != "hi" {
		t.Fatalf("first entry's parts = %+v, want the mapped text part", page.Entries[0].Parts)
	}
}

func TestHistoryLastPageHasNoMore(t *testing.T) {
	b, _ := historyFake(t, twoEntries, "", "")
	page, err := b.History(context.Background(), "/ws", "ses_1", "msg_3", 5)
	if err != nil {
		t.Fatal(err)
	}
	// A page shorter than the limit is the end (opencode fetches limit+1
	// rows), whatever its own header said — this fake answers two entries
	// for a five-message page.
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
	// 404s: the walk ends with an empty page instead of failing.
	b, lastQuery := historyFake(t, twoEntries, "", "msg_9")
	page, err := b.History(context.Background(), "/ws", "ses_1", "msg_9", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Entries) != 0 || page.HasMore {
		t.Fatalf("page = %+v, want empty with no more", page)
	}
	if *lastQuery != "" {
		t.Fatalf("the message list was fetched anyway (query %s)", *lastQuery)
	}
}

func TestHistoryCutsAtTheRevertPoint(t *testing.T) {
	// The page's own tail sits at the revert point: like Transcript, History
	// hides it — a page can never resurrect a rolled-back turn.
	three := twoEntries[:len(twoEntries)-1] + `,{"info":{"id":"msg_3","role":"user","time":{"created":3000}},"parts":[]}]`
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

func TestHistoryRefusesAnOversizedAnswer(t *testing.T) {
	// An opencode too old to page ignores the parameters and answers the
	// whole list; that must fail, never map into a page that reads like one.
	three := twoEntries + `,{"info":{"id":"msg_3","role":"user","time":{"created":3000}},"parts":[]}`
	b, _ := historyFake(t, three, "", "")
	if _, err := b.History(context.Background(), "/ws", "ses_1", "msg_4", 2); err == nil {
		t.Fatal("an answer larger than the requested page must be refused")
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

func TestOpencodeCursorMatchesThePinnedServerShape(t *testing.T) {
	// Buffer.from(JSON.stringify({id, time})).toString("base64url"): no
	// padding, and the time a JSON number — what the pinned server's
	// MessageV2.cursor decodes.
	encoded, err := opencodeCursor("msg_3", time.UnixMilli(1712345678901))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("cursor is not unpadded base64url: %v", err)
	}
	if string(raw) != `{"id":"msg_3","time":1712345678901}` {
		t.Fatalf("cursor payload = %s", raw)
	}
}
