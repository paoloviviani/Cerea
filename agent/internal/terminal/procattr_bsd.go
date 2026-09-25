//go:build unix && !linux

package terminal

import "syscall"

// shellProcAttr makes the shell a session leader on its PTY. There is no
// Pdeathsig outside Linux: a shell outlives a galopin that crashed hard
// (a clean exit still closes every terminal, run.go), and it loses its
// terminal when the PTY master closes with the dead process.
func shellProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true, Setctty: true}
}
