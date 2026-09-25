package link

import (
	"context"

	"github.com/coder/websocket"
)

// MaxStreamChunk bounds one stream-lane write (PROTOCOL.md §9.2): a session
// event therefore waits behind at most one frame this size, never behind a
// flood of terminal output.
const MaxStreamChunk = 32 << 10

// wsWriter is the one method the scheduler needs from *websocket.Conn —
// split out so tests can drive it with a fake instead of a real socket.
type wsWriter interface {
	Write(ctx context.Context, typ websocket.MessageType, data []byte) error
}

type writeJob struct {
	msgType websocket.MessageType
	data    []byte
	done    chan error
}

// scheduler is galopin's writer (PROTOCOL.md §4.1 of the plan, §9.2 of the
// spec): one goroutine owns the connection and drains the control lane
// (res/event/notice/credential/auth) completely before writing a single
// stream frame (term.output), replacing the single writeMu every frame used
// to share. A slow or huge terminal output burst therefore never delays a
// control frame by more than one already-in-flight stream write.
type scheduler struct {
	conn    wsWriter
	control chan writeJob
	stream  chan writeJob

	// afterWrite, when set, is called synchronously in run's own goroutine
	// right after every write — tests use it to interleave a control frame
	// deterministically instead of racing on real time.
	afterWrite func(writeJob)
}

func newScheduler(conn wsWriter) *scheduler {
	return &scheduler{
		conn:    conn,
		control: make(chan writeJob, 64),
		stream:  make(chan writeJob, 256),
	}
}

// run drains both lanes until ctx is done, always preferring control.
func (s *scheduler) run(ctx context.Context) {
	for {
		for {
			select {
			case job := <-s.control:
				s.write(ctx, job)
				continue
			default:
			}
			break
		}
		select {
		case <-ctx.Done():
			s.drain(ctx.Err())
			return
		case job := <-s.control:
			s.write(ctx, job)
		case job := <-s.stream:
			s.write(ctx, job)
		}
	}
}

func (s *scheduler) write(ctx context.Context, job writeJob) {
	err := s.conn.Write(ctx, job.msgType, job.data)
	if job.done != nil {
		job.done <- err
	}
	if s.afterWrite != nil {
		s.afterWrite(job)
	}
}

// drain fails every already-queued job with err once run is stopping, so no
// caller blocked in writeControl/writeStream waits forever.
func (s *scheduler) drain(err error) {
	for {
		select {
		case job := <-s.control:
			if job.done != nil {
				job.done <- err
			}
		case job := <-s.stream:
			if job.done != nil {
				job.done <- err
			}
		default:
			return
		}
	}
}

// writeControl enqueues data on the control lane and waits for it to be
// written (or for ctx to end).
func (s *scheduler) writeControl(ctx context.Context, typ websocket.MessageType, data []byte) error {
	return s.enqueue(ctx, s.control, typ, data)
}

// writeStream enqueues one physical write on the stream lane. Each call is
// one websocket message — for term.output that must be one complete binary
// frame (header plus payload), so this never splits data itself; the
// caller (internal/terminal's flushViewer) is what keeps every payload at
// or under MaxOutputFrame so the resulting frame stays within
// MaxStreamChunk.
func (s *scheduler) writeStream(ctx context.Context, typ websocket.MessageType, data []byte) error {
	return s.enqueue(ctx, s.stream, typ, data)
}

func (s *scheduler) enqueue(ctx context.Context, lane chan writeJob, typ websocket.MessageType, data []byte) error {
	done := make(chan error, 1)
	select {
	case lane <- writeJob{msgType: typ, data: data, done: done}:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}
