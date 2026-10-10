package permrules

import "testing"

// The machine's safe external directories (policy.json's
// permission.safeDirs): the one allow that is not the word's to move and not
// a machine rule. Under every selector word they read the same, and only the
// ceiling caps them — these are the composition's word × safe dirs × ceiling
// specs.

func safeLayers() Layers {
	return Layers{SafeDirs: []string{"/tmp", "/home/u/.cache"}}
}

func TestSafeDirRulesAreOneAllowPerDirectory(t *testing.T) {
	got := SafeDirRules([]string{"/tmp", "/tmp", "/home/u/.cache", ""})
	want := []Rule{{"external_directory", "/tmp/*", Allow}, {"external_directory", "/home/u/.cache/*", Allow}}
	if len(got) != len(want) {
		t.Fatalf("SafeDirRules = %+v, want %+v (duplicates and empties dropped)", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("rule %d = %+v, want %+v", i, got[i], want[i])
		}
	}
	if SafeDirRules(nil) != nil {
		t.Error("no safe directories, no rules")
	}
}

func TestSafeDirsAllowUnderEveryWord(t *testing.T) {
	for _, mode := range []Action{Ask, Allow, Deny} {
		rules := Compose(safeLayers(), Selector{Mode: mode}, buildAgent)
		if got := Evaluate(rules, "external_directory", "/tmp/scratch/build.log"); got != Allow {
			t.Errorf("%s: external_directory /tmp/scratch = %s, want allow (the word does not move them)", mode, got)
		}
		if got := Evaluate(rules, "external_directory", "/home/u/.cache/opencode/x"); got != Allow {
			t.Errorf("%s: the cache = %s, want allow", mode, got)
		}
		// Everywhere else keeps opencode's own answer (an untouched name).
		if got := Evaluate(rules, "external_directory", "/etc/hostname"); got != Ask {
			t.Errorf("%s: external_directory /etc/hostname = %s, want ask", mode, got)
		}
		// The word still moves what it moves.
		if got := Evaluate(rules, "bash", "ls"); mode == Deny && got != Deny {
			t.Errorf("Deny: bash = %s, want deny", got)
		}
	}
}

func TestSafeDirsAreAllowedOnlyWithinTheEntry(t *testing.T) {
	rules := Compose(safeLayers(), Selector{}, buildAgent)
	for _, path := range []string{"/tmpx/file", "/home/u/.cache-evader/x", "/etc/passwd"} {
		if got := Evaluate(rules, "external_directory", path); got == Allow {
			t.Errorf("external_directory %q = allow, want it outside every safe entry", path)
		}
	}
}

func TestCeilingStillCapsSafeDirs(t *testing.T) {
	l := safeLayers()
	l.Ceiling = Ceiling{Max: map[string]Action{"external_directory": Ask}}
	rules := Compose(l, Selector{Mode: Allow}, buildAgent)
	if got := Evaluate(rules, "external_directory", "/tmp/x"); got != Ask {
		t.Errorf("a ceiling of external_directory=ask: /tmp = %s, want ask (the tail is last)", got)
	}
	l.Ceiling = Ceiling{Max: map[string]Action{"external_directory": Deny}}
	rules = Compose(l, Selector{Mode: Allow}, buildAgent)
	if got := Evaluate(rules, "external_directory", "/tmp/x"); got != Deny {
		t.Errorf("a ceiling of external_directory=deny: /tmp = %s, want deny", got)
	}
}

func TestAllowDoesNotDoubleAllow(t *testing.T) {
	// Under Allow the safe directories are still needed (external_directory is
	// untouched, so the blanket never allowed it) — and galopin must not stack
	// a second identical allow beside an exception of the same shape.
	l := safeLayers()
	sel := Selector{Mode: Allow, Exceptions: []Exception{{ID: "ex_1", Permission: "external_directory", Patterns: []string{"/tmp/*"}}}}
	rules := Compose(l, sel, []Rule{{"*", "*", Allow}})
	n := 0
	for i, r := range rules {
		if r == (Rule{"external_directory", "/tmp/*", Allow}) {
			n++
			if i > 0 && rules[i-1] == r {
				t.Errorf("the composed rules repeat %v back to back", r)
			}
		}
	}
	if n != 1 {
		t.Errorf("external_directory /tmp/* allow appears %d times, want exactly one", n)
	}
	if got := Evaluate(rules, "external_directory", "/tmp/x"); got != Allow {
		t.Errorf("external_directory /tmp/x = %s, want allow", got)
	}
}

func TestChildRulesCarryTheSafeDirs(t *testing.T) {
	rules := ChildRules(safeLayers(), Selector{Mode: Allow}, buildAgent)
	if got := Evaluate(rules, "external_directory", "/tmp/x"); got != Allow {
		t.Errorf("a subagent's later turns: external_directory /tmp/x = %s, want allow", got)
	}
	// The child ceiling (the machine's restricting rules as caps) still caps them.
	l := safeLayers()
	l.Own = []Rule{{"external_directory", "*", Ask}}
	rules = ChildRules(l, Selector{Mode: Allow}, buildAgent)
	if got := Evaluate(rules, "external_directory", "/tmp/x"); got != Ask {
		t.Errorf("a machine rule of external_directory=ask caps the child's safe directories: got %s", got)
	}
}

func TestFloorGivesTheSubagentsTheSafeDirs(t *testing.T) {
	perm := func(agent string) map[string]any {
		agents := safeLayers().Floor()["agent"].(map[string]any)
		a, ok := agents[agent].(map[string]any)
		if !ok {
			return map[string]any{}
		}
		m, ok := a["permission"].(map[string]any)
		if !ok {
			return map[string]any{}
		}
		return m
	}
	for _, name := range []string{"general", "explore"} {
		m, ok := perm(name)["external_directory"].(map[string]any)
		if !ok {
			t.Fatalf("%s carries no external_directory floor: %v", name, perm(name))
		}
		if m["/tmp/*"] != "allow" || m["/home/u/.cache/*"] != "allow" {
			t.Errorf("%s external_directory floor = %v, want the safe directories as allows", name, m)
		}
		if _, wildcard := m["*"]; wildcard {
			t.Errorf("%s external_directory floor carries a catch-all: %v", name, m)
		}
	}
	for _, name := range []string{"build", "plan"} {
		if m, ok := perm(name)["external_directory"]; ok {
			t.Errorf("%s carries external_directory in the floor (%v): the primaries get their rules in the session create", name, m)
		}
	}
	// A ceiling on external_directory caps the window the floor holds: no
	// allow may sit beside the cap (the ask entry restating the cap itself is
	// the floor's ordinary work).
	l := safeLayers()
	l.Ceiling = Ceiling{Max: map[string]Action{"external_directory": Ask}}
	agents := l.Floor()["agent"].(map[string]any)
	for _, name := range []string{"general", "explore"} {
		m, ok := agents[name].(map[string]any)["permission"].(map[string]any)["external_directory"]
		if !ok {
			continue
		}
		if am, isMap := m.(map[string]any); isMap && am["/tmp/*"] == "allow" {
			t.Errorf("%s carries %v in the floor under a ceiling of ask, want no allow beside the cap", name, m)
		}
	}
}

func TestFloorRulesAgreeWithTheFloorOnSafeDirs(t *testing.T) {
	l := safeLayers()
	for _, agent := range []string{"general", "explore"} {
		for _, want := range SafeDirRules(l.SafeDirs) {
			if !containsRule(l.FloorRules(agent), want) {
				t.Errorf("%s FloorRules lacks %+v", agent, want)
			}
		}
	}
}
