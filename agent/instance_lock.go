package main

import "fmt"

// alreadyRunningError is lockInstance's refusal: another galopin holds this
// pairing. pid is 0 when the holder's PID could not be read.
type alreadyRunningError struct{ pid int }

func (e *alreadyRunningError) Error() string {
	who := ""
	if e.pid > 0 {
		who = fmt.Sprintf(" (PID %d)", e.pid)
	}
	return "another galopin is already running with this pairing" + who +
		". Stop it first (systemctl --user stop galopin on Linux, or quit the Mac app or " +
		"'launchctl bootout gui/$(id -u)/org.cerea.galopin'), or check what runs it with " +
		"'systemctl --user status galopin'"
}

// lockInstanceFor takes the one-galopin-per-pairing lock and wraps a refusal
// with what the command was about to do.
func lockInstanceFor(credsPath, what string) (func(), error) {
	unlock, err := lockInstance(credsPath)
	if err != nil {
		if _, ok := err.(*alreadyRunningError); ok && what != "" {
			return nil, fmt.Errorf("cannot %s: %w", what, err)
		}
		return nil, err
	}
	return unlock, nil
}
