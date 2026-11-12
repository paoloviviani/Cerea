package trayapp

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Timings of the quit and cleanup sequences (App.Sleep is faked in tests).
const (
	serviceExitWait = 5 * time.Second
	childTermGrace  = 3 * time.Second
	strayTermGrace  = 5 * time.Second
	pollEvery       = 200 * time.Millisecond
)

// ChildSet is the process groups of the commands the app started (pair,
// browser setup and enable, the dialogs, the log viewer). Each runs in its own
// process group, so its own children go with it.
type ChildSet struct {
	mu   sync.Mutex
	pids map[int]struct{}
}

func (c *ChildSet) Add(pid int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pids == nil {
		c.pids = map[int]struct{}{}
	}
	c.pids[pid] = struct{}{}
}

func (c *ChildSet) Remove(pid int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.pids, pid)
}

// PIDs are the leaders of the groups still running, in order.
func (c *ChildSet) PIDs() []int {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]int, 0, len(c.pids))
	for p := range c.pids {
		out = append(out, p)
	}
	sort.Ints(out)
	return out
}

func (c *ChildSet) has(pid int) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.pids[pid]
	return ok
}

// SysKill signals a process (pid > 0) or a whole process group (pid < 0).
func SysKill(pid int, sig syscall.Signal) error { return syscall.Kill(pid, sig) }

// SysAlive reports whether the process exists (a zombie counts as gone only
// once reaped; the app's own children are reaped by their Wait).
func SysAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

func (a *App) kill(pid int, sig syscall.Signal) {
	f := a.Kill
	if f == nil {
		f = SysKill
	}
	_ = f(pid, sig)
}

func (a *App) alive(pid int) bool {
	f := a.Alive
	if f == nil {
		f = SysAlive
	}
	return f(pid)
}

func (a *App) sleep(d time.Duration) {
	if a.Sleep != nil {
		a.Sleep(d)
		return
	}
	time.Sleep(d)
}

// terminate sends sig (to pid, or to its group when group is set), waits up to
// grace for the process to go, then sends SIGKILL the same way.
func (a *App) terminate(pid int, group bool, grace time.Duration) {
	target := pid
	if group {
		target = -pid
	}
	a.kill(target, syscall.SIGTERM)
	for waited := time.Duration(0); waited < grace; waited += pollEvery {
		if !a.alive(pid) {
			// The leader is gone; its group may not be: the last signal always goes.
			if group {
				a.kill(target, syscall.SIGKILL)
			}
			return
		}
		a.sleep(pollEvery)
	}
	a.kill(target, syscall.SIGKILL)
}

// Quit is "Quit Cerea connector": stop the service, wait for it to exit, stop
// every command the app started (the whole process group), and refuse to start
// anything more. The caller then exits.
func (a *App) Quit(ctx context.Context) {
	a.quitting.Store(true)
	_, _ = a.Run(ctx, "launchctl", LaunchctlBootout(a.UID), nil, nil)
	a.waitServiceGone(ctx)
	a.KillChildren()
}

// waitServiceGone polls launchctl print until the job is no longer loaded
// (bootout has finished and the process is gone), for up to serviceExitWait.
func (a *App) waitServiceGone(ctx context.Context) {
	for waited := time.Duration(0); waited < serviceExitWait; waited += pollEvery {
		if _, err := a.Run(ctx, "launchctl", LaunchctlPrint(a.UID), nil, nil); err != nil {
			return
		}
		a.sleep(pollEvery)
	}
}

// KillChildren stops every process group the app started: SIGTERM, then
// SIGKILL after a grace period.
func (a *App) KillChildren() {
	if a.Children == nil {
		return
	}
	pids := a.Children.PIDs()
	for _, p := range pids {
		a.kill(-p, syscall.SIGTERM)
	}
	for waited := time.Duration(0); waited < childTermGrace; waited += pollEvery {
		left := false
		for _, p := range pids {
			if a.alive(p) {
				left = true
			}
		}
		if !left {
			break
		}
		a.sleep(pollEvery)
	}
	for _, p := range pids {
		a.kill(-p, syscall.SIGKILL) // also takes a group that outlived its leader
	}
}

// Proc is one line of ps.
type Proc struct {
	PID, PPID int
	Command   string
}

// ParsePS reads `ps -o pid=,ppid=,command=` output.
func ParsePS(out string) []Proc {
	var ps []Proc
	for _, l := range strings.Split(out, "\n") {
		f := strings.Fields(l)
		if len(f) < 3 {
			continue
		}
		pid, e1 := strconv.Atoi(f[0])
		ppid, e2 := strconv.Atoi(f[1])
		if e1 != nil || e2 != nil {
			continue
		}
		cmd := strings.TrimSpace(l)
		cmd = strings.TrimSpace(strings.TrimPrefix(cmd, f[0]))
		cmd = strings.TrimSpace(strings.TrimPrefix(cmd, f[1]))
		ps = append(ps, Proc{pid, ppid, cmd})
	}
	return ps
}

// runCommand matches a command line that is `galopin run ...`: the program is
// named galopin (a path or bare) and its first argument is run. A command that
// merely mentions it (grep, tail, an editor) does not start that way.
var runCommand = regexp.MustCompile(`^(?:/.*/)?galopin run(?: |$)`)

// IsGalopinRun reports whether a ps command line is a galopin service process.
func IsGalopinRun(command string) bool { return runCommand.MatchString(command) }

var launchdPID = regexp.MustCompile(`(?m)^\s*pid = (\d+)\s*$`)

// ServicePID is the pid launchd reports for the service in `launchctl print`
// output (0 when it has none).
func ServicePID(printOut string) int {
	m := launchdPID.FindStringSubmatch(printOut)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

func (a *App) listProcs(ctx context.Context) []Proc {
	out, err := a.Run(ctx, "ps", []string{"-U", strconv.Itoa(a.UID), "-o", "pid=,ppid=,command="}, nil, nil)
	if err != nil && out == "" {
		return nil
	}
	return ParsePS(out)
}

// excluded: the app itself, its children, and the service launchd manages.
func (a *App) excluded(p Proc, servicePID int) bool {
	self := a.Self
	if self == 0 {
		self = os.Getpid()
	}
	return p.PID == self || p.PPID == self || p.PID == servicePID || (a.Children != nil && a.Children.has(p.PID))
}

// FindStrays are the `galopin run` processes of this user that launchd does
// not manage: a manual run, an old install, a crash leftover.
func (a *App) FindStrays(ctx context.Context) []Proc {
	servicePID := 0
	if out, err := a.Run(ctx, "launchctl", LaunchctlPrint(a.UID), nil, nil); err == nil {
		servicePID = ServicePID(out)
	}
	var strays []Proc
	for _, p := range a.listProcs(ctx) {
		if IsGalopinRun(p.Command) && !a.excluded(p, servicePID) {
			strays = append(strays, p)
		}
	}
	return strays
}

// StrayPrompt is the dialog text.
func StrayPrompt(pid int) string {
	return fmt.Sprintf("Another Cerea connector process is running (pid %d). Stop it?", pid)
}

// StopDecision reads osascript's answer to the stray dialog. Stop is the
// default: only an explicit Leave (or a dialog that failed) leaves it running.
func StopDecision(out string, err error) bool {
	if err != nil {
		return false
	}
	return !strings.Contains(out, "button returned:Leave")
}

// AskStopStray shows the Stop / Leave dialog and reports whether to stop.
func (a *App) AskStopStray(ctx context.Context, pid int) bool {
	script := `display dialog ` + AppleScriptQuote(StrayPrompt(pid)) + ` with title ` + AppleScriptQuote(AppName) +
		` buttons {"Leave", "Stop"} default button "Stop"`
	out, err := a.Run(ctx, "osascript", []string{"-e", script}, nil, nil)
	return StopDecision(out, err)
}

// StopStrays offers to stop each stray `galopin run` and stops the ones the
// user agrees to (SIGTERM, SIGKILL after a grace period). It returns the pids
// it stopped.
func (a *App) StopStrays(ctx context.Context) []int {
	var stopped []int
	for _, p := range a.FindStrays(ctx) {
		if a.AskStopStray(ctx, p.PID) {
			a.terminate(p.PID, false, strayTermGrace)
			stopped = append(stopped, p.PID)
		}
	}
	return stopped
}

// BrowserProfile is galopin's own browser profile directory.
func (p Paths) BrowserProfile() string {
	return filepath.Join(p.StateDir(), "browser", "profile")
}

// profileMatch: the command line names the profile directory as a whole path
// (followed by a space, a slash or the end), not a longer sibling.
func profileMatch(command, profile string) bool {
	for i := 0; ; {
		j := strings.Index(command[i:], profile)
		if j < 0 {
			return false
		}
		end := i + j + len(profile)
		if end == len(command) || command[end] == ' ' || command[end] == '/' {
			return true
		}
		i = end
	}
}

// StopOrphanBrowsers stops browser runtime and Chrome processes started with
// galopin's own profile, but only when no galopin service is running (one that
// runs owns them). It returns the pids it stopped.
func (a *App) StopOrphanBrowsers(ctx context.Context) []int {
	if out, err := a.Run(ctx, "launchctl", LaunchctlPrint(a.UID), nil, nil); err == nil && ServicePID(out) != 0 {
		return nil
	}
	procs := a.listProcs(ctx)
	for _, p := range procs {
		if IsGalopinRun(p.Command) && !a.excluded(p, 0) {
			return nil // a stray service is up (and may own them): decide that first
		}
	}
	var stopped []int
	profile := a.Paths.BrowserProfile()
	for _, p := range procs {
		if profileMatch(p.Command, profile) && !a.excluded(p, 0) {
			a.kill(p.PID, syscall.SIGTERM)
			stopped = append(stopped, p.PID)
		}
	}
	if len(stopped) > 0 {
		for waited := time.Duration(0); waited < strayTermGrace; waited += pollEvery {
			left := false
			for _, p := range stopped {
				if a.alive(p) {
					left = true
				}
			}
			if !left {
				return stopped
			}
			a.sleep(pollEvery)
		}
		for _, p := range stopped {
			if a.alive(p) {
				a.kill(p, syscall.SIGKILL)
			}
		}
	}
	return stopped
}
