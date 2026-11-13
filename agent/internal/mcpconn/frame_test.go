package mcpconn

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(3 * time.Second); time.Now().Before(end); time.Sleep(5 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

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

	waitFor(t, "the frame", func() bool { return len(frames()) == 1 })
	got := frames()
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

// A link that does not take frames must not stall the runtime's stdout reader:
// fromServer returns at once, and of the frames that piled up only the newest
// is sent once the link frees up.
func TestFrameForwardingNeverBlocksTheReaderAndTheLatestWins(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	var seqs []uint64
	r := newRig(t, fakeConfig("", ""), func(c *Config) {
		c.FrameFrom = map[string]bool{"fake": true}
		c.Frame = func(ch string, seq uint64, payload []byte) error {
			<-release
			mu.Lock()
			seqs = append(seqs, seq)
			mu.Unlock()
			return nil
		}
	})
	id := r.open("fake")
	r.hub.mu.Lock()
	ch := r.hub.channels[id]
	r.hub.mu.Unlock()

	done := make(chan struct{})
	go func() {
		for i := 1; i <= 50; i++ {
			ch.fromServer(frameNotification(i, 100, 100, "image/jpeg", []byte{0xff, 0xd8}))
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the reader waited on a stalled link")
	}
	close(release)
	waitFor(t, "the newest frame", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(seqs) > 0 && seqs[len(seqs)-1] == 50
	})
	mu.Lock()
	defer mu.Unlock()
	if len(seqs) > 3 {
		t.Errorf("sent %d frames, want the one in flight and the newest: %v", len(seqs), seqs)
	}
}

func TestLiveViewCallsAreAuditedInAggregate(t *testing.T) {
	r, ch, _ := frameRig(t, map[string]bool{"fake": true})
	call := func(tool, args string) {
		ch.fromClient([]byte(fmt.Sprintf(`{"jsonrpc":"2.0","method":"tools/call","params":{"name":%q,"arguments":%s}}`, tool, args)))
	}
	call("screencast", `{"action":"start","width":640}`)
	for i := 0; i < 20; i++ {
		call("screencast", `{"action":"ack","seq":1}`)
		call("screencast", `{"action":"start","width":640}`) // the keepalive
	}
	call("control", `{"action":"takeover"}`)
	for i := 0; i < 30; i++ {
		call("input", `{"events":[]}`)
		call("control", `{"action":"state"}`)
	}
	call("control", `{"action":"handback"}`)
	call("screencast", `{"action":"stop"}`)

	var got []string
	for _, l := range r.auditLines() {
		got = append(got, l)
	}
	want := []string{
		"fake screencast.start ok",
		"fake control ok",
		"fake input ok (30 calls, 0s)",
		"fake control ok",
		"fake screencast.stop ok",
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("audit = %q\nwant   %q", got, want)
	}
}

func TestLiveViewAuditIsFlushedWhenTheChannelEnds(t *testing.T) {
	r, ch, _ := frameRig(t, map[string]bool{"fake": true})
	ch.fromClient([]byte(`{"jsonrpc":"2.0","method":"tools/call","params":{"name":"screencast","arguments":{"action":"start"}}}`))
	ch.fromClient([]byte(`{"jsonrpc":"2.0","method":"tools/call","params":{"name":"input","arguments":{}}}`))
	ch.shutdown("closed", nil, false)
	got := strings.Join(r.auditLines(), "|")
	if got != "fake screencast.start ok|fake input ok (1 calls, 0s)|fake screencast.stop ok" {
		t.Fatalf("audit = %q", got)
	}
}

func TestOtherServersCallsAreStillAuditedOneByOne(t *testing.T) {
	r, ch, _ := frameRig(t, map[string]bool{"somebody-else": true})
	for i := 0; i < 3; i++ {
		ch.fromClient([]byte(`{"jsonrpc":"2.0","method":"tools/call","params":{"name":"screencast","arguments":{"action":"ack"}}}`))
	}
	if n := len(r.auditLines()); n != 3 {
		t.Fatalf("audit rows = %d, want 3", n)
	}
}
