package link

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"

	"galopin/internal/protofix"
)

type fakeMcp struct {
	mu       sync.Mutex
	got      []string // channelId + " " + message, in order
	linkDown chan struct{}
	notify   chan struct{}
}

func newFakeMcp() *fakeMcp {
	return &fakeMcp{linkDown: make(chan struct{}, 4), notify: make(chan struct{}, 64)}
}

func (m *fakeMcp) HandleMcp(channelID string, message json.RawMessage) {
	m.mu.Lock()
	m.got = append(m.got, channelID+" "+string(message))
	m.mu.Unlock()
	m.notify <- struct{}{}
}

func (m *fakeMcp) LinkDown() { m.linkDown <- struct{}{} }

// The mcp frames of PROTOCOL.md §10.3 through a real Link: the C→M fixtures
// reach the McpHandler with the message untouched, and the frames the link
// writes for PublishMcp and PublishMcpClosed equal the M→C fixtures. A frame
// before pairing is dropped, and the handler hears when the link goes down.
func TestMcpFixturesThroughTheLink(t *testing.T) {
	fixtures := protofix.Load(t)
	var c2m, m2c, closed []protofix.Fixture
	for _, f := range fixtures {
		if f.Head(t).Type != "mcp" {
			continue
		}
		switch {
		case f.Meta.Direction == "C→M":
			c2m = append(c2m, f)
		case protofix.Field(f.Frame, "closed") != nil:
			closed = append(closed, f)
		default:
			m2c = append(m2c, f)
		}
	}
	if len(c2m) == 0 || len(m2c) == 0 || len(closed) == 0 {
		t.Fatalf("fixtures: %d C→M, %d M→C, %d closed", len(c2m), len(m2c), len(closed))
	}

	in := make(chan []byte, 64)
	send := make(chan []byte, 64)
	dropServer := make(chan struct{})
	srv := newFakeCereaServer(t, func(sc *serverConn, _ *http.Request) {
		go func() {
			for {
				_, raw, err := sc.conn.Read(context.Background())
				if err != nil {
					return
				}
				in <- raw
			}
		}()
		for {
			select {
			case raw := <-send:
				if err := sc.conn.Write(context.Background(), 1, raw); err != nil {
					return
				}
			case <-dropServer:
				sc.conn.CloseNow()
				return
			}
		}
	})
	h := newFakeMcp()
	l := New(Config{
		CereaOrigin: srv.URL, MachineID: "m", MachineName: "n", Cred: &fakeCred{token: "t"},
		Hello:   func() Hello { return Hello{} },
		Handler: &fakeHandler{calls: make(chan string, 1)}, Mcp: h, MinBackoff: time.Hour,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = l.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	// Pending welcome: an mcp frame before pairing is dropped.
	send <- []byte(`{"type":"welcome","deviceId":"d","status":"pending"}`)
	waitFor(t, func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		return l.sched != nil
	}, "connected")
	send <- c2m[0].Frame
	send <- []byte(`{"type":"status","status":"paired"}`)
	waitFor(t, l.Paired, "paired")

	for _, f := range c2m {
		send <- f.Frame
		select {
		case <-h.notify:
		case <-time.After(3 * time.Second):
			t.Fatalf("%s did not reach the handler", f.File)
		}
		var want struct {
			ChannelID string          `json:"channelId"`
			Message   json.RawMessage `json:"message"`
		}
		_ = json.Unmarshal(f.Frame, &want)
		h.mu.Lock()
		got := h.got[len(h.got)-1]
		h.mu.Unlock()
		if got != want.ChannelID+" "+string(want.Message) {
			t.Errorf("%s: handler saw %s", f.File, got)
		}
	}
	h.mu.Lock()
	if len(h.got) != len(c2m) {
		t.Errorf("the frame before pairing reached the handler: %v", h.got)
	}
	h.mu.Unlock()

	next := func() []byte {
		t.Helper()
		for {
			select {
			case raw := <-in:
				var hd struct{ Type string }
				_ = json.Unmarshal(raw, &hd)
				if hd.Type == "mcp" {
					return raw
				}
			case <-time.After(3 * time.Second):
				t.Fatal("the link sent no mcp frame")
			}
		}
	}
	for _, f := range m2c {
		var m struct {
			ChannelID string          `json:"channelId"`
			Message   json.RawMessage `json:"message"`
		}
		_ = json.Unmarshal(f.Frame, &m)
		if err := l.PublishMcp(m.ChannelID, m.Message); err != nil {
			t.Fatal(err)
		}
		if err := protofix.Same(f.Frame, next()); err != nil {
			t.Errorf("%s: %v", f.File, err)
		}
	}
	for _, f := range closed {
		var m struct {
			ChannelID string `json:"channelId"`
			Closed    struct {
				Reason string  `json:"reason"`
				Detail *string `json:"detail"`
			} `json:"closed"`
		}
		_ = json.Unmarshal(f.Frame, &m)
		if err := l.PublishMcpClosed(m.ChannelID, m.Closed.Reason, m.Closed.Detail); err != nil {
			t.Fatal(err)
		}
		if err := protofix.Same(f.Frame, next()); err != nil {
			t.Errorf("%s: %v", f.File, err)
		}
	}

	close(dropServer)
	select {
	case <-h.linkDown:
	case <-time.After(3 * time.Second):
		t.Fatal("the handler was not told the link went down")
	}
}
