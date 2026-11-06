package opencode

import (
	"path/filepath"

	"galopin/internal/backend"
	"galopin/internal/filediff"
)

// trackEdit feeds galopin's own diff record (internal/filediff) from the tool
// parts opencode streams: the files an edit-class call names are snapshotted
// when the call is first seen pending or running, and compared when it
// completes or fails. The part event can race the tool's first write, so this
// is the fallback beside opencode's own session diff, not a replacement.
func (b *Backend) trackEdit(directory, sessionID string, p backend.Part) {
	if p.Type != backend.PartTool || p.CallID == "" || !filediff.EditTool(p.Tool) {
		return
	}
	switch p.ToolStatus {
	case backend.ToolPending, backend.ToolRunning:
		b.diffs.Begin(sessionID, p.CallID, directory, filediff.InputPaths(p.Input))
	case backend.ToolCompleted, backend.ToolFailed:
		b.diffs.End(sessionID, p.CallID)
	}
}

// mergeOwnDiffs keeps opencode's diffs and adds galopin's only for files
// opencode did not list, so one change is never shown twice.
func mergeOwnDiffs(workspaceDir string, theirs, ours []backend.FileDiff) []backend.FileDiff {
	have := map[string]bool{}
	for _, d := range theirs {
		have[absPath(workspaceDir, d.Path)] = true
	}
	for _, d := range ours {
		if !have[absPath(workspaceDir, d.Path)] {
			theirs = append(theirs, d)
		}
	}
	return theirs
}

func absPath(workspaceDir, p string) string {
	if !filepath.IsAbs(p) {
		p = filepath.Join(workspaceDir, p)
	}
	return filepath.Clean(p)
}
