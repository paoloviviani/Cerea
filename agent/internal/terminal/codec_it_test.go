//go:build unix

package terminal

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"galopin/internal/link"
)

// TestEchoOverRealPTYThroughTheCodec is the brief's required smoke test:
// `echo $((6*7))` over a real PTY produces 42, carried the way it actually
// travels on the wire — every OutputFunc callback is round-tripped through
// link.EncodeBinaryFrame/DecodeBinaryFrame (PROTOCOL.md §9.2) rather than
// just concatenated in memory, so a header bug here would fail this test
// even though internal/link's own codec tests pass in isolation.
func TestEchoOverRealPTYThroughTheCodec(t *testing.T) {
	if !Supported {
		t.Skip("terminals are not supported on this OS")
	}
	var mu sync.Mutex
	var decoded strings.Builder

	t.Setenv("TMPDIR", itTmpDir(t))
	root := t.TempDir()
	term, err := Open(OpenConfig{
		ID: "t1", WorkspaceID: "w1", WorkspaceRoot: root, Cols: 80, Rows: 24,
		OnOutput: func(_, channel string, offset uint64, payload []byte) {
			frame, err := link.EncodeBinaryFrame(link.BinaryFrame{
				Kind: link.BinTermOutput, Channel: channel, Offset: offset, Payload: payload,
			})
			if err != nil {
				t.Errorf("encoding a term.output frame: %v", err)
				return
			}
			back, err := link.DecodeBinaryFrame(frame)
			if err != nil {
				t.Errorf("decoding the re-encoded frame: %v", err)
				return
			}
			mu.Lock()
			decoded.Write(back.Payload)
			mu.Unlock()
		},
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() {
		term.Close(true)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := term.Wait(ctx); err != nil {
			t.Errorf("shell did not exit after Close: %v", err)
		}
	}()
	term.Attach("c1", nil)

	if _, err := term.Write([]byte("echo $((6*7))\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		got := decoded.String()
		mu.Unlock()
		if strings.Contains(got, "42") {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	t.Fatalf("never saw 42 in the decoded output; got %q", decoded.String())
}
