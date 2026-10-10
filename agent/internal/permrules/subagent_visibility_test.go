package permrules

import "testing"

// opencode 1.18.34's own two steps for a task subagent, mirrored so the
// composer's output can be checked against them without a server:
//
//   - deriveSubagentSessionPermission (agent/subagent-permissions.ts): the
//     child's session starts with the parent session's deny and
//     external_directory rules only, plus todowrite and task denies;
//   - Permission.disabled (permission/index.ts): a tool is hidden from the
//     request when the last rule whose permission matches its name — pattern
//     ignored — is a `*`-pattern deny (edit/write/apply_patch read as edit).
func ocChildSeed(parent []Rule) []Rule {
	var out []Rule
	for _, r := range parent {
		if r.Permission == "external_directory" || r.Action == Deny {
			out = append(out, r)
		}
	}
	return append(out, Rule{"todowrite", "*", Deny}, Rule{"task", "*", Deny})
}

func ocHidden(tools []string, rules []Rule) map[string]bool {
	hidden := map[string]bool{}
	for _, tool := range tools {
		permission := tool
		if tool == "write" || tool == "apply_patch" {
			permission = "edit"
		}
		var last *Rule
		for i := range rules {
			if Match(permission, rules[i].Permission) {
				last = &rules[i]
			}
		}
		if last != nil && last.Pattern == "*" && last.Action == Deny {
			hidden[tool] = true
		}
	}
	return hidden
}

var subagentTools = []string{"bash", "read", "edit", "write", "glob", "grep", "webfetch", "skill", "session_list", "session_read", "session_send", "session_spawn", "schedule_list"}

// history appends one composed block per selector, the way galopin's session
// PATCHes accumulate in opencode (append-only).
func history(l Layers, agent []Rule, words ...Action) []Rule {
	var out []Rule
	for _, w := range words {
		out = append(out, Compose(l, Selector{Mode: w}, agent)...)
	}
	return out
}

func TestASubagentKeepsItsToolsAfterTheParentWasOnDenyOnce(t *testing.T) {
	// The parent was on Deny for a moment, long ago, and is on Allow now. Its
	// own tools are fine (last match wins); its child's first step must be too.
	parent := history(Layers{}, buildAgent, Ask, Deny, Allow)
	child := append(append([]Rule(nil), buildAgent...), ocChildSeed(parent)...)
	hidden := ocHidden(subagentTools, child)
	if len(hidden) > 0 {
		t.Fatalf("a subagent of a session that was once on Deny starts with these tools hidden: %v", hidden)
	}
	if h := ocHidden(subagentTools, append(append([]Rule(nil), buildAgent...), parent...)); len(h) > 0 {
		t.Errorf("the parent itself has tools hidden: %v", h)
	}
}

func TestASubagentOfASessionOnDenyStillHasNoTools(t *testing.T) {
	// On Deny now: the child must not get around the parent's word.
	parent := history(Layers{}, buildAgent, Allow, Deny)
	child := append(append([]Rule(nil), buildAgent...), ocChildSeed(parent)...)
	hidden := ocHidden([]string{"bash", "edit", "write", "webfetch"}, child)
	for _, tool := range []string{"bash", "edit", "write", "webfetch"} {
		if !hidden[tool] {
			t.Errorf("%s is visible to the child of a session on Deny", tool)
		}
	}
}

func TestAMachineDenyStillHidesItsToolInTheChild(t *testing.T) {
	// A deny later in the block — the machine's own rule, the ceiling's tail —
	// still hides its tool: the sentinel opens the block, it does not end it.
	l := Layers{
		Own:     OwnRules(map[string]Action{"webfetch": Deny}),
		Ceiling: Ceiling{Max: map[string]Action{"edit": Deny}},
	}
	parent := history(l, buildAgent, Ask, Deny, Allow)
	child := append(append([]Rule(nil), buildAgent...), ocChildSeed(parent)...)
	hidden := ocHidden(subagentTools, child)
	for _, tool := range []string{"webfetch", "edit", "write"} {
		if !hidden[tool] {
			t.Errorf("%s (denied by this machine) is visible to the child", tool)
		}
	}
	if hidden["bash"] || hidden["read"] {
		t.Errorf("tools the machine leaves alone are hidden: %v", hidden)
	}
}

func TestTheSentinelNeverDecidesACall(t *testing.T) {
	// Every (permission, input) a session evaluates reads the same with and
	// without the sentinel, under every word and with a ceiling and machine
	// rules in play.
	l := Layers{
		Own:      OwnRules(map[string]Action{"webfetch": Deny, "session_read": Allow}),
		Ceiling:  Ceiling{Max: map[string]Action{"bash": Ask}},
		SafeDirs: []string{"/tmp"},
	}
	inputs := []string{"*", "ls", "ls -la", "src/a.go", "/tmp/x", "/etc/hostname", "x.env", ToolVisibilitySentinel.Pattern + "x"}
	perms := []string{"bash", "read", "edit", "webfetch", "external_directory", "session_read", "session_spawn", "task", "glob"}
	for _, w := range []Action{Deny, Ask, Allow} {
		with := Compose(l, Selector{Mode: w}, buildAgent)
		var without []Rule
		for _, r := range with {
			if !IsToolVisibilitySentinel(r) && r.Pattern != ToolVisibilitySentinel.Pattern {
				without = append(without, r)
			}
		}
		for _, p := range perms {
			for _, in := range inputs {
				if a, b := Evaluate(with, p, in), Evaluate(without, p, in); a != b {
					t.Errorf("word %s, %s %q: %s with the sentinel, %s without", w, p, in, a, b)
				}
			}
			if a, b := Grant(with, p), Grant(without, p); a != b {
				t.Errorf("word %s: Grant(%s) = %s with the sentinel, %s without", w, p, a, b)
			}
		}
	}
}
