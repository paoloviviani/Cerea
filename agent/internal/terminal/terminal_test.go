package terminal

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// outputCollector is an OutputFunc that appends every frame's payload,
// synchronized for concurrent use by the read loop.
type outputCollector struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (c *outputCollector) collect(_, _ string, _ uint64, payload []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.buf.Write(payload)
}

func (c *outputCollector) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.String()
}

// waitForExit attaches a viewer (so output actually flows) and blocks until
// term's process exits or the test's patience runs out.
func waitForExit(t *testing.T, term *Terminal) {
	t.Helper()
	term.Attach("test-channel", nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := term.Wait(ctx); err != nil {
		t.Fatalf("waiting for the shell to exit: %v", err)
	}
	time.Sleep(200 * time.Millisecond) // let the last output frame land
}

func TestResolveCwdRefusesDotDot(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveCwd(root, "../etc"); !errors.Is(err, ErrInvalidCwd) {
		t.Fatalf("expected ErrInvalidCwd for a '..' escape, got %v", err)
	}
	if _, err := ResolveCwd(root, "sub/../../etc"); !errors.Is(err, ErrInvalidCwd) {
		t.Fatalf("expected ErrInvalidCwd for a nested '..' escape, got %v", err)
	}
}

func TestResolveCwdRefusesEscapingSymlink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveCwd(root, "escape"); !errors.Is(err, ErrInvalidCwd) {
		t.Fatalf("expected ErrInvalidCwd for a symlink escaping the root, got %v", err)
	}
}

func TestResolveCwdAcceptsSubdirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	abs, err := ResolveCwd(root, "sub")
	if err != nil {
		t.Fatalf("ResolveCwd: %v", err)
	}
	want, _ := filepath.EvalSymlinks(filepath.Join(root, "sub"))
	got, _ := filepath.EvalSymlinks(abs)
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestResolveCwdAcceptsRoot(t *testing.T) {
	root := t.TempDir()
	abs, err := ResolveCwd(root, "")
	if err != nil {
		t.Fatalf("ResolveCwd: %v", err)
	}
	want, _ := filepath.EvalSymlinks(root)
	got, _ := filepath.EvalSymlinks(abs)
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// --- fakes for the credit / lifecycle / attach tests below, no real PTY ---

// fakePty is an in-memory ptyIO: writes to it are just recorded (looping
// input back is not needed by these tests). Its data channel is unbuffered
// on purpose: a produce() call only returns once the read loop actually
// calls Read, so a test can tell "the read loop is/isn't consuming" from
// whether produce() is blocking — the same backpressure a real PTY gives a
// reader that stops reading. stop (closed by Close) is what lets a
// producer goroutine left over from a credit-exhaustion test unblock
// cleanly instead of leaking or panicking on a closed channel.
type fakePty struct {
	mu        sync.Mutex
	data      chan []byte
	stop      chan struct{}
	closeOnce sync.Once
	writes    bytes.Buffer
	pending   []byte // a chunk larger than the caller's buffer leaves a remainder here, like a real PTY's kernel buffer would
}

func newFakePty() *fakePty { return &fakePty{data: make(chan []byte), stop: make(chan struct{})} }

// Read is only ever called from a Terminal's own single read-loop goroutine,
// so pending needs no locking of its own.
func (f *fakePty) Read(p []byte) (int, error) {
	if len(f.pending) > 0 {
		n := copy(p, f.pending)
		f.pending = f.pending[n:]
		return n, nil
	}
	select {
	case chunk, ok := <-f.data:
		if !ok {
			return 0, io.EOF
		}
		n := copy(p, chunk)
		if n < len(chunk) {
			f.pending = append([]byte(nil), chunk[n:]...)
		}
		return n, nil
	case <-f.stop:
		return 0, io.EOF
	}
}

func (f *fakePty) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.writes.Write(p)
}

func (f *fakePty) Close() error {
	f.closeOnce.Do(func() { close(f.stop) })
	return nil
}

// produce feeds one chunk of output, blocking until the read loop consumes
// it or the fake is closed.
func (f *fakePty) produce(b []byte) {
	select {
	case f.data <- append([]byte(nil), b...):
	case <-f.stop:
	}
}

type fakeResizer struct {
	mu         sync.Mutex
	cols, rows int
}

func (r *fakeResizer) Resize(cols, rows int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cols, r.rows = cols, rows
	return nil
}

// noProcess is a process that never exits on its own — the fake PTY's
// Close (via Terminal.finish) is what ends these tests' terminals.
type noProcess struct{ done chan struct{} }

func (p *noProcess) Wait() error {
	<-p.done
	return nil
}
func (p *noProcess) Signal(Signal) error { return nil }
func (p *noProcess) Pid() int            { return 1 }

func newFakeTerminal(onOutput OutputFunc) (*Terminal, *fakePty) {
	fp := newFakePty()
	// Sharing fp.stop means closing the fake PTY also ends the fake
	// process's Wait(), so the terminal's exit-watcher goroutine (started
	// by newTerminal) always terminates instead of leaking past the test.
	proc := &noProcess{done: fp.stop}
	t := newTerminal("fake", "ws1", ".", "/bin/sh", 80, 24, fp, &fakeResizer{}, proc, onOutput, nil)
	t.starveTimeout = 100 * time.Millisecond
	t.pollInterval = 5 * time.Millisecond
	return t, fp
}

func TestCreditWindowBlocksBeyond256KiB(t *testing.T) {
	var mu sync.Mutex
	received := 0
	term, fp := newFakeTerminal(func(_, _ string, _ uint64, payload []byte) {
		mu.Lock()
		received += len(payload)
		mu.Unlock()
	})
	defer func() { _ = fp.Close() }()

	term.Attach("v1", int64Ptr(0))

	// Produce well over the credit window's worth of output, in the
	// background: once credit runs out the read loop stops reading, so a
	// synchronous producer would block forever on the unbuffered fake PTY.
	chunk := bytes.Repeat([]byte("y"), 8192)
	go func() {
		for i := 0; i < 40; i++ { // 40 * 8192 = 320 KiB > CreditWindow (256 KiB)
			fp.produce(chunk)
		}
	}()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		r := received
		mu.Unlock()
		if r >= CreditWindow {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(150 * time.Millisecond) // let anything still in flight land
	mu.Lock()
	got := received
	mu.Unlock()
	if got > CreditWindow {
		t.Fatalf("received %d bytes without an ack, want at most CreditWindow=%d", got, CreditWindow)
	}
	if got == 0 {
		t.Fatal("expected some output before hitting the credit ceiling")
	}
}

func TestCreditAckResumesOutput(t *testing.T) {
	var mu sync.Mutex
	received := 0
	term, fp := newFakeTerminal(func(_, _ string, _ uint64, payload []byte) {
		mu.Lock()
		received += len(payload)
		mu.Unlock()
	})
	defer func() { _ = fp.Close() }()

	term.Attach("v1", int64Ptr(0))
	chunk := bytes.Repeat([]byte("z"), 8192)
	for i := 0; i < 40; i++ {
		fp.produce(chunk)
	}
	waitFor(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return received >= CreditWindow
	}, 2*time.Second)

	if err := term.Ack("v1", CreditWindow); err != nil {
		t.Fatalf("Ack: %v", err)
	}
	// More credit is now available: eventually more than CreditWindow total
	// must have been delivered.
	waitFor(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return received > CreditWindow
	}, 2*time.Second)
}

func TestZeroViewersRingFillsWithoutBlocking(t *testing.T) {
	term, fp := newFakeTerminal(nil)
	defer func() { _ = fp.Close() }()

	chunk := bytes.Repeat([]byte("q"), 8192)
	// Far more than the ring's capacity, with no viewer ever attached — the
	// read loop must never pause on credit with zero viewers, or these
	// sends to the fake PTY's unbuffered channel would block forever.
	done := make(chan struct{})
	go func() {
		for i := 0; i < 400; i++ { // ~3.1 MiB, more than RingCapacity (2 MiB)
			fp.produce(chunk)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("producing output with zero viewers blocked — the ring should keep filling regardless")
	}
	waitFor(t, func() bool {
		_, total := term.ring.Bounds()
		return total >= int64(len(chunk))*400
	}, 2*time.Second)
	start, total := term.ring.Bounds()
	if total-start > RingCapacity {
		t.Fatalf("ring holds more than capacity: %d", total-start)
	}
}

func TestAttachFreshWithNoOffsetIsAlwaysReset(t *testing.T) {
	term, fp := newFakeTerminal(nil)
	defer func() { _ = fp.Close() }()
	_, reset, _, _ := term.Attach("v1", nil)
	if !reset {
		t.Fatal("attaching with no `from` must always be a reset")
	}
}

func TestAttachEvictedOffsetIsReset(t *testing.T) {
	term, fp := newFakeTerminal(nil)
	defer func() { _ = fp.Close() }()
	fp.produce(bytes.Repeat([]byte("a"), RingCapacity+1000))
	waitFor(t, func() bool {
		_, total := term.ring.Bounds()
		return total >= RingCapacity+1000
	}, 2*time.Second)
	from, reset, _, _ := term.Attach("v1", int64Ptr(0))
	if !reset {
		t.Fatal("attaching at an evicted offset must be a reset")
	}
	start, _ := term.ring.Bounds()
	if from != start {
		t.Fatalf("effective from = %d, want the ring start %d", from, start)
	}
}

func TestAttachWithinRingIsNotReset(t *testing.T) {
	term, fp := newFakeTerminal(func(string, string, uint64, []byte) {})
	defer func() { _ = fp.Close() }()
	fp.produce([]byte("hello"))
	waitFor(t, func() bool {
		_, total := term.ring.Bounds()
		return total >= 5
	}, 2*time.Second)
	from, reset, _, _ := term.Attach("v1", int64Ptr(2))
	if reset {
		t.Fatal("attaching within the ring's live range must not be a reset")
	}
	if from != 2 {
		t.Fatalf("from = %d, want 2", from)
	}
}

func int64Ptr(v int64) *int64 { return &v }

func waitFor(t *testing.T, cond func() bool, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !cond() {
		t.Fatal("condition never became true")
	}
}
