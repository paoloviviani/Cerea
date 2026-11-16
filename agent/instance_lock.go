package main

import (
	"errors"
	"fmt"
	"time"
)

// alreadyRunningError is lockInstance's refusal: another galopin holds this
// pairing. pid is 0 when the holder's PID could not be read.
type alreadyRunningError struct{ pid int }

func (e *alreadyRunningError) Error() string {
	who := ""
	if e.pid > 0 {
		who = fmt.Sprintf(" (PID %d)", e.pid)
	}
	return "another galopin is already running with this pairing" + who +
		". Stop it first (Ctrl-C in its terminal, or 'galopin service uninstall' if it runs as a service), " +
		"or use 'galopin service status' to see what runs it"
}

// instanceLockGrace is how long run and serve wait for a previous galopin to
// let go: a service restart (systemctl restart, launchctl kickstart -k, the
// Mac app) starts the new process right behind the old one's exit, and a
// shutdown that is still closing connections must not make the new start fail.
// enroll does not wait: it refuses at once.
const instanceLockGrace = 5 * time.Second

// lockInstanceFor takes the one-galopin-per-pairing lock, waiting up to wait
// for a holder that is on its way out, and wraps a refusal with what the
// command was about to do.
func lockInstanceFor(credsPath, what string, wait time.Duration) (func(), error) {
	deadline := time.Now().Add(wait)
	for {
		unlock, err := lockInstance(credsPath)
		if err == nil {
			return unlock, nil
		}
		var busy *alreadyRunningError
		if !errors.As(err, &busy) {
			return nil, err
		}
		if time.Now().Before(deadline) {
			time.Sleep(100 * time.Millisecond)
			continue
		}
		if what != "" {
			return nil, fmt.Errorf("cannot %s: %w", what, err)
		}
		return nil, err
	}
}
