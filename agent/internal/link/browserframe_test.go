package link

import (
	"bytes"
	"context"
	"encoding/binary"
	"net/http"
	"testing"
	"time"
)

func TestBrowserFramePayloadLayout(t *testing.T) {
	p := BrowserFramePayload(1280, 800, []byte{0xff, 0xd8, 0x01})
	if binary.BigEndian.Uint16(p[0:]) != 1280 || binary.BigEndian.Uint16(p[2:]) != 800 || !bytes.Equal(p[4:], []byte{0xff, 0xd8, 0x01}) {
		t.Fatalf("payload = % x", p)
	}
}

func TestBrowserFrameRoundTrip(t *testing.T) {
	payload := BrowserFramePayload(390, 844, bytes.Repeat([]byte{7}, 5000))
	wire, err := EncodeBinaryFrame(BinaryFrame{Kind: BinBrowserFrame, Channel: "ch_0123456789ab", Offset: 42, Payload: payload})
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecodeBinaryFrame(wire)
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != BinBrowserFrame || got.Channel != "ch_0123456789ab" || got.Offset != 42 || !bytes.Equal(got.Payload, payload) {
		t.Fatalf("round trip = %+v", got)
	}
}

// A browser frame is never taken as an inbound frame: it is M→C only, so one arriving from
// Cerea reaches no handler.
func TestInboundBrowserFrameIsIgnored(t *testing.T) {
	called := make(chan struct{}, 1)
	l := New(Config{Binary: binaryFunc(func(byte, string, uint64, []byte) { called <- struct{}{} })})
	wire, _ := EncodeBinaryFrame(BinaryFrame{Kind: BinBrowserFrame, Channel: "c", Payload: []byte{1}})
	l.handleBinaryFrame(wire)
	select {
	case <-called:
		t.Fatal("an inbound browser frame reached the binary handler")
	default:
	}
}

type binaryFunc func(kind byte, channel string, offset uint64, payload []byte)

func (f binaryFunc) HandleBinary(kind byte, channel string, offset uint64, payload []byte) {
	f(kind, channel, offset, payload)
}

// SendBrowserFrame writes one binary websocket message on the stream lane, and refuses a payload
// past the frame cap and a link that is not connected.
func TestSendBrowserFrameThroughTheLink(t *testing.T) {
	in := make(chan []byte, 8)
	send := make(chan []byte, 8)
	srv := newFakeCereaServer(t, func(sc *serverConn, _ *http.Request) {
		go func() {
			for {
				typ, raw, err := sc.conn.Read(context.Background())
				if err != nil {
					return
				}
				if typ == 2 { // binary
					in <- raw
				}
			}
		}()
		for raw := range send {
			if err := sc.conn.Write(context.Background(), 1, raw); err != nil {
				return
			}
		}
	})
	l := New(Config{
		CereaOrigin: srv.URL, MachineID: "m", MachineName: "n", Cred: &fakeCred{token: "t"},
		Hello:   func() Hello { return Hello{} },
		Handler: &fakeHandler{calls: make(chan string, 1)}, MinBackoff: time.Hour,
	})
	if err := l.SendBrowserFrame("ch_a", 1, []byte{1}); err == nil {
		t.Fatal("a frame was sent on a link that is not connected")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = l.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); close(send); <-done })
	send <- []byte(`{"type":"welcome","deviceId":"d","status":"paired"}`)
	waitFor(t, l.Connected, "connected")

	payload := BrowserFramePayload(640, 400, []byte{0xff, 0xd8, 0xff})
	if err := l.SendBrowserFrame("ch_abc", 9, payload); err != nil {
		t.Fatal(err)
	}
	select {
	case raw := <-in:
		f, err := DecodeBinaryFrame(raw)
		if err != nil {
			t.Fatal(err)
		}
		if f.Kind != BinBrowserFrame || f.Channel != "ch_abc" || f.Offset != 9 || !bytes.Equal(f.Payload, payload) {
			t.Fatalf("frame = %+v", f)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no binary frame arrived")
	}
	if err := l.SendBrowserFrame("ch_abc", 10, make([]byte, MaxBrowserFramePayload+1)); err == nil {
		t.Fatal("a frame past the cap was sent")
	}
}
