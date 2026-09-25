//go:build !unix

package terminal

import "errors"

// Supported is false on non-Unix builds (PROTOCOL.md §9.3: "Unix only.
// There is no Windows build today."). hello.machine.capabilities.terminal
// follows this exactly.
const Supported = false

// OpenConfig mirrors spawn_unix.go's so callers compile either way.
type OpenConfig struct {
	ID            string
	WorkspaceID   string
	WorkspaceRoot string
	Cwd           string
	Cols, Rows    int
	Title         string
	OnOutput      OutputFunc
	OnNotice      NoticeFunc
}

// Open always fails on a build where Supported is false.
func Open(cfg OpenConfig) (*Terminal, error) {
	return nil, errors.New("terminal: not supported on this OS")
}
