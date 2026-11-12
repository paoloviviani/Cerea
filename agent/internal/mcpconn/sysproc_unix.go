//go:build unix && !linux

package mcpconn

import (
	"os/exec"
	"syscall"
)

// setProcAttrs puts the child in its own process group (macOS and the other
// unixes have no Pdeathsig), so signalGroup reaches everything it started: a
// clean exit of galopin still closes every child, with no leftovers.
func setProcAttrs(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

// signalGroup signals the process group the child leads (negative pid).
func signalGroup(cmd *exec.Cmd, sig syscall.Signal) {
	if cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, sig)
}
