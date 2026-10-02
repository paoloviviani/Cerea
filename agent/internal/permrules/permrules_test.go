package permrules

import (
	"reflect"
	"testing"
)

func TestMatchIsOpencodesWildcard(t *testing.T) {
	cases := []struct {
		s, pattern string
		want       bool
	}{
		{"edit", "*", true},
		{"edit", "edit", true},
		{"edit", "ed*", true},
		{"edit", "e?it", true},
		{"edit", "bash", false},
		{"ls", "ls *", true},
		{"ls -la", "ls *", true},
		{"lsx", "ls *", false},
		{"a.b", "a.b", true},
		{"axb", "a.b", false},
		{`src\main.go`, "src/*", true},
		{"line1\nline2", "line1*", true},
	}
	for _, c := range cases {
		if got := Match(c.s, c.pattern); got != c.want {
			t.Errorf("Match(%q, %q) = %v, want %v", c.s, c.pattern, got, c.want)
		}
	}
}

func TestEvaluateLastMatchWinsAndDefaultsToAsk(t *testing.T) {
	rules := []Rule{{"*", "*", Allow}, {"edit", "*", Deny}, {"edit", "docs/*", Allow}}
	if got := Evaluate(rules, "edit", "docs/a.md"); got != Allow {
		t.Errorf("docs write = %s, want allow", got)
	}
	if got := Evaluate(rules, "edit", "src/a.go"); got != Deny {
		t.Errorf("src write = %s, want deny", got)
	}
	if got := Evaluate(rules, "read", "x"); got != Allow {
		t.Errorf("read = %s, want allow", got)
	}
	if got := Evaluate(nil, "edit", "x"); got != Ask {
		t.Errorf("no rules = %s, want ask", got)
	}
}

// The reason Tail restates rather than appends: a ceiling must never turn a
// deny into an ask.
func TestTailCapsWithoutLoosening(t *testing.T) {
	plan := []Rule{{"*", "*", Allow}, {"edit", "*", Deny}, {"edit", ".opencode/plans/*.md", Allow}}
	build := []Rule{{"*", "*", Allow}}
	c := Ceiling{Max: map[string]Action{"edit": Ask}}

	for _, tc := range []struct {
		name    string
		agent   []Rule
		pattern string
		want    Action
	}{
		{"build write is capped to ask", build, "a.go", Ask},
		{"plan write stays denied", plan, "a.go", Deny},
		{"plan's plan file is capped to ask", plan, ".opencode/plans/x.md", Ask},
	} {
		session := Compose(Layers{Ceiling: c}, tc.agent)
		got := Evaluate(append(append([]Rule(nil), tc.agent...), session...), "edit", tc.pattern)
		if got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}
	// A key the ceiling does not name is untouched.
	session := Compose(Layers{Ceiling: c}, build)
	if got := Evaluate(append(append([]Rule(nil), build...), session...), "read", "a"); got != Allow {
		t.Errorf("read = %s, want allow", got)
	}
}

func TestTailDenyBeatsEverythingBeneath(t *testing.T) {
	agent := []Rule{{"*", "*", Allow}}
	own := []Rule{{"bash", "*", Allow}}
	c := Ceiling{Max: map[string]Action{"bash": Deny}}
	session := Compose(Layers{Own: own, Ceiling: c}, agent)
	all := append(append([]Rule(nil), agent...), session...)
	if got := Evaluate(all, "bash", "rm -rf /"); got != Deny {
		t.Errorf("bash = %s, want deny", got)
	}
}

// P3's arithmetic: the machine's own allow is still capped by the ceiling.
func TestOwnAllowIsCappedByCeiling(t *testing.T) {
	agent := []Rule{{"*", "*", Allow}}
	l := Layers{Own: OwnRules(map[string]Action{"edit": Allow}), Ceiling: Ceiling{Max: map[string]Action{"edit": Ask}}}
	session := Compose(l, agent)
	all := append(append([]Rule(nil), agent...), session...)
	if got := Evaluate(all, "edit", "a.go"); got != Ask {
		t.Errorf("edit = %s, want ask (ceiling wins)", got)
	}
	// Without the ceiling the same own rule allows.
	session = Compose(Layers{Own: l.Own}, agent)
	all = append(append([]Rule(nil), agent...), session...)
	if got := Evaluate(all, "edit", "a.go"); got != Allow {
		t.Errorf("edit without ceiling = %s, want allow", got)
	}
}

func TestComposePutsTheCeilingLast(t *testing.T) {
	l := Layers{Own: OwnRules(map[string]Action{"edit": Allow}), Ceiling: Ceiling{Max: map[string]Action{"edit": Ask}}}
	rules := Compose(l, []Rule{{"*", "*", Allow}})
	if len(rules) < 2 {
		t.Fatalf("rules = %+v", rules)
	}
	if rules[0] != (Rule{"edit", "*", Allow}) {
		t.Errorf("first rule = %+v, want the machine's own", rules[0])
	}
	for _, r := range rules[1:] {
		if r.Action == Allow {
			t.Errorf("an allow follows the machine's own rules: %+v", rules)
		}
	}
}

func TestChildRulesCarryNoOwnAllow(t *testing.T) {
	l := Layers{Own: OwnRules(map[string]Action{"edit": Allow}), Ceiling: Ceiling{Max: map[string]Action{"bash": Ask}}}
	for _, r := range ChildRules(l, []Rule{{"*", "*", Allow}}) {
		if r.Permission == "edit" {
			t.Errorf("the machine's own edit rule reached a child: %+v", r)
		}
	}
}

func TestGrantNeverReadsAWildcardAllowAsConsent(t *testing.T) {
	cases := []struct {
		name  string
		rules []Rule
		want  Action
	}{
		{"absent", nil, Ask},
		{"default allow-all", []Rule{{"*", "*", Allow}}, Ask},
		{"explicit allow", []Rule{{"*", "*", Allow}, {"session_spawn", "*", Allow}}, Allow},
		{"explicit deny", []Rule{{"session_spawn", "*", Deny}}, Deny},
		{"explicit ask", []Rule{{"session_spawn", "*", Ask}}, Ask},
		{"wildcard deny refuses", []Rule{{"session_spawn", "*", Allow}, {"*", "*", Deny}}, Deny},
		{"wildcard allow after explicit allow is no opinion", []Rule{{"session_spawn", "*", Allow}, {"*", "*", Allow}}, Allow},
		{"explicit deny survives a later wildcard allow", []Rule{{"session_spawn", "*", Deny}, {"*", "*", Allow}}, Deny},
		{"another tool's rule is not this one's", []Rule{{"session_send", "*", Allow}}, Ask},
	}
	for _, c := range cases {
		if got := Grant(c.rules, "session_spawn"); got != c.want {
			t.Errorf("%s: Grant = %s, want %s", c.name, got, c.want)
		}
	}
}

func TestCeilingMeetAndTighter(t *testing.T) {
	a := Ceiling{Max: map[string]Action{"bash": Ask, "edit": Ask}}
	b := Ceiling{Max: map[string]Action{"bash": Deny, "webfetch": Ask}}
	m := a.Meet(b)
	want := map[string]Action{"bash": Deny, "edit": Ask, "webfetch": Ask}
	if !reflect.DeepEqual(m.Max, want) {
		t.Errorf("Meet = %v, want %v", m.Max, want)
	}
	if !b.TighterThan(a) {
		t.Error("b caps bash lower than a: tighter")
	}
	if !a.TighterThan(b) {
		t.Error("a caps edit, which b does not: tighter in that key")
	}
	if a.TighterThan(a) || !a.Equal(a) {
		t.Error("a ceiling is not tighter than itself")
	}
	if (Ceiling{}).TighterThan(a) {
		t.Error("no ceiling is not tighter than a ceiling")
	}
}

func TestCeilingIgnoresWildcardAndInvalidKeys(t *testing.T) {
	c := Ceiling{Max: map[string]Action{"*": Deny, "edit": "nonsense", "bash": Ask}}
	if got := c.Keys(); !reflect.DeepEqual(got, []string{"bash"}) {
		t.Errorf("Keys = %v, want [bash]", got)
	}
	if c.Of("edit") != Allow {
		t.Error("an invalid ceiling value must not cap")
	}
}

func TestFloorWritesAskOnlyWhereAnAgentGrantsTheKey(t *testing.T) {
	c := Ceiling{Max: map[string]Action{"edit": Ask, "bash": Ask, "webfetch": Deny}}
	f := c.Floor()
	agents := f["agent"].(map[string]any)
	perm := func(agent string) map[string]any {
		a, ok := agents[agent].(map[string]any)
		if !ok {
			t.Fatalf("no floor for %s: %v", agent, f)
		}
		return a["permission"].(map[string]any)
	}
	if perm("build")["edit"] != "ask" || perm("general")["edit"] != "ask" {
		t.Error("build and general grant edit: floor must ask")
	}
	if perm("plan")["edit"] == "ask" || perm("explore")["edit"] == "ask" {
		t.Error("plan and explore deny edit: an ask floor would loosen them")
	}
	if perm("explore")["edit"] != "deny" {
		t.Errorf("explore edit = %v, want it re-asserted as deny", perm("explore")["edit"])
	}
	if _, ok := perm("plan")["edit"].(map[string]any); !ok {
		t.Errorf("plan edit = %v, want its built-in shape re-asserted", perm("plan")["edit"])
	}
	if perm("explore")["bash"] != "ask" || perm("plan")["bash"] != "ask" {
		t.Error("explore and plan grant bash: floor must ask")
	}
	for _, n := range []string{"build", "plan", "general", "explore"} {
		if perm(n)["webfetch"] != "deny" {
			t.Errorf("%s webfetch = %v, want deny", n, perm(n)["webfetch"])
		}
	}
	if f["permission"].(map[string]any)["webfetch"] != "deny" {
		t.Errorf("top-level permission = %v, want webfetch deny", f["permission"])
	}
}

func TestFloorWithNoCeilingStillProtectsReadOnlyAgents(t *testing.T) {
	f := Ceiling{}.Floor()
	if _, ok := f["permission"]; ok {
		t.Error("no ceiling: no top-level permission")
	}
	agents := f["agent"].(map[string]any)
	if _, ok := agents["build"]; ok {
		t.Error("no ceiling: build needs no floor")
	}
	if _, ok := agents["explore"]; !ok {
		t.Error("explore's and plan's edit deny is re-asserted whatever the ceiling (a static edit: ask would soften it)")
	}
}
