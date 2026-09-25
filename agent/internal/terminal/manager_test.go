//go:build unix

package terminal

import (
	"context"
	"errors"
	"fmt"
	"syscall"
	"testing"
	"time"
)

func TestManagerMaxTerminals(t *testing.T) {
	if !Supported {
		t.Skip("terminals are not supported on this OS")
	}
	t.Setenv("TMPDIR", itTmpDir(t))
	root := t.TempDir()
	n := 0
	mgr := NewManager(func() (string, error) {
		n++
		return fmt.Sprintf("t%d", n), nil
	})
	for i := 0; i < 2; i++ {
		if _, err := mgr.Open(OpenConfig{WorkspaceID: "w", WorkspaceRoot: root, Cols: 80, Rows: 24}, 2); err != nil {
			t.Fatalf("Open %d: %v", i, err)
		}
	}
	if _, err := mgr.Open(OpenConfig{WorkspaceID: "w", WorkspaceRoot: root, Cols: 80, Rows: 24}, 2); !errors.Is(err, ErrTooMany) {
		t.Fatalf("expected ErrTooMany at the cap, got %v", err)
	}
	mgr.CloseAll(true)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := mgr.WaitAllClosed(ctx); err != nil {
		t.Fatalf("WaitAllClosed: %v", err)
	}
}

// TestManagerOpenExcludesExitedFromCount is the brief's roster requirement
// made concrete at the Manager level: a terminal kept only for
// ExitRetention display must not count against maxTerminals, or a user who
// exits every shell would be stuck unable to open a new one for 10 minutes.
func TestManagerOpenExcludesExitedFromCount(t *testing.T) {
	if !Supported {
		t.Skip("terminals are not supported on this OS")
	}
	t.Setenv("TMPDIR", itTmpDir(t))
	root := t.TempDir()
	mgr := NewManager(nil)
	defer func() {
		mgr.CloseAll(true)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = mgr.WaitAllClosed(ctx)
	}()

	term, err := mgr.Open(OpenConfig{WorkspaceID: "w", WorkspaceRoot: root, Cols: 80, Rows: 24}, 1)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, err := mgr.Open(OpenConfig{WorkspaceID: "w", WorkspaceRoot: root, Cols: 80, Rows: 24}, 1); !errors.Is(err, ErrTooMany) {
		t.Fatalf("expected ErrTooMany while the only terminal is running, got %v", err)
	}

	if _, err := term.Write([]byte("exit\n")); err != nil {
		t.Fatalf("Write exit: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && term.State() != StateExited {
		time.Sleep(20 * time.Millisecond)
	}
	if term.State() != StateExited {
		t.Fatal("terminal never reached the exited state")
	}

	if _, err := mgr.Open(OpenConfig{WorkspaceID: "w", WorkspaceRoot: root, Cols: 80, Rows: 24}, 1); err != nil {
		t.Fatalf("Open after the only terminal exited = %v, want success", err)
	}
}

// TestManagerRemoveDropsAnExitedTerminalImmediately: Remove is what
// terminal.close on an already-exited terminal uses (dispatch.go) to mean
// "gone for good" rather than "wait out ExitRetention" — proven directly
// against Manager here, end to end through the op in
// terminal_dispatch_test.go.
func TestManagerRemoveDropsAnExitedTerminalImmediately(t *testing.T) {
	if !Supported {
		t.Skip("terminals are not supported on this OS")
	}
	t.Setenv("TMPDIR", itTmpDir(t))
	root := t.TempDir()
	mgr := NewManager(nil)
	defer func() {
		mgr.CloseAll(true)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = mgr.WaitAllClosed(ctx)
	}()

	term, err := mgr.Open(OpenConfig{WorkspaceID: "w", WorkspaceRoot: root, Cols: 80, Rows: 24}, 8)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if err := mgr.Remove(term.ID); !errors.Is(err, ErrNotExited) {
		t.Fatalf("Remove on a running terminal = %v, want ErrNotExited", err)
	}

	if _, err := term.Write([]byte("exit\n")); err != nil {
		t.Fatalf("Write exit: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && term.State() != StateExited {
		time.Sleep(20 * time.Millisecond)
	}
	if term.State() != StateExited {
		t.Fatal("terminal never reached the exited state")
	}

	if err := mgr.Remove(term.ID); err != nil {
		t.Fatalf("Remove on an exited terminal: %v", err)
	}
	if _, err := mgr.Get(term.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after Remove = %v, want ErrNotFound", err)
	}
}

// pidAlive reports whether pid still exists (signal 0 is the standard
// existence probe: no signal is actually delivered).
func pidAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

// TestManagerCloseAllTerminatesProcessGroups is the brief's revoke-teardown
// requirement made concrete: closing every terminal (what run.go does on a
// 4403 revoke, and on ordinary shutdown) actually ends each shell process,
// not just this package's own bookkeeping. Each shell is its own session
// and process group leader (Setsid), so its own pid doubles as the group id
// CloseAll signals.
func TestManagerCloseAllTerminatesProcessGroups(t *testing.T) {
	if !Supported {
		t.Skip("terminals are not supported on this OS")
	}
	t.Setenv("TMPDIR", itTmpDir(t))
	root := t.TempDir()
	mgr := NewManager(nil)
	var pids []int
	for i := 0; i < 3; i++ {
		term, err := mgr.Open(OpenConfig{WorkspaceID: "w", WorkspaceRoot: root, Cols: 80, Rows: 24}, 10)
		if err != nil {
			t.Fatalf("Open %d: %v", i, err)
		}
		pid := term.Snapshot().PID
		if pid == 0 {
			t.Fatal("expected a real PID from a spawned shell")
		}
		if !pidAlive(pid) {
			t.Fatalf("shell %d should be alive right after Open", pid)
		}
		pids = append(pids, pid)
	}

	mgr.CloseAll(false)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := mgr.WaitAllClosed(ctx); err != nil {
		t.Fatalf("WaitAllClosed: %v", err)
	}
	// WaitAllClosed only guarantees the terminal's own Wait() returned; give
	// the kernel a brief moment to finish reaping before the liveness probe.
	deadline := time.Now().Add(2 * time.Second)
	for _, pid := range pids {
		for pidAlive(pid) && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if pidAlive(pid) {
			t.Errorf("shell process %d is still alive after CloseAll+WaitAllClosed", pid)
		}
	}
}
