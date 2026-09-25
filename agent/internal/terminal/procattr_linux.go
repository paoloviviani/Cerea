//go:build linux

package terminal

import "syscall"

// shellProcAttr makes the shell a session leader on its PTY (Setsid,
// Setctty) and asks the kernel to SIGHUP it if galopin dies, even on a
// hard crash (Pdeathsig, Linux only).
func shellProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true, Setctty: true, Pdeathsig: syscall.SIGHUP}
}
