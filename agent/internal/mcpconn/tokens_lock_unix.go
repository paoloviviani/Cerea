//go:build unix

package mcpconn

import (
	"os"
	"syscall"
)

// lockFile takes an exclusive advisory lock on path and blocks until it is
// held. A token refresh in one galopin process (run, a launch's connectors) must
// not race one in another: both would present the same refresh token and one
// would lose the rotated pair.
func lockFile(path string) (unlock func(), err error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		_ = f.Close()
		return nil, err
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}
