package opencode

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The delegation skill lands exactly when the tools do: same directory, same
// moment, and nothing at all for a machine that opted out.
func TestDelegationSkillShipsWithTools(t *testing.T) {
	dir := t.TempDir()
	b := New(Config{ToolsDir: dir})
	if err := b.startTools(); err != nil {
		t.Fatal(err)
	}
	defer b.stopTools()

	got, err := os.ReadFile(filepath.Join(dir, "skills", "delegation", "SKILL.md"))
	if err != nil {
		t.Fatalf("skill not installed: %v", err)
	}
	s := string(got)
	// opencode needs the folder name to equal the frontmatter name, and a
	// description, or the skill is never surfaced.
	if !strings.HasPrefix(s, "---\nname: delegation\ndescription: ") {
		t.Errorf("frontmatter wrong:\n%.200s", s)
	}
	for _, want := range []string{"task", "session_spawn", "session_send", "session_list", "approval", "not its result"} {
		if !strings.Contains(s, want) {
			t.Errorf("skill does not mention %q", want)
		}
	}
	for _, name := range []string{"session_list", "session_spawn", "session_send"} {
		if _, err := os.Stat(filepath.Join(dir, "tools", name+".js")); err != nil {
			t.Errorf("tool %s: %v", name, err)
		}
	}
}

func TestDelegationSkillAbsentWhenToolsDenied(t *testing.T) {
	dir := t.TempDir()
	b := New(Config{}) // ToolsDir "" is what agentToolsDir returns when denied
	if err := b.startTools(); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Errorf("denied machine wrote %d entries", len(entries))
	}
	if b.toolsEnabled() {
		t.Error("tools enabled without a ToolsDir")
	}
}
