//go:build unix

// Package procreap cleans up after a galopin that was killed without a chance
// to stop its children. On Linux the kernel does it (Pdeathsig); on macOS the
// children (opencode, connector servers, the browser runtime and Chrome) lead
// their own process groups with nothing tying them to galopin, so a crash or
// SIGKILL leaves them running and launchd then starts a second galopin beside
// them. galopin records each child group here and, on the next start, stops the
// groups whose leader is still alive and still the same program.
package procreap

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const fileName = "children.pids"

var (
	mu      sync.Mutex
	dir     string
	enabled = !linuxPdeathsig
	// Seams for tests.
	exeOf = psExe
	grace = 3 * time.Second
	sleep = time.Sleep
	kill  = syscall.Kill
	self  = os.Getpid
)

// entry is a recorded child group: the galopin that started it (owner), the
// leader pid and its program.
type entry struct {
	owner, pid int
	exe        string
}

// Init sets the state directory and stops the leftovers of a previous run. It
// returns the pids it stopped. It does nothing on Linux.
func Init(stateDir string) []int {
	mu.Lock()
	dir = stateDir
	mu.Unlock()
	if !enabled {
		return nil
	}
	return reap()
}

// Track records a started child (which must lead its own group: Setpgid).
func Track(cmd *exec.Cmd) {
	if !enabled || cmd == nil || cmd.Process == nil {
		return
	}
	mu.Lock()
	defer mu.Unlock()
	if dir == "" {
		return
	}
	live := entries()[:0:0]
	for _, e := range entries() {
		if kill(e.pid, 0) == nil {
			live = append(live, e)
		}
	}
	write(append(live, entry{self(), cmd.Process.Pid, cmd.Path}))
}

func path() string { return filepath.Join(dir, fileName) }

func entries() []entry {
	f, err := os.Open(path())
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []entry
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		f := strings.SplitN(sc.Text(), " ", 3)
		if len(f) != 3 {
			continue
		}
		owner, e1 := strconv.Atoi(f[0])
		pid, e2 := strconv.Atoi(f[1])
		if e1 == nil && e2 == nil && pid > 1 {
			out = append(out, entry{owner, pid, f[2]})
		}
	}
	return out
}

func write(es []entry) {
	var b strings.Builder
	for _, e := range es {
		fmt.Fprintf(&b, "%d %d %s\n", e.owner, e.pid, e.exe)
	}
	_ = os.WriteFile(path(), []byte(b.String()), 0o600)
}

func reap() []int {
	mu.Lock()
	defer mu.Unlock()
	var stopped, keep = []int(nil), []entry(nil)
	for _, e := range entries() {
		// Its galopin still runs (a second `galopin run` on this state
		// directory): the group is not a leftover.
		if e.owner != self() && kill(e.owner, 0) == nil {
			keep = append(keep, e)
			continue
		}
		if kill(e.pid, 0) != nil || !sameProgram(e.exe, exeOf(e.pid)) {
			continue
		}
		_ = kill(-e.pid, syscall.SIGTERM)
		stopped = append(stopped, e.pid)
	}
	write(keep)
	if len(stopped) == 0 {
		return nil
	}
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		alive := false
		for _, p := range stopped {
			alive = alive || kill(p, 0) == nil
		}
		if !alive {
			return stopped
		}
		sleep(100 * time.Millisecond)
	}
	for _, p := range stopped {
		_ = kill(-p, syscall.SIGKILL)
	}
	return stopped
}

// sameProgram: the process now running under the pid is the one recorded (a
// reused pid belongs to something else). ps may give a bare name, not a path.
func sameProgram(recorded, got string) bool {
	if recorded == "" || got == "" {
		return false
	}
	return recorded == got || (!filepath.IsAbs(got) && filepath.Base(recorded) == got)
}

func psExe(pid int) string {
	out, err := exec.Command("ps", "-o", "comm=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
