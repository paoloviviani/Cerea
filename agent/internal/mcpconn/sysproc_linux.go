//go:build linux

package mcpconn

import (
	"os/exec"
	"syscall"
)

// setProcAttrs puts a server in its own process group and asks the kernel to
// SIGKILL it the moment galopin dies, however it dies (the way opencode's
// supervisor does it).
func setProcAttrs(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}

func signalGroup(cmd *exec.Cmd, sig syscall.Signal) {
	if cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, sig)
}
