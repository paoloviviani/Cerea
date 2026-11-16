//go:build unix

package main

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// lockInstance takes the exclusive "one galopin per pairing" lock: a
// non-blocking flock on <creds>.running (beside the credentials, not the
// file that lockCredsFile guards for the length of a refresh). The kernel
// drops it when the process exits however it exits, so a crash never leaves
// a stale lock; the PID written inside is only for the message a second
// process prints. Children do not inherit it (Go opens files close-on-exec).
//
// Two galopin processes sharing one credential rotate its refresh token
// against each other, and each failed refresh then hits the sign-in server
// again, which is how a deployment's rate limit gets exhausted.
func lockInstance(credsPath string) (unlock func(), err error) {
	lockPath := credsPath + ".running"
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("opening lock file %s: %w", lockPath, err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		holder := 0
		if raw, rerr := os.ReadFile(lockPath); rerr == nil {
			holder, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
		}
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, &alreadyRunningError{pid: holder}
		}
		return nil, fmt.Errorf("locking %s: %w", lockPath, err)
	}
	_ = f.Truncate(0)
	_, _ = f.WriteAt([]byte(strconv.Itoa(os.Getpid())+"\n"), 0)
	return func() {
		// The file stays: removing it would let a waiter lock the old inode
		// while a newcomer creates a new one.
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}
