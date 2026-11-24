//go:build !windows

package main

import (
	"os"
	"syscall"
)

// openNoFollow opens a file for reading, refusing a symlink at the last path element.
func openNoFollow(p string) (*os.File, error) {
	return os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
}
