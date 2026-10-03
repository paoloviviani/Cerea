package opencode

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// revertRace fakes opencode's revert bookkeeping: the session carries
// revert.messageID until the next prompt's cleanup, which deletes the
// reverted messages and only THEN clears the marker. The cleanup lands right
// after the first read of either, i.e. between a caller's two reads, whichever
// order it makes them in.
func revertRace(t *testing.T) *Backend {
	t.Helper()
	var mu sync.Mutex
	cleaned := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		defer func() { cleaned = true }()
		switch {
		case strings.HasSuffix(r.URL.Path, "/message"):
			body := `[{"info":{"id":"msg_1","role":"user"},"parts":[]},{"info":{"id":"msg_2","role":"assistant"},"parts":[]}`
			if !cleaned {
				body += `,{"info":{"id":"msg_3","role":"user"},"parts":[]},{"info":{"id":"msg_4","role":"assistant"},"parts":[]}`
			}
			_, _ = io.WriteString(w, body+"]")
		case r.URL.Path == "/session/ses_1":
			if cleaned {
				_, _ = io.WriteString(w, `{"id":"ses_1"}`)
			} else {
				_, _ = io.WriteString(w, `{"id":"ses_1","revert":{"messageID":"msg_3"}}`)
			}
		default:
			_, _ = io.WriteString(w, `[]`)
		}
	}))
	t.Cleanup(srv.Close)
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ := strconv.Atoi(portStr)
	return New(Config{Hostname: host, Port: port, Password: "x"})
}

// A prompt sent right after a revert cleans the reverted turn up while a
// transcript read is in flight. Reading the marker after the messages
// returned the reverted turn with nothing to hide it (found live: the retry
// showed the old answer beside the new one until a later resync).
func TestTranscriptNeverResurrectsARevertedTurnAcrossACleanup(t *testing.T) {
	b := revertRace(t)
	tr, err := b.Transcript(context.Background(), "/ws", "ses_1")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, e := range tr.Messages {
		ids = append(ids, e.Message.ID)
	}
	if got := strings.Join(ids, ","); got != "msg_1,msg_2" {
		t.Fatalf("transcript = %s, want msg_1,msg_2 (the reverted turn must stay hidden)", got)
	}
}
