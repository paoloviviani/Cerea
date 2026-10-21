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
	for _, want := range []string{"task", "session_spawn", "session_send", "session_list", "approval", "Report from",
		"background: true",                 // the async path, so the model stops calling plain task "the only sync option"
		"closed: do not retry",             // policy-gated, not a bug to route around
		"## When you run on a schedule",    // the unattended-run section
		"[Scheduled run",                   // and the header that tells the model it is on one
		"Needs-you inbox",                  // pending approvals do not block a run
		"Trust the report; do not poll",    // spawn reports back by itself
		"final message",                    // a subagent reports in its final message
		"never tell a task subagent",       // the delegating side never routes the report through session_send
		"## Brief it so it can start cold", // the briefing template
		"**Acceptance**",
		"report: false",                  // fire-and-forget opt-out
		"## Safety",                      // the safety rules, in one block
		"## Scheduling work",             // the schedule tools' section
		"**List first.**",                // update instead of duplicating
		"session: \"this\"",              // follow-ups land in this session
		"Schedules outlive you.",         // name them clearly
		"paused: true",                   // stop your own when done
		"every create asks the person",   // the runaway guard, so the model expects the card
		"all together (or none of them)", // the coordination options Cerea stores
		"Deny included",                  // stopping your own schedule always works
		"## Profiles and recipes",        // delegate profiles and the three recipes
		"session_profiles", "session_committee", "**Handoff**", "**Second opinion**", "**Committee**",
		"A profile is a model, never a permission", // a profile never widens what a delegate may do
		"mode: \"plan\"", // read-only comes from the mode argument
		"2 to 3 members", // the committee bound
	} {
		if !strings.Contains(s, want) {
			t.Errorf("skill does not mention %q", want)
		}
	}
	if strings.Contains(s, "do the work yourself") {
		t.Error("the skill must not tell the model to do the work itself")
	}
	if n := strings.Count(s, "\n"); n > 110 {
		t.Errorf("skill is %d lines; keep it short", n)
	}
	for _, name := range []string{"session_list", "session_spawn", "session_send", "session_profiles", "session_committee",
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
