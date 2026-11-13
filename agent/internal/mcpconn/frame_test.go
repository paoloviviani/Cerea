package mcpconn

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"strings"
	"sync"
	"testing"
)

type gotFrame struct {
	channel string
	seq     uint64
	payload []byte
}

func frameRig(t *testing.T, from map[string]bool) (*rig, *channel, func() []gotFrame) {
	t.Helper()
	var mu sync.Mutex
	var frames []gotFrame
	r := newRig(t, fakeConfig("", ""), func(c *Config) {
		c.FrameFrom = from
		c.Frame = func(ch string, seq uint64, payload []byte) error {
			mu.Lock()
			frames = append(frames, gotFrame{ch, seq, append([]byte(nil), payload...)})
			mu.Unlock()
			return nil
		}
	})
	id := r.open("fake")
	r.hub.mu.Lock()
	ch := r.hub.channels[id]
	r.hub.mu.Unlock()
	return r, ch, func() []gotFrame {
		mu.Lock()
		defer mu.Unlock()
		return append([]gotFrame(nil), frames...)
	}
}

func frameNotification(seq int, w, h int, mime string, jpeg []byte) []byte {
	return []byte(fmt.Sprintf(`{"jsonrpc":"2.0","method":"notifications/cerea/frame","params":{"seq":%d,"w":%d,"h":%d,"mime":%q,"data":%q}}`,
		seq, w, h, mime, base64.StdEncoding.EncodeToString(jpeg)))
}

func TestFrameNotificationBecomesABinaryFrame(t *testing.T) {
	r, ch, frames := frameRig(t, map[string]bool{"fake": true})
	jpeg := []byte{0xff, 0xd8, 0xff, 0xe0, 1, 2, 3}
	ch.fromServer(frameNotification(7, 1280, 800, "image/jpeg", jpeg))

	got := frames()
	if len(got) != 1 {
		t.Fatalf("frames = %d, want 1", len(got))
	}
	if got[0].channel != ch.id || got[0].seq != 7 {
		t.Errorf("frame = %+v", got[0])
	}
	if binary.BigEndian.Uint16(got[0].payload[0:]) != 1280 || binary.BigEndian.Uint16(got[0].payload[2:]) != 800 {
		t.Errorf("viewport header = % x", got[0].payload[:4])
	}
	if string(got[0].payload[4:]) != string(jpeg) {
		t.Errorf("jpeg bytes changed")
	}
	// Nothing about the frame goes to Cerea as an mcp message.
	select {
	case f := <-r.frames:
		t.Fatalf("the notification was also passed on as JSON: %s", f.message)
	default:
	}
}

func TestFrameNotificationDropsWhatIsNotAJPEGFrame(t *testing.T) {
	r, ch, frames := frameRig(t, map[string]bool{"fake": true})
	ch.fromServer(frameNotification(1, 100, 100, "image/png", []byte{1}))                  // wrong type
	ch.fromServer(frameNotification(2, 0, 100, "image/jpeg", []byte{1}))                   // no size
	ch.fromServer(frameNotification(3, 70000, 100, "image/jpeg", []byte{1}))               // size past a u16
	ch.fromServer([]byte(`{"method":"notifications/cerea/frame","params":{"data":"%%"}}`)) // not base64
	ch.fromServer(frameNotification(4, 100, 100, "image/jpeg", make([]byte, 2<<20)))       // too large
	if got := frames(); len(got) != 0 {
		t.Fatalf("frames = %+v", got)
	}
	select {
	case f := <-r.frames:
		t.Fatalf("a dropped frame was passed on as JSON: %.80s", f.message)
	default:
	}
}

func TestFrameNotificationFromAnotherServerIsPassedOn(t *testing.T) {
	r, ch, frames := frameRig(t, map[string]bool{"somebody-else": true})
	ch.fromServer(frameNotification(1, 100, 100, "image/jpeg", []byte{0xff, 0xd8}))
	if len(frames()) != 0 {
		t.Fatal("a server that is not the browser runtime made a frame")
	}
	f := r.next()
	if !strings.Contains(string(f.message), "notifications/cerea/frame") {
		t.Errorf("message = %.80s", f.message)
	}
}
