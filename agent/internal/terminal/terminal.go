// Package terminal runs PTY-backed shells for the /code terminal
// (PROTOCOL.md §9, ADR 0090): spawn, a byte ring so a viewer can reattach, a
// mode tracker for the reset prelude, per-viewer credit-based flow control,
// and the lifecycle rules (idle reap, exit retention, revoke teardown).
//
// A Terminal never touches the backend (opencode/ACP) and is not gated by
// workspaceRoots the way workspace.create is — cwd confinement here is a
// starting-point courtesy via os.Root, not a sandbox: once the shell runs,
// nothing in this package restricts what it does, exactly as ADR 0090 says.
package terminal

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"galopin/internal/files"
)

// CreditWindow is how much unacked output one viewer may be sent before
// galopin stops sending it more (PROTOCOL.md §9.2).
const CreditWindow = 256 << 10

// MaxOutputFrame bounds one term.output payload (PROTOCOL.md §9.2).
const MaxOutputFrame = 32 << 10

// DefaultStarveTimeout is how long every viewer must be out of credit before
// galopin resumes reading into the ring anyway, so a background build never
// hangs because every tab is asleep (PROTOCOL.md §9.2).
const DefaultStarveTimeout = 10 * time.Second

// DefaultPollInterval is how often the read loop rechecks whether it may
// resume: after an ack, after a viewer (dis)connects, or once the starve
// timeout elapses. Not event-driven, so real responsiveness is bounded by
// this — small enough that it is not felt in practice.
const DefaultPollInterval = 20 * time.Millisecond

// IdleReapAfter is how long a terminal may sit with no attached viewer
// before it gets SIGHUP (PROTOCOL.md §9.3 "Terminal process rules").
const IdleReapAfter = 24 * time.Hour

// ExitRetention is how long an exited terminal is kept (with its exit code)
// before Manager.Reap drops it for good.
const ExitRetention = 10 * time.Minute

var (
	// ErrInvalidCwd is returned when a requested cwd does not resolve inside
	// the workspace root (PROTOCOL.md §9.1).
	ErrInvalidCwd = errors.New("terminal: cwd must resolve inside the workspace")
	// ErrClosed is returned by operations on a terminal that has already
	// been closed.
	ErrClosed = errors.New("terminal: closed")
	// ErrUnknownChannel is returned by Detach/Ack/Resize for a channel that
	// never attached (or already detached).
	ErrUnknownChannel = errors.New("terminal: unknown channel")
)

// State is Terminal.State (PROTOCOL.md §9.3 Terminal).
type State string

const (
	StateRunning State = "running"
	StateExited  State = "exited"
)

// Notice mirrors PROTOCOL.md §9.3's Notice union for the two terminal kinds
// this package emits; Manager wraps these into the wire's notice frame.
type Notice struct {
	Kind     string    `json:"kind"` // "terminal.exit" | "terminal.title" | "terminal.state"
	ExitCode *int      `json:"exitCode,omitempty"`
	Signal   string    `json:"signal,omitempty"`
	Title    string    `json:"title,omitempty"`
	Terminal *Snapshot `json:"terminal,omitempty"` // terminal.state only
}

// Snapshot is the wire's Terminal type (PROTOCOL.md §9.3).
type Snapshot struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspaceId"`
	Title       string    `json:"title"`
	Cwd         string    `json:"cwd"`
	Shell       string    `json:"shell"`
	Cols        int       `json:"cols"`
	Rows        int       `json:"rows"`
	PID         int       `json:"pid"`
	CreatedAt   time.Time `json:"createdAt"`
	State       State     `json:"state"`
	ExitCode    *int      `json:"exitCode,omitempty"`
	Signal      *string   `json:"signal,omitempty"`
	Offset      int64     `json:"offset"`
	Viewers     int       `json:"viewers"`
}

// ptyIO is the read/write/close surface a Terminal needs from its PTY. The
// real spawn path (spawn_unix.go) satisfies it with *os.File; tests satisfy
// it with an in-memory fake, so ring/credit/coalescer behaviour is testable
// without a real shell.
type ptyIO interface {
	io.Reader
	io.Writer
	Close() error
}

// resizer is the subset of pty's API a Terminal needs to change the PTY's
// window size — split out so tests can stub it without creack/pty.
type resizer interface {
	Resize(cols, rows int) error
}

// process is the subset of os/exec's *exec.Cmd a Terminal needs once it has
// been started: waiting for exit and delivering signals to the whole
// process group. spawn_unix.go's real implementation wraps *exec.Cmd; tests
// use a fake.
type process interface {
	Wait() error
	Signal(sig Signal) error
	Pid() int
}

// Signal is a small, OS-shaped enum so this package's public API does not
// import syscall (which differs across platforms) — spawn_unix.go maps it.
type Signal int

const (
	SignalHUP Signal = iota
	SignalKILL
)

type viewer struct {
	channel  string
	acked    uint64
	sentUpTo uint64
}

func (v *viewer) hasCredit() bool { return v.sentUpTo-v.acked < CreditWindow }

// OutputFunc delivers one term.output frame to Cerea for (terminalID,
// channel), payload starting at the given absolute offset.
type OutputFunc func(terminalID, channel string, offset uint64, payload []byte)

// NoticeFunc delivers a terminal-scoped notice (PROTOCOL.md §9.5).
type NoticeFunc func(terminalID string, n Notice)

// Terminal is one PTY-backed shell.
type Terminal struct {
	ID          string
	WorkspaceID string
	Cwd         string
	Shell       string

	ptmx ptyIO
	rsz  resizer
	proc process
	ring *Ring
	mode *ModeTracker

	starveTimeout time.Duration
	pollInterval  time.Duration

	onOutput OutputFunc
	onNotice NoticeFunc

	mu           sync.Mutex
	title        string
	cols, rows   int
	createdAt    time.Time
	state        State
	exitCode     *int
	signal       *string
	exitedAt     time.Time
	sizeClaimed  bool
	viewers      map[string]*viewer
	lastViewerAt time.Time
	starvedSince time.Time

	closeOnce sync.Once
	doneCh    chan struct{}
}

// newTerminal builds a Terminal around an already-spawned PTY. Unexported:
// callers use Open (the real spawn) or the test helper in terminal_test.go.
func newTerminal(id, workspaceID, cwd, shell string, cols, rows int, ptmx ptyIO, rsz resizer, proc process, onOutput OutputFunc, onNotice NoticeFunc) *Terminal {
	t := &Terminal{
		ID: id, WorkspaceID: workspaceID, Cwd: cwd, Shell: shell,
		ptmx: ptmx, rsz: rsz, proc: proc,
		ring: NewRing(), mode: NewModeTracker(),
		starveTimeout: DefaultStarveTimeout, pollInterval: DefaultPollInterval,
		onOutput: onOutput, onNotice: onNotice,
		cols: cols, rows: rows, createdAt: time.Now(), state: StateRunning,
		viewers: map[string]*viewer{}, lastViewerAt: time.Now(),
		doneCh: make(chan struct{}),
	}
	go t.readLoop()
	if proc != nil {
		go func() {
			err := proc.Wait()
			t.finish(exitInfo(err))
		}()
	}
	return t
}

// exitInfo turns a Wait() error into (exitCode, signal) the way PROTOCOL.md
// §9.3's Terminal reports it.
func exitInfo(err error) (*int, *string) {
	if err == nil {
		zero := 0
		return &zero, nil
	}
	var exitErr interface{ ExitCode() int }
	if errors.As(err, &exitErr) {
		code := exitErr.ExitCode()
		if code >= 0 {
			return &code, nil
		}
	}
	sig := err.Error()
	return nil, &sig
}

func (t *Terminal) finish(exitCode *int, signal *string) {
	t.mu.Lock()
	already := t.state == StateExited
	if !already {
		t.state = StateExited
		t.exitCode = exitCode
		t.signal = signal
		t.exitedAt = time.Now()
	}
	t.mu.Unlock()
	if !already {
		_ = t.ptmx.Close()
		close(t.doneCh)
		if t.onNotice != nil {
			t.onNotice(t.ID, Notice{Kind: "terminal.exit", ExitCode: exitCode, Signal: derefStr(signal)})
		}
	}
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// readLoop pumps PTY output into the ring and to attached viewers, honouring
// the slow-viewer rules (PROTOCOL.md §9.2): paused while every viewer is out
// of credit, unless there are no viewers or every viewer has been out of
// credit for starveTimeout, in which case it keeps filling the ring.
func (t *Terminal) readLoop() {
	buf := make([]byte, MaxOutputFrame)
	for {
		for !t.shouldRead() {
			select {
			case <-t.doneCh:
				return
			case <-time.After(t.pollInterval):
			}
		}
		n, err := t.ptmx.Read(buf)
		if n > 0 {
			t.ingest(append([]byte(nil), buf[:n]...))
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				msg := err.Error()
				t.finish(nil, &msg)
			} else {
				t.finish(nil, nil)
			}
			return
		}
	}
}

func (t *Terminal) shouldRead() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.viewers) == 0 {
		t.starvedSince = time.Time{}
		return true
	}
	for _, v := range t.viewers {
		if v.hasCredit() {
			t.starvedSince = time.Time{}
			return true
		}
	}
	if t.starvedSince.IsZero() {
		t.starvedSince = time.Now()
	}
	return time.Since(t.starvedSince) >= t.starveTimeout
}

// osc0or2Title extracts the title from a trailing, complete OSC 0/2
// sequence in chunk (`ESC ] 0 ; text BEL` or `ESC ] 2 ; text BEL`, ST
// (`ESC \`) also accepted as the terminator). Best-effort: a title split
// across two reads is simply missed, since titles are cosmetic (PROTOCOL.md
// §9.3 terminal.title) and this never touches the ring's own bytes.
func oscTitle(chunk []byte) (string, bool) {
	s := string(chunk)
	for _, prefix := range []string{"\x1b]0;", "\x1b]2;"} {
		idx := strings.LastIndex(s, prefix)
		if idx < 0 {
			continue
		}
		rest := s[idx+len(prefix):]
		if end := strings.IndexByte(rest, '\a'); end >= 0 {
			return rest[:end], true
		}
		if end := strings.Index(rest, "\x1b\\"); end >= 0 {
			return rest[:end], true
		}
	}
	return "", false
}

func (t *Terminal) ingest(chunk []byte) {
	t.mu.Lock()
	t.ring.Write(chunk)
	t.mode.Feed(chunk)
	var titleChanged string
	var titleNotice bool
	if title, ok := oscTitle(chunk); ok && title != t.title {
		t.title = title
		titleChanged, titleNotice = title, true
	}
	vs := make([]*viewer, 0, len(t.viewers))
	for _, v := range t.viewers {
		vs = append(vs, v)
	}
	t.mu.Unlock()
	if titleNotice && t.onNotice != nil {
		t.onNotice(t.ID, Notice{Kind: "terminal.title", Title: titleChanged})
	}
	for _, v := range vs {
		t.flushViewer(v)
	}
}

// flushViewer sends as much ring content to v as its credit allows, chunked
// to MaxOutputFrame, starting from wherever v last left off.
func (t *Terminal) flushViewer(v *viewer) {
	for {
		ringStart, ringTotal := t.ring.Bounds()
		t.mu.Lock()
		sentUpTo := v.sentUpTo
		if sentUpTo < uint64(ringStart) {
			sentUpTo = uint64(ringStart) // data fell out from under a slow viewer; skip ahead silently
		}
		avail := int64(v.acked) + CreditWindow - int64(sentUpTo)
		if avail <= 0 || int64(sentUpTo) >= ringTotal {
			v.sentUpTo = sentUpTo
			t.mu.Unlock()
			return
		}
		end := ringTotal
		if end-int64(sentUpTo) > avail {
			end = int64(sentUpTo) + avail
		}
		if end-int64(sentUpTo) > MaxOutputFrame {
			end = int64(sentUpTo) + MaxOutputFrame
		}
		data, _ := t.ring.Read(int64(sentUpTo))
		chunk := data[:end-int64(sentUpTo)]
		startOffset := sentUpTo
		v.sentUpTo = uint64(end)
		t.mu.Unlock()
		if t.onOutput != nil {
			t.onOutput(t.ID, v.channel, startOffset, chunk)
		}
	}
}

// Attach registers channel as a viewer starting at from (nil = "no offset
// given", which is always a reset per PROTOCOL.md §9.3), and returns the
// snapshot the wire's terminal.attach result carries. Existing ring content
// from the effective offset is delivered asynchronously afterward as
// ordinary term.output frames, exactly like live output.
func (t *Terminal) Attach(channel string, from *int64) (effectiveFrom int64, reset bool, prelude []byte, snap Snapshot) {
	ringStart, ringTotal := t.ring.Bounds()
	t.mu.Lock()
	if t.state == StateExited {
		reset = true
	}
	requested := int64(0)
	if from != nil {
		requested = *from
	}
	effectiveFrom = requested
	if effectiveFrom < ringStart {
		effectiveFrom = ringStart
	}
	if effectiveFrom > ringTotal {
		effectiveFrom = ringTotal
	}
	if from == nil || requested < ringStart {
		reset = true
	}
	t.viewers[channel] = &viewer{channel: channel, acked: uint64(effectiveFrom), sentUpTo: uint64(effectiveFrom)}
	t.lastViewerAt = time.Now()
	v := t.viewers[channel]
	if reset {
		prelude = t.mode.Prelude()
	}
	snap = t.snapshotLocked()
	t.mu.Unlock()
	go t.flushViewer(v)
	return effectiveFrom, reset, prelude, snap
}

// Detach removes channel as a viewer.
func (t *Terminal) Detach(channel string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, ok := t.viewers[channel]; !ok {
		return ErrUnknownChannel
	}
	delete(t.viewers, channel)
	t.lastViewerAt = time.Now()
	return nil
}

// Ack records that channel has consumed output up to (excluding) upTo
// (PROTOCOL.md §9.2 term.ack), possibly unblocking the read loop and any
// backlog still owed to this viewer.
func (t *Terminal) Ack(channel string, upTo uint64) error {
	t.mu.Lock()
	v, ok := t.viewers[channel]
	if !ok {
		t.mu.Unlock()
		return ErrUnknownChannel
	}
	if upTo > v.acked {
		v.acked = upTo
	}
	t.mu.Unlock()
	t.flushViewer(v)
	return nil
}

// Resize changes the PTY's window size (PROTOCOL.md §9.3 terminal.resize,
// which carries no viewer identity of its own — Cerea decides which
// attached viewer's resize to forward and with what claim). claim=true
// (the default) always takes size ownership; claim=false is refused
// (applied=false) once anyone has claimed it, which is what lets a
// secondary, unfocused viewer ask without fighting the focused one.
func (t *Terminal) Resize(cols, rows int, claim bool) (applied bool, err error) {
	t.mu.Lock()
	if t.sizeClaimed && !claim {
		t.mu.Unlock()
		return false, nil
	}
	if claim {
		t.sizeClaimed = true
	}
	t.cols, t.rows = cols, rows
	t.mu.Unlock()
	if err := t.rsz.Resize(cols, rows); err != nil {
		return false, err
	}
	return true, nil
}

// Nudge resizes to rows-1 and back, prompting a full-screen program to
// repaint after a reset attach (PROTOCOL.md §9.3).
func (t *Terminal) Nudge() {
	t.mu.Lock()
	cols, rows := t.cols, t.rows
	t.mu.Unlock()
	if rows <= 1 {
		return
	}
	_ = t.rsz.Resize(cols, rows-1)
	_ = t.rsz.Resize(cols, rows)
}

// Rename sets the terminal's display title (terminal.rename).
func (t *Terminal) Rename(title string) {
	t.mu.Lock()
	t.title = title
	t.mu.Unlock()
}

// Write sends input to the shell (term.input, PROTOCOL.md §9.2).
func (t *Terminal) Write(p []byte) (int, error) {
	t.mu.Lock()
	closed := t.state == StateExited
	t.mu.Unlock()
	if closed {
		return 0, ErrClosed
	}
	return t.ptmx.Write(p)
}

// Close signals the process group: SIGHUP, then SIGKILL after 5s unless
// force asks for SIGKILL immediately (PROTOCOL.md §9.3 terminal.close, §9.2
// revoke teardown).
func (t *Terminal) Close(force bool) {
	t.closeOnce.Do(func() {
		if t.proc == nil {
			return
		}
		if force {
			_ = t.proc.Signal(SignalKILL)
			return
		}
		_ = t.proc.Signal(SignalHUP)
		go func() {
			select {
			case <-t.doneCh:
			case <-time.After(5 * time.Second):
				_ = t.proc.Signal(SignalKILL)
			}
		}()
	})
}

// Wait blocks until the terminal's process has exited (test/shutdown use).
func (t *Terminal) Wait(ctx context.Context) error {
	select {
	case <-t.doneCh:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ViewerCount reports how many channels are currently attached.
func (t *Terminal) ViewerCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.viewers)
}

// IdleSince is when the last viewer detached (or creation time, if none ever
// attached) — the clock IdleReapAfter measures against.
func (t *Terminal) IdleSince() time.Time {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.viewers) > 0 {
		return time.Time{}
	}
	return t.lastViewerAt
}

// ExitedAt is when the process exited, or the zero time while still running.
func (t *Terminal) ExitedAt() time.Time {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.exitedAt
}

// State reports whether the terminal's process is still running.
func (t *Terminal) State() State {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.state
}

func (t *Terminal) snapshotLocked() Snapshot {
	_, total := t.ring.Bounds()
	pid := 0
	if t.proc != nil {
		pid = t.proc.Pid()
	}
	return Snapshot{
		ID: t.ID, WorkspaceID: t.WorkspaceID, Title: t.title, Cwd: t.Cwd, Shell: t.Shell,
		Cols: t.cols, Rows: t.rows, PID: pid, CreatedAt: t.createdAt, State: t.state,
		ExitCode: t.exitCode, Signal: t.signal, Offset: total, Viewers: len(t.viewers),
	}
}

// Snapshot returns the wire's Terminal shape for this terminal right now.
func (t *Terminal) Snapshot() Snapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.snapshotLocked()
}

// RingContent returns everything the ring currently holds, from its start
// to its live edge — a test/debugging convenience for reading output
// without going through a viewer's credit-gated flush.
func (t *Terminal) RingContent() []byte {
	start, _ := t.ring.Bounds()
	data, _ := t.ring.Read(start)
	return data
}

// ResolveCwd validates rel (workspace-relative, PROTOCOL.md §9.1) and
// resolves it to an absolute path inside root, refusing anything that
// escapes: "..", an absolute path, or a symlink whose target resolves
// outside root. Confinement here picks the shell's starting directory; it
// is not a sandbox for what the shell does afterward (ADR 0090).
func ResolveCwd(root, rel string) (string, error) {
	clean, err := files.CleanRel(rel)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidCwd, err)
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return "", fmt.Errorf("%w: opening workspace root: %v", ErrInvalidCwd, err)
	}
	defer r.Close()
	info, err := r.Stat(clean)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidCwd, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%w: not a directory", ErrInvalidCwd)
	}
	return filepath.Join(root, filepath.FromSlash(clean)), nil
}
