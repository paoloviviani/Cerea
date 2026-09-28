package opencode

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
)

func TestReadBoundedLine(t *testing.T) {
	r := bufio.NewReaderSize(strings.NewReader("short\n"+strings.Repeat("x", 500)+"\nafter\r\nlast"), 16)
	line, big, err := readBoundedLine(r, 100)
	if line != "short" || big != nil || err != nil {
		t.Fatalf("1: %q %v %v", line, big, err)
	}
	line, big, err = readBoundedLine(r, 100)
	if line != "" || big == nil || big.size != 501 || !strings.HasPrefix(big.head, "xxxx") || err != nil {
		t.Fatalf("2: %q %+v %v", line, big, err)
	}
	line, big, err = readBoundedLine(r, 100)
	if line != "after" || big != nil || err != nil {
		t.Fatalf("3: %q %v %v", line, big, err)
	}
	line, _, err = readBoundedLine(r, 100)
	if line != "last" || err == nil {
		t.Fatalf("4: %q %v", line, err)
	}
}

// One event line past the limit must not end the stream: it is skipped, its
// session asked to resync, and the events around it still arrive.
func TestOversizedSSELineSkipsAndResyncsWithoutDroppingTheStream(t *testing.T) {
	huge := fmt.Sprintf(`{"directory":"/work dir","payload":{"type":"message.part.updated","properties":{"part":{"id":"prt1","sessionID":"ses_big","messageID":"m","type":"tool","state":{"attachments":[{"url":"data:image/png;base64,%s"}]}}}}}`, strings.Repeat("A", 5000))
	small := func(text string) string {
		return fmt.Sprintf(`{"directory":"/w","payload":{"type":"message.part.delta","properties":{"sessionID":"ses_a","messageID":"m","partID":"p","field":"text","delta":%q}}}`, text)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, l := range []string{small("before"), huge, small("after")} {
			fmt.Fprintf(w, "data: %s\n\n", l)
		}
	}))
	defer srv.Close()
	b := fakeServerBackend(t, srv)
	b.cfg.SSEMaxLineBytes = 1000
	out := make(chan backend.BackendEvent, 16)
	if err := b.streamOnce(context.Background(), out); err != nil {
		t.Fatalf("the stream ended with an error: %v", err)
	}
	close(out)
	var kinds []string
	for ev := range out {
		k := string(ev.Event.Kind)
		if ev.Event.Kind == backend.EventResync {
			if ev.SessionID != "ses_big" || ev.WorkspaceDir != "/work dir" {
				t.Fatalf("resync for %q in %q", ev.SessionID, ev.WorkspaceDir)
			}
		} else {
			k += ":" + ev.Event.Delta
		}
		kinds = append(kinds, k)
	}
	if strings.Join(kinds, ",") != "delta:before,resync,delta:after" {
		t.Fatalf("events = %v", kinds)
	}
	_ = time.Second
}
