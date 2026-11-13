//go:build unix

package procreap

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"testing"
	"time"
)

func startSleeper(t *testing.T) *exec.Cmd {
	t.Helper()
	cmd := exec.Command("sleep", "60")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go cmd.Wait()
	t.Cleanup(func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) })
	return cmd
}

func setup(t *testing.T) {
	t.Helper()
	oldEnabled, oldExe, oldGrace := enabled, exeOf, grace
	enabled, grace = true, time.Second
	self = func() int { return 2147483001 } // a galopin that has since died
	dir = t.TempDir()
	t.Cleanup(func() { enabled, exeOf, grace, dir, self = oldEnabled, oldExe, oldGrace, "", os.Getpid })
}

func gone(pid int) bool {
	for i := 0; i < 50; i++ {
		if syscall.Kill(pid, 0) != nil {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

func TestReapStopsRecordedGroup(t *testing.T) {
	setup(t)
	cmd := startSleeper(t)
	exeOf = func(int) string { return cmd.Path }
	Track(cmd)
	if got := Init(dir); len(got) != 1 || got[0] != cmd.Process.Pid {
		t.Fatalf("stopped %v", got)
	}
	if !gone(cmd.Process.Pid) {
		t.Fatal("child still running")
	}
	if len(entries()) != 0 {
		t.Fatal("record not cleared")
	}
}

func TestReapSkipsReusedPid(t *testing.T) {
	setup(t)
	cmd := startSleeper(t)
	exeOf = func(int) string { return "/usr/bin/other" }
	Track(cmd)
	if got := Init(dir); len(got) != 0 {
		t.Fatalf("stopped %v", got)
	}
	if syscall.Kill(cmd.Process.Pid, 0) != nil {
		t.Fatal("a different program must be left alone")
	}
}

func TestSameProgram(t *testing.T) {
	for _, c := range []struct {
		rec, got string
		want     bool
	}{
		{"/bin/sleep", "/bin/sleep", true},
		{"/bin/sleep", "sleep", true},
		{"/bin/sleep", "/usr/bin/sleep", false},
		{"/bin/sleep", "", false},
		{"", "sleep", false},
	} {
		if sameProgram(c.rec, c.got) != c.want {
			t.Errorf("%+v", c)
		}
	}
}

func TestTrackDropsDeadEntries(t *testing.T) {
	setup(t)
	write([]entry{{owner: 1, pid: 2147483000, exe: "/x"}})
	cmd := startSleeper(t)
	Track(cmd)
	es := entries()
	if len(es) != 1 || es[0].pid != cmd.Process.Pid {
		t.Fatalf("%v (pid %s)", es, strconv.Itoa(cmd.Process.Pid))
	}
}

func TestReapLeavesGroupsOfALiveGalopin(t *testing.T) {
	setup(t)
	cmd := startSleeper(t)
	exeOf = func(int) string { return cmd.Path }
	Track(cmd)
	self = os.Getpid // a different galopin runs now; the recorder was the dead one
	write([]entry{{owner: os.Getppid(), pid: cmd.Process.Pid, exe: cmd.Path}})
	if got := Init(dir); len(got) != 0 {
		t.Fatalf("stopped %v", got)
	}
	if len(entries()) != 1 {
		t.Fatal("the live galopin's record must stay")
	}
}
