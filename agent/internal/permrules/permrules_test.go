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

func TestClampLowersEveryRuleToTheCeiling(t *testing.T) {
	c := Ceiling{Max: map[string]Action{"bash": Ask, "edit": Deny, "session_spawn": Ask}}
	got, clamped := c.Clamp([]Rule{
		{"bash", "*", Allow},         // over the ceiling: lowered to ask
		{"edit", "src/*", Allow},     // capped at deny
		{"read", "*", Allow},         // not capped: as asked
		{"bash", "ls *", Deny},       // under the ceiling: as asked
		{"session_spawn", "", Allow}, // empty pattern means *, and is lowered
		{"", "*", Allow},             // no permission: dropped
		{"read", "*", "yes"},         // not an action: dropped
	})
	want := []Rule{{"bash", "*", Ask}, {"edit", "src/*", Deny}, {"read", "*", Allow}, {"bash", "ls *", Deny}, {"session_spawn", "*", Ask}}
	if !reflect.DeepEqual(got, want) || !clamped {
		t.Errorf("Clamp = %+v clamped=%v, want %+v clamped", got, clamped, want)
	}
	if _, clamped := c.Clamp([]Rule{{"read", "*", Allow}, {"bash", "*", Ask}}); clamped {
		t.Error("rules within the ceiling were reported as clamped")
	}
}

// A wildcard permission is kept as asked, then followed by a clamped copy for
// each capped key it covers, so a re-read says what is true for them.
func TestClampExpandsAWildcardOverCappedKeys(t *testing.T) {
	c := Ceiling{Max: map[string]Action{"bash": Ask, "edit": Deny}}
	got, clamped := c.Clamp([]Rule{{"*", "*", Allow}})
	want := []Rule{{"*", "*", Allow}, {"bash", "*", Ask}, {"edit", "*", Deny}}
	if !reflect.DeepEqual(got, want) || !clamped {
		t.Errorf("Clamp = %+v, want %+v", got, want)
	}
	session := ComposeFor(Layers{Ceiling: c}, Panel{}.With(got), []Rule{{"*", "*", Allow}})
	all := append([]Rule{{"*", "*", Allow}}, session...)
	if Evaluate(all, "bash", "x") != Ask || Evaluate(all, "edit", "x") != Deny || Evaluate(all, "read", "x") != Allow {
		t.Error("a wildcard allow written through the panel got past the ceiling")
	}
}

// After a panel write the order is still the machine's rules, the panel's, then
// the ceiling — and a rule dropped by a later write is restored to what the
// base says, for the agent the session runs now.
func TestComposeForOrderAndRestoration(t *testing.T) {
	c := Ceiling{Max: map[string]Action{"bash": Ask}}
	l := Layers{Own: []Rule{{"webfetch", "*", Ask}}, Ceiling: c}
	build := []Rule{{"*", "*", Allow}}
	plan := []Rule{{"*", "*", Allow}, {"edit", "*", Deny}}

	p := Panel{}.With([]Rule{{"edit", "*", Allow}, {"read", "*.env", Deny}})
	got := ComposeFor(l, p, build)
	want := []Rule{{"webfetch", "*", Ask}, {"edit", "*", Allow}, {"read", "*.env", Deny}, {"bash", "*", Ask}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("composed = %+v, want the machine's rule, the panel's two, the ceiling last: %+v", got, want)
	}

	// A second write drops edit. In build the restoration says allow (the
	// base), in plan it says deny — it follows the agent, not the old write.
	p = p.With([]Rule{{"read", "*.env", Deny}})
	inBuild := ComposeFor(l, p, build)
	inPlan := ComposeFor(l, p, plan)
	if got := Evaluate(append(append([]Rule(nil), build...), inBuild...), "edit", "*"); got != Allow {
		t.Errorf("build after dropping the edit rule = %s, want the base's allow", got)
	}
	if got := Evaluate(append(append([]Rule(nil), plan...), inPlan...), "edit", "*"); got != Deny {
		t.Errorf("plan after dropping the edit rule = %s, want the base's deny, not the dropped allow", got)
	}
	// Even stacked behind the dropped rule, as opencode keeps it (appended, never removed).
	stacked := append(append(append([]Rule(nil), plan...), Rule{"edit", "*", Allow}), inPlan...)
	if got := Evaluate(stacked, "edit", "*"); got != Deny {
		t.Errorf("plan with the old allow still in the session = %s, want deny", got)
	}
	// The ceiling is last, whatever the panel did.
	if last := inBuild[len(inBuild)-1]; last != (Rule{"bash", "*", Ask}) {
		t.Errorf("last composed rule = %+v, want the ceiling's", last)
	}
}

func TestFromConfigAndFloorRules(t *testing.T) {
	got := FromConfig(map[string]any{"edit": "ask", "plan": map[string]any{"b": "allow", "a": "deny"}, "junk": 3})
	want := []Rule{{"edit", "*", Ask}, {"plan", "a", Deny}, {"plan", "b", Allow}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("FromConfig = %+v, want %+v", got, want)
	}
	c := Ceiling{Max: map[string]Action{"edit": Ask, "webfetch": Deny}}
	build := c.FloorRules("build")
	if !containsRule(build, Rule{"webfetch", "*", Deny}) || !containsRule(build, Rule{"edit", "*", Ask}) {
		t.Errorf("build floor = %+v", build)
	}
	plan := c.FloorRules("plan")
	if containsRule(plan, Rule{"edit", "*", Ask}) || !containsRule(plan, Rule{"edit", "*", Deny}) {
		t.Errorf("plan floor = %+v, want edit deny re-asserted and no ask", plan)
	}
}

func containsRule(rs []Rule, r Rule) bool {
	for _, x := range rs {
		if x == r {
			return true
		}
	}
	return false
}

// A subagent gets the machine's restricting rules as caps, applied the way the
// ceiling is: lowered over the child agent's own rules, so an ask tightens a
// general child and never softens a read-only one; an allow is not carried.
func TestChildGetsTheMachinesRestrictingRulesAsCaps(t *testing.T) {
	l := Layers{Own: []Rule{
		{"edit", "*", Ask}, {"bash", "*", Deny}, {"read", "*", Allow}, {"webfetch", "*", Allow},
	}}
	general := []Rule{{"*", "*", Allow}}
	explore := []Rule{{"*", "*", Deny}, {"read", "*", Allow}, {"bash", "*", Allow}}

	inGeneral := append(append([]Rule(nil), general...), ChildRules(l, general)...)
	if got := Evaluate(inGeneral, "edit", "a.go"); got != Ask {
		t.Errorf("general child edit = %s, want the machine's ask", got)
	}
	if got := Evaluate(inGeneral, "bash", "ls"); got != Deny {
		t.Errorf("general child bash = %s, want the machine's deny", got)
	}
	inExplore := append(append([]Rule(nil), explore...), ChildRules(l, explore)...)
	if got := Evaluate(inExplore, "edit", "a.go"); got != Deny {
		t.Errorf("explore child edit = %s: the machine's ask softened a deny", got)
	}
	// Allows are not carried: nothing the child had is widened.
	for _, r := range ChildRules(l, general) {
		if r.Action == Allow {
			t.Errorf("an allow reached a child: %+v", r)
		}
	}
	if got := Evaluate(append(append([]Rule(nil), explore...), ChildRules(l, explore)...), "webfetch", "x"); got != Deny {
		t.Errorf("explore webfetch = %s, want its own deny untouched by the machine's allow", got)
	}
	// The cap is the stricter of the machine's ceiling and its own rule.
	l.Ceiling = Ceiling{Max: map[string]Action{"edit": Deny}}
	if got := l.ChildCeiling().Of("edit"); got != Deny {
		t.Errorf("child ceiling for edit = %s, want deny (the ceiling is stricter)", got)
	}
}
