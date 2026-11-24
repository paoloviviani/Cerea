//go:build windows

package main

import (
	"errors"
	"os"
)

// openNoFollow opens a file for reading, refusing a symlink (checked first: Windows has
// no O_NOFOLLOW; the caller still checks the opened file is a regular one).
func openNoFollow(p string) (*os.File, error) {
	if fi, err := os.Lstat(p); err != nil || fi.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("not a plain file")
	}
	return os.Open(p)
}
