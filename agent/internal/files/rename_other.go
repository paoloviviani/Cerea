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
