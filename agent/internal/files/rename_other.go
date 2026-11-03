//go:build !unix

package files

import (
	"os"
	"path/filepath"
)

// renameIn renames from to to inside dir. Without renameat this goes by path,
// which a directory swapped mid-write could redirect; galopin ships for unix.
func renameIn(dir *os.Root, from, to string) error {
	return os.Rename(filepath.Join(dir.Name(), from), filepath.Join(dir.Name(), to))
}

// createIn puts `from` in place as `to` only if `to` does not exist: a hard link
// fails when a file appeared meanwhile, where a rename would replace it.
func createIn(dir *os.Root, from, to string) error {
	if err := os.Link(filepath.Join(dir.Name(), from), filepath.Join(dir.Name(), to)); err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(dir.Name(), from))
	return nil
}
