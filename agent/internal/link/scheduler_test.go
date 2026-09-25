package link

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type fakeConn struct {
	mu  sync.Mutex
	log []string
}

func (f *fakeConn) Write(ctx context.Context, typ websocket.MessageType, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if typ == websocket.MessageText {
		f.log = append(f.log, "control")
	} else {
		f.log = append(f.log, "stream")
	}
	return nil
}

func (f *fakeConn) snapshot() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.log...)
}

// TestSchedulerControlPreemptsFlood is PROTOCOL.md §9.2's flow-control claim
// made concrete: "a session event therefore waits behind at most one 32 KiB
// terminal frame, never behind a flood." A control frame that arrives after
// a large backlog of stream frames is already queued is written after at
// most one more stream frame, not once the whole backlog drains.
//
// The afterWrite hook fires synchronously inside the scheduler's own
// goroutine right after the very first stream write, which is where it
// enqueues the control frame — this pins the race deterministically instead
// of guessing at sleep durations.
func TestSchedulerControlPreemptsFlood(t *testing.T) {
	conn := &fakeConn{}
	s := newScheduler(conn)

	const floodSize = 50
	for i := 0; i < floodSize; i++ {
		s.stream <- writeJob{msgType: websocket.MessageBinary, data: []byte(fmt.Sprintf("chunk-%d", i))}
	}

	// afterWrite runs synchronously inside the scheduler's own goroutine, so
	// enqueueing the control frame directly here — rather than from a
	// spawned goroutine racing the scheduler's next loop iteration —
	// guarantees it is already queued before that next iteration's control
	// check runs.
	var once sync.Once
	controlDone := make(chan error, 1)
	s.afterWrite = func(job writeJob) {
		once.Do(func() {
			s.control <- writeJob{msgType: websocket.MessageText, data: []byte("urgent"), done: controlDone}
		})
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.run(ctx)

	select {
	case err := <-controlDone:
		if err != nil {
			t.Fatalf("writeControl: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("control frame was never written")
	}

	// Give the scheduler a moment to also drain a couple more stream frames,
	// so the log has enough entries to check the control frame's position.
	time.Sleep(50 * time.Millisecond)

	log := conn.snapshot()
	idx := -1
	for i, entry := range log {
		if entry == "control" {
			idx = i
			break
		}
	}
	if idx == -1 {
		t.Fatal("control frame never appeared in the write log")
	}
	// afterWrite fired after log[0] (the first stream frame), so the control
	// frame must land at index 1: at most one stream frame ahead of it.
	if idx != 1 {
		t.Fatalf("control frame was written at index %d (log=%v); want index 1 (at most one stream frame ahead)", idx, log)
	}
}
