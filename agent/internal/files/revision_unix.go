//go:build unix

package files

import (
	"fmt"
	"io/fs"
	"syscall"
)

// revisionOf is dev:ino:size:mtimeNs: it changes on any rewrite, including
// one that keeps the size and a coarse mtime.
func revisionOf(info fs.FileInfo) string {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return fmt.Sprintf("%d:%d:%d:%d", st.Dev, st.Ino, info.Size(), info.ModTime().UnixNano())
	}
	return fmt.Sprintf("0:0:%d:%d", info.Size(), info.ModTime().UnixNano())
}
