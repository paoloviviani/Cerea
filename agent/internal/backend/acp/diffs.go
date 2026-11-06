package acp

import (
	"context"

	"galopin/internal/backend"
	"galopin/internal/filediff"
)

var _ backend.Differ = (*Backend)(nil)

// editKind reports whether the ACP tool kinds that change files.
func editKind(kind string) bool {
	switch kind {
	case "edit", "delete", "move":
		return true
	}
	return false
}

// toolCallPaths are the files an ACP tool call names: its locations, its raw
// input's path arguments, and the paths of its diff content items.
func toolCallPaths(toolCall map[string]any) []string {
	var paths []string
	for _, l := range asMaps(getSlice(toolCall, "locations")) {
		paths = append(paths, getStr(l, "path"))
	}
	if raw := getMap(toolCall, "rawInput"); raw != nil {
		paths = append(paths, filediff.InputPaths(raw)...)
	}
	for _, c := range asMaps(getSlice(toolCall, "content")) {
		if getStr(c, "type") == "diff" {
			paths = append(paths, getStr(c, "path"))
		}
	}
	return paths
}

// trackEdit feeds galopin's diff record from a tool_call, a tool_call_update
// or the toolCall of a permission request: an edit-class call that has not
// finished is snapshotted (the first sighting wins, and the ask comes before
// the tool runs); a finished call, whatever its update says about its kind, is
// compared. The agent's own diff content is not trusted for the result; the
// files are read.
func (b *Backend) trackEdit(sessionID, workspaceDir string, toolCall map[string]any) {
	toolCall = unwrapPiGate(toolCall)
	callID := getStr(toolCall, "toolCallId")
	if callID == "" {
		return
	}
	switch status := getStr(toolCall, "status"); status {
	case "completed", "failed":
		b.diffs.End(sessionID, callID)
	default:
		if editKind(inferKind(toolCall)) {
			b.diffs.Begin(sessionID, callID, workspaceDir, toolCallPaths(toolCall))
		}
	}
}

// Diff implements backend.Differ: the files this session's edit tool calls
// changed, from galopin's own before/after snapshots.
func (b *Backend) Diff(_ context.Context, _ string, sessionID string) ([]backend.FileDiff, error) {
	return b.diffs.Diffs(sessionID), nil
}
