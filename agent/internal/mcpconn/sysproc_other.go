//go:build !linux

package mcpconn

import (
	"os/exec"
	"syscall"
)

// setProcAttrs has no Pdeathsig outside Linux; a clean galopin exit still
// closes every channel.
func setProcAttrs(cmd *exec.Cmd) {}

func signalGroup(cmd *exec.Cmd, sig syscall.Signal) {
	if cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(sig)
}
