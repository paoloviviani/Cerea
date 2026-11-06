package opencode

import (
	"os"
	"path/filepath"
	"testing"

	"galopin/internal/backend"
)

func toolPart(callID, tool, status string, input map[string]any) map[string]any {
	return map[string]any{
		"part": map[string]any{
			"id": "prt_" + callID, "messageID": "msg_1", "sessionID": "ses_1", "type": "tool",
			"callID": callID, "tool": tool,
			"state": map[string]any{"status": status, "input": input},
		},
	}
}

// opencode's tool parts feed galopin's own diff record, so an edit opencode
// has no diff for (a file outside what its snapshot tracks) still shows.
func TestEditToolPartsFeedOwnDiffs(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(a, []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	b := New(Config{})
	in := map[string]any{"filePath": a}
	b.translateEvent(dir, "message.part.updated", toolPart("c1", "edit", "running", in))
	b.translateEvent(dir, "message.part.updated", toolPart("c2", "read", "running", in)) // not edit-class
	if err := os.WriteFile(a, []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	b.translateEvent(dir, "message.part.updated", toolPart("c1", "edit", "completed", in))
	d := b.diffs.Diffs("ses_1")
	if len(d) != 1 || d[0].Path != "a.txt" || d[0].Before != "old\n" || d[0].After != "new\n" {
		t.Fatalf("own diffs = %+v", d)
	}
	// a snapshot that never finished is dropped when the turn ends
	b.translateEvent(dir, "message.part.updated", toolPart("c3", "write", "running", in))
	b.translateEvent(dir, "session.idle", map[string]any{"sessionID": "ses_1"})
	if n := len(b.diffs.Diffs("ses_1")); n != 1 {
		t.Errorf("diffs = %d after idle", n)
	}
}

// opencode's own diff wins: galopin's adds only the files opencode lacks.
func TestMergeOwnDiffsDoesNotDouble(t *testing.T) {
	theirs := []backend.FileDiff{{Path: "/ws/a.txt", Status: backend.FileModified, After: "theirs"}}
	ours := []backend.FileDiff{
		{Path: "a.txt", Status: backend.FileModified, After: "ours"},
		{Path: "b.txt", Status: backend.FileAdded, After: "b"},
	}
	got := mergeOwnDiffs("/ws", theirs, ours)
	if len(got) != 2 || got[0].After != "theirs" || got[1].Path != "b.txt" {
		t.Fatalf("merged = %+v", got)
	}
}
