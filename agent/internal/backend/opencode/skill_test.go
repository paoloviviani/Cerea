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
	for _, want := range []string{"task", "session_spawn", "session_send", "session_list", "approval", "not its result",
		"background: true",                // the async path, so the model stops calling plain task "the only sync option"
		"fails closed",                    // and knows it is policy-gated, not a bug to route around
		"## When you run on a schedule",   // the unattended-run section
		"[Scheduled run",                  // and the header that tells the model it is on one
		"Needs-you inbox",                 // pending approvals do not block a run
		"a schedule's coordination grant", // a second reason a call carries no card
		"you a message when it is done",   // spawn CAN ping back via send (approvals still apply)
		"## Scheduling work",              // the schedule tools' section
		"**List first.**",                 // update instead of duplicating
		"session: \"this\"",               // follow-ups land in this session
		"Schedules outlive you.",          // name them clearly
		"paused: true",                    // stop your own when done
		"every create asks the person",    // the runaway guard, so the model expects the card
	} {
		if !strings.Contains(s, want) {
			t.Errorf("skill does not mention %q", want)
		}
	}
	for _, name := range []string{"session_list", "session_spawn", "session_send",
		"schedule_list", "schedule_create", "schedule_update", "schedule_delete"} {
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
