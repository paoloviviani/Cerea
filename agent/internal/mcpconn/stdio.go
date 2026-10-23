package mcpconn

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"galopin/internal/terminal"
)

// stdioConn is one server process, one channel (PROTOCOL.md §10.6).
type stdioConn struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	sink    *sink
	closing atomic.Bool
	done    chan struct{}

	mu      sync.Mutex
	lastErr string

	reason, detail string // how it ended; valid once done is closed
	status         string // the exit status alone, no stderr; valid once done is closed
}

// startStdio starts the entry's process. Newline-delimited JSON-RPC goes over
// its stdin and stdout; its stderr goes to galopin's log, never over the link.
func startStdio(e *Entry, s *sink) (*stdioConn, error) {
	cmd := exec.Command(e.Command, e.Args...)
	// The environment minus galopin's and opencode's own secrets, plus the
	// entry's env (which is where a server's own secrets live).
	env := terminal.ScrubEnv(os.Environ())
	for k, v := range e.Env {
		env = append(env, k+"="+v)
	}
	cmd.Env = env
	cmd.Dir = e.Cwd
	setProcAttrs(cmd)
	c := &stdioConn{cmd: cmd, sink: s, done: make(chan struct{})}
	out := &lineSplitter{limit: maxReadBytes, fn: func(line []byte) { s.message(append([]byte(nil), line...)) }}
	errw := &lineSplitter{limit: 4096, fn: func(line []byte) {
		text := strings.TrimSpace(string(line))
		c.mu.Lock()
		c.lastErr = text
		c.mu.Unlock()
		s.logf("connector %s: %s", e.Name, text)
	}}
	cmd.Stdout = out
	cmd.Stderr = errw
	// A grandchild that keeps the pipes open must not keep Wait from returning.
	cmd.WaitDelay = time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	c.stdin = stdin
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go func() {
		err := cmd.Wait()
		out.flush()
		errw.flush()
		if out.dropped > 0 {
			s.logf("connector %s: dropped %d message(s) over %d bytes", e.Name, out.dropped, maxReadBytes)
		}
		// Recorded before Done closes, so an open that sees the process gone
		// can say why.
		c.reason, c.detail = c.exitReason(err)
		c.status = "exit status 0"
		if err != nil {
			c.status = err.Error()
		}
		close(c.done)
		if c.closing.Load() {
			return
		}
		s.closed(c.reason, c.detail)
	}()
	return c, nil
}

// LastStderr is the last line the process wrote to stderr.
func (c *stdioConn) LastStderr() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastErr
}

func (c *stdioConn) exitReason(err error) (reason, detail string) {
	status := "exit status 0"
	reason = "exited"
	if err != nil {
		status = err.Error()
		var ee *exec.ExitError
		if !errors.As(err, &ee) || ee.ExitCode() != 0 {
			reason = "crashed"
		}
	}
	if last := c.LastStderr(); last != "" {
		status += ": " + last
	}
	return reason, status
}

func (c *stdioConn) Send(msg []byte) {
	// One message per line: whitespace between tokens may hold newlines.
	line, err := compactJSON(msg)
	if err != nil {
		c.sink.logf("connector: dropping a message that is not JSON")
		return
	}
	if _, err := c.stdin.Write(append(line, '\n')); err != nil && !c.closing.Load() {
		c.sink.logf("connector: writing to the server failed: %v", err)
	}
}

// Pid is the server process's id.
func (c *stdioConn) Pid() int { return c.cmd.Process.Pid }

// ExitStatus is how the process ended, without anything it wrote; valid once Done is closed.
func (c *stdioConn) ExitStatus() string { return c.status }

// Exit is how the process ended; valid once Done is closed.
func (c *stdioConn) Exit() (reason, detail string) { return c.reason, c.detail }

func (c *stdioConn) Done() <-chan struct{} { return c.done }

// Close closes stdin, then asks the process group to stop (SIGTERM), then
// kills it after two seconds.
func (c *stdioConn) Close() {
	if !c.closing.CompareAndSwap(false, true) {
		return
	}
	_ = c.stdin.Close()
	go func() {
		select {
		case <-c.done:
			return
		case <-time.After(300 * time.Millisecond):
		}
		signalGroup(c.cmd, syscall.SIGTERM)
		select {
		case <-c.done:
		case <-time.After(2 * time.Second):
		}
		// The group may outlive its leader: always send the last signal.
		signalGroup(c.cmd, syscall.SIGKILL)
	}()
}

func compactJSON(b []byte) ([]byte, error) {
	var buf bytes.Buffer
	if err := json.Compact(&buf, b); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
