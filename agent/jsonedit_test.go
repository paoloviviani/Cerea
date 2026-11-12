package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const userFile = `{
  "mcpServers": {
    "zeta":  { "command": "z", "args": ["a",   "b"] },
    "alpha": {"command":"a"}
  },
  "theme": "dark",
  "extra": [1,
    2]
}
`

func edit(t *testing.T, path, name, value string) bool {
	t.Helper()
	var v []byte
	if value != "" {
		v = []byte(value)
	}
	changed, err := editMcpServers(path, name, v)
	if err != nil {
		t.Fatal(err)
	}
	return changed
}

func TestEditAddsOneMemberAndKeepsTheUsersFormattingAndOrder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp.json")
	if err := os.WriteFile(path, []byte(userFile), 0o640); err != nil {
		t.Fatal(err)
	}
	if !edit(t, path, "cerea-browser", `{"command":"node","args":["x"]}`) {
		t.Fatal("no change")
	}
	got, _ := os.ReadFile(path)
	if !json.Valid(got) {
		t.Fatalf("invalid: %s", got)
	}
	// Everything before the insertion point and after it is the user's bytes.
	want := strings.Replace(userFile, `"command":"a"}`, `"command":"a"},`, 1)
	if !strings.HasPrefix(string(got), want[:strings.Index(want, "\n  },\n  \"theme\"")]) {
		t.Errorf("the user's servers were reformatted:\n%s", got)
	}
	if !strings.HasSuffix(string(got), "\n  },\n  \"theme\": \"dark\",\n  \"extra\": [1,\n    2]\n}\n") {
		t.Errorf("the rest of the file was reformatted:\n%s", got)
	}
	if !strings.Contains(string(got), "\n    \"cerea-browser\": {\n      \"command\": \"node\",") {
		t.Errorf("the new member does not use the file's two-space indentation:\n%s", got)
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o640 {
		t.Errorf("mode %v", st.Mode())
	}
	// Same value again: nothing is rewritten.
	if edit(t, path, "cerea-browser", `{"command":"node","args":["x"]}`) {
		t.Error("an identical entry was rewritten")
	}
	// Changed value: replaced in place.
	if !edit(t, path, "cerea-browser", `{"command":"node","args":["y"]}`) {
		t.Error("a changed entry was not rewritten")
	}
	got, _ = os.ReadFile(path)
	if strings.Count(string(got), "cerea-browser") != 1 || !strings.Contains(string(got), `"y"`) {
		t.Errorf("%s", got)
	}
	// Removing it gives the user's file back, byte for byte.
	if !edit(t, path, "cerea-browser", "") {
		t.Fatal("not removed")
	}
	back, _ := os.ReadFile(path)
	if string(back) != userFile {
		t.Errorf("removal did not restore the file:\n%s\nwanted\n%s", back, userFile)
	}
	if edit(t, path, "cerea-browser", "") {
		t.Error("removing an absent entry changed the file")
	}
}

func TestEditRemovalOfFirstAndOnlyMembers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp.json")
	_ = os.WriteFile(path, []byte("{\n\t\"mcpServers\": {\n\t\t\"a\": {\"command\": \"a\"},\n\t\t\"b\": {\"command\": \"b\"}\n\t}\n}\n"), 0o600)
	edit(t, path, "a", "")
	got, _ := os.ReadFile(path)
	if string(got) != "{\n\t\"mcpServers\": {\n\t\t\"b\": {\"command\": \"b\"}\n\t}\n}\n" {
		t.Errorf("%q", got)
	}
	edit(t, path, "b", "")
	got, _ = os.ReadFile(path)
	if !json.Valid(got) || strings.Contains(string(got), `"b"`) {
		t.Errorf("%q", got)
	}
}

func TestEditCreatesTheFileOrTheObjectWhenMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "mcp.json")
	edit(t, path, "cerea-browser", `{"command":"node"}`)
	b, _ := os.ReadFile(path)
	if !json.Valid(b) || !strings.Contains(string(b), "\"mcpServers\": {\n\t\t\"cerea-browser\"") {
		t.Errorf("%s", b)
	}
	// An existing file with other keys but no mcpServers gains one, and keeps the rest.
	path2 := filepath.Join(dir, "other.json")
	_ = os.WriteFile(path2, []byte("{\n    \"keep\": true\n}\n"), 0o600)
	edit(t, path2, "cerea-browser", `{"command":"node"}`)
	b, _ = os.ReadFile(path2)
	if !json.Valid(b) || !strings.HasPrefix(string(b), "{\n    \"keep\": true,\n    \"mcpServers\": {\n        \"cerea-browser\": {") {
		t.Errorf("%s", b)
	}
	// An empty object of servers.
	path3 := filepath.Join(dir, "empty.json")
	_ = os.WriteFile(path3, []byte(`{"mcpServers":{}}`), 0o600)
	edit(t, path3, "cerea-browser", `{"command":"node"}`)
	b, _ = os.ReadFile(path3)
	var parsed struct{ McpServers map[string]any }
	if err := json.Unmarshal(b, &parsed); err != nil || parsed.McpServers["cerea-browser"] == nil {
		t.Errorf("%v %s", err, b)
	}
}

func TestEditWritesThroughASymlinkAndLeavesItALink(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "dotfiles", "mcp.json")
	_ = os.MkdirAll(filepath.Dir(real), 0o755)
	_ = os.WriteFile(real, []byte(userFile), 0o600)
	link := filepath.Join(dir, "mcp.json")
	if err := os.Symlink(real, link); err != nil {
		t.Skip("symlinks are not available here")
	}
	edit(t, link, "cerea-browser", `{"command":"node"}`)
	st, err := os.Lstat(link)
	if err != nil || st.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the symlink was replaced: %v %v", st, err)
	}
	b, _ := os.ReadFile(real)
	if !strings.Contains(string(b), "cerea-browser") || !strings.Contains(string(b), `"theme": "dark"`) {
		t.Errorf("the target was not edited:\n%s", b)
	}
}

func TestEditRefusesWhatItCannotReadAndTouchesNothing(t *testing.T) {
	for _, body := range []string{`{not json`, `[1,2]`, `{"mcpServers": 5}`, `{"mcpServers": {"a": `} {
		path := filepath.Join(t.TempDir(), "mcp.json")
		_ = os.WriteFile(path, []byte(body), 0o600)
		if _, err := editMcpServers(path, "cerea-browser", []byte(`{}`)); err == nil || !strings.Contains(err.Error(), "left alone") {
			t.Errorf("%q: %v", body, err)
		}
		if got, _ := os.ReadFile(path); string(got) != body {
			t.Errorf("%q was changed to %q", body, got)
		}
	}
}

func TestEditHandlesBracesAndQuotesInsideStrings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp.json")
	body := `{"mcpServers":{"a":{"command":"x","args":["}", "\"{", "]"]}},"z":"}"}`
	_ = os.WriteFile(path, []byte(body), 0o600)
	edit(t, path, "cerea-browser", `{"command":"node"}`)
	got, _ := os.ReadFile(path)
	if !json.Valid(got) || !strings.Contains(string(got), `"z":"}"`) || !strings.Contains(string(got), `"args":["}", "\"{", "]"]`) {
		t.Errorf("%s", got)
	}
}
