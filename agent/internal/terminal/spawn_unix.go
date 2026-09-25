//go:build unix

package terminal

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
)

// Supported reports whether this build can spawn terminals: PROTOCOL.md
// §9.3's Unix-only rule, surfaced as hello.machine.capabilities.terminal.
const Supported = true

// cmdProcess adapts *exec.Cmd (already Wait()-ed exactly once, by
// newTerminal's own goroutine) to the process interface.
type cmdProcess struct{ cmd *exec.Cmd }

func (p *cmdProcess) Wait() error { return p.cmd.Wait() }
func (p *cmdProcess) Pid() int {
	if p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}

// Signal delivers sig to the whole process group (negative pid), reaching
// anything the shell itself spawned — the same discipline
// internal/backend/opencode's supervisor uses for opencode's own group.
func (p *cmdProcess) Signal(sig Signal) error {
	if p.cmd.Process == nil {
		return nil
	}
	sysSig := syscall.SIGHUP
	if sig == SignalKILL {
		sysSig = syscall.SIGKILL
	}
	err := syscall.Kill(-p.cmd.Process.Pid, sysSig)
	if errors.Is(err, syscall.ESRCH) {
		return nil // already gone
	}
	return err
}

type ptyResizer struct{ f *os.File }

func (r *ptyResizer) Resize(cols, rows int) error {
	return pty.Setsize(r.f, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

// loginShell picks $SHELL -l, falling back to /bin/sh (PROTOCOL.md §9.3).
func loginShell() string {
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	return "/bin/sh"
}

// OpenConfig is everything Open needs to spawn one terminal.
type OpenConfig struct {
	ID            string
	WorkspaceID   string
	WorkspaceRoot string // absolute path; cwd resolves inside it (PROTOCOL.md §9.1)
	Cwd           string // workspace-relative; "" = the root
	Cols, Rows    int
	Title         string
	OnOutput      OutputFunc
	OnNotice      NoticeFunc
}

// Open spawns a real PTY-backed login shell (PROTOCOL.md §9.3 "Terminal
// process rules"): Setsid/Setctty via creack/pty.StartWithSize,
// Pdeathsig=SIGHUP on Linux so an orphaned shell dies with this process
// even on a hard crash (procattr_*.go), TERM/COLORTERM/GALOPIN_TERMINAL set, and every other
// galopin/opencode secret scrubbed from the environment (env.go).
func Open(cfg OpenConfig) (*Terminal, error) {
	absCwd, err := ResolveCwd(cfg.WorkspaceRoot, cfg.Cwd)
	if err != nil {
		return nil, err
	}
	shell := loginShell()
	cmd := exec.Command(shell, "-l")
	cmd.Dir = absCwd
	cmd.Env = append(ScrubEnv(os.Environ()),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"GALOPIN_TERMINAL=1",
	)
	cmd.SysProcAttr = shellProcAttr()
	cols, rows := cfg.Cols, cfg.Rows
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, fmt.Errorf("terminal: starting %s: %w", shell, err)
	}
	rel, _ := cleanCwdForDisplay(cfg.Cwd)
	t := newTerminal(cfg.ID, cfg.WorkspaceID, rel, shell, cols, rows, f, &ptyResizer{f}, &cmdProcess{cmd}, cfg.OnOutput, cfg.OnNotice)
	t.Rename(cfg.Title)
	return t, nil
}

func cleanCwdForDisplay(cwd string) (string, error) {
	if cwd == "" {
		return ".", nil
	}
	return cwd, nil
}
