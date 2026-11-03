//go:build unix

package files

import (
	"os"

	"golang.org/x/sys/unix"
)

// renameIn renames from to to inside dir, through the directory's own file
// descriptor (renameat): the rename lands in the directory the write
// resolved through the workspace root, whatever its path points at by now.
func renameIn(dir *os.Root, from, to string) error {
	d, err := dir.Open(".")
	if err != nil {
		return err
	}
	defer d.Close()
	fd := int(d.Fd())
	if err := unix.Renameat(fd, from, fd, to); err != nil {
		return &os.LinkError{Op: "renameat", Old: from, New: to, Err: err}
	}
	return nil
}
