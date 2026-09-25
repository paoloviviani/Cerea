//go:build !unix

package files

import (
	"fmt"
	"io/fs"
)

func revisionOf(info fs.FileInfo) string {
	return fmt.Sprintf("0:0:%d:%d", info.Size(), info.ModTime().UnixNano())
}
