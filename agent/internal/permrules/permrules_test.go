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
		session := Compose(Layers{Ceiling: c}, Selector{}, tc.agent)
		got := Evaluate(append(append([]Rule(nil), tc.agent...), session...), "edit", tc.pattern)
		if got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}
	// A key the ceiling does not name is untouched.
	session := Compose(Layers{Ceiling: c}, Selector{}, build)
	if got := Evaluate(append(append([]Rule(nil), build...), session...), "read", "a"); got != Allow {
		t.Errorf("read = %s, want allow", got)
	}
}

func TestTailDenyBeatsEverythingBeneath(t *testing.T) {
	agent := []Rule{{"*", "*", Allow}}
	own := []Rule{{"bash", "*", Allow}}
	c := Ceiling{Max: map[string]Action{"bash": Deny}}
	session := Compose(Layers{Own: own, Ceiling: c}, Selector{}, agent)
	all := append(append([]Rule(nil), agent...), session...)
	if got := Evaluate(all, "bash", "rm -rf /"); got != Deny {
		t.Errorf("bash = %s, want deny", got)
	}
}

// P3's arithmetic: the machine's own allow is still capped by the ceiling.
func TestOwnAllowIsCappedByCeiling(t *testing.T) {
	agent := []Rule{{"*", "*", Allow}}
	l := Layers{Own: OwnRules(map[string]Action{"edit": Allow}), Ceiling: Ceiling{Max: map[string]Action{"edit": Ask}}}
	session := Compose(l, Selector{}, agent)
	all := append(append([]Rule(nil), agent...), session...)
	if got := Evaluate(all, "edit", "a.go"); got != Ask {
		t.Errorf("edit = %s, want ask (ceiling wins)", got)
	}
	// Without the ceiling (and with the person's Allow) the same own rule allows.
	session = Compose(Layers{Own: l.Own}, Selector{Mode: Allow}, agent)
	all = append(append([]Rule(nil), agent...), session...)
	if got := Evaluate(all, "edit", "a.go"); got != Allow {
		t.Errorf("edit without ceiling = %s, want allow", got)
	}
}

func TestComposePutsTheCeilingLast(t *testing.T) {
	l := Layers{Own: OwnRules(map[string]Action{"edit": Allow}), Ceiling: Ceiling{Max: map[string]Action{"edit": Ask}}}
	rules := Compose(l, Selector{}, []Rule{{"*", "*", Allow}})
	if len(rules) < 3 {
		t.Fatalf("rules = %+v", rules)
	}
	if rules[0] != (Rule{"edit", "*", Allow}) {
		t.Errorf("first rule = %+v, want the machine's own", rules[0])
	}
	if last := rules[len(rules)-1]; last != (Rule{"edit", "*", Ask}) {
		t.Errorf("last rule = %+v, want the ceiling's", last)
	}
}

func TestChildRulesCarryNoOwnAllow(t *testing.T) {
	l := Layers{Own: OwnRules(map[string]Action{"edit": Allow}), Ceiling: Ceiling{Max: map[string]Action{"bash": Ask}}}
	for _, r := range ChildRules(l, Selector{Mode: Allow}, []Rule{{"*", "*", Allow}}) {
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

// The selector's arithmetic. eval runs a composed session the way opencode does:
// the agent's rules, then the session's, last match wins.
func eval(agent, session []Rule, permission, pattern string) Action {
	return Evaluate(append(append([]Rule(nil), agent...), session...), permission, pattern)
}

// opencode 1.18.32's build and plan agents, as far as the blanket cares: the
// default allow-all, the asks it keeps, and plan's edit deny.
var (
	buildAgent = []Rule{
		{"*", "*", Allow}, {"doom_loop", "*", Ask},
		{"external_directory", "*", Ask}, {"external_directory", "/tmp/*", Allow},
		{"question", "*", Allow}, {"read", "*", Allow}, {"read", "*.env", Ask}, {"read", "*.env.*", Ask}, {"read", "*.env.example", Allow},
	}
	planAgent = append(append([]Rule(nil), buildAgent...),
		Rule{"edit", "*", Deny}, Rule{"edit", ".opencode/plans/*.md", Allow})
	exploreAgent = []Rule{
		{"*", "*", Deny}, {"read", "*", Allow}, {"grep", "*", Allow}, {"bash", "*", Allow},
		{"read", "*.env", Ask}, {"external_directory", "*", Ask},
	}
)

func TestSelectorBlanketPerMode(t *testing.T) {
	for _, tc := range []struct {
		mode            Action
		edit, bash, web Action
	}{
		{Allow, Allow, Allow, Allow},
		{Ask, Ask, Ask, Ask},
		{Deny, Deny, Deny, Deny},
	} {
		session := Compose(Layers{}, Selector{Mode: tc.mode}, buildAgent)
		if got := eval(buildAgent, session, "edit", "a.go"); got != tc.edit {
			t.Errorf("%s: edit = %s, want %s", tc.mode, got, tc.edit)
		}
		if got := eval(buildAgent, session, "bash", "ls"); got != tc.bash {
			t.Errorf("%s: bash = %s, want %s", tc.mode, got, tc.bash)
		}
		if got := eval(buildAgent, session, "mcp_server_tool", "x"); got != tc.web {
			t.Errorf("%s: an MCP tool = %s, want %s: every custom tool follows the blanket", tc.mode, got, tc.web)
		}
	}
}

// Reading stays allowed under all three words, and what the agent asks for
// still asks: .env, a write outside the project, the doom-loop brake.
func TestSelectorLeavesTheUntouchedSetAlone(t *testing.T) {
	for _, mode := range []Action{Deny, Ask, Allow} {
		session := Compose(Layers{}, Selector{Mode: mode}, buildAgent)
		for _, c := range []struct {
			perm, pattern string
			want          Action
		}{
			{"read", "src/a.go", Allow}, {"read", ".env", Ask}, {"read", ".env.example", Allow},
			{"grep", "x", Allow}, {"glob", "x", Allow}, {"list", "x", Allow}, {"lsp", "x", Allow},
			{"question", "*", Allow}, {"todowrite", "*", Allow}, {"skill", "x", Allow},
			{"external_directory", "/etc/x", Ask}, {"external_directory", "/tmp/x", Allow},
			{"doom_loop", "x", Ask},
		} {
			if got := eval(buildAgent, session, c.perm, c.pattern); got != c.want {
				t.Errorf("%s: %s %q = %s, want %s", mode, c.perm, c.pattern, got, c.want)
			}
		}
	}
}

// A name nothing beneath mentions asks, as opencode's own default does — it
// does not become an allow just because the mode is Allow.
func TestSelectorUntouchedNameNobodyMentionsAsks(t *testing.T) {
	session := Compose(Layers{}, Selector{Mode: Allow}, nil)
	if got := eval(nil, session, "read", "x"); got != Ask {
		t.Errorf("read with no agent rule = %s, want ask", got)
	}
}

// The blanket never turns a deny into an ask or an allow: plan's edit deny and
// a read-only subagent's `*: deny` stand under every mode, and plan keeps its
// plan file, brought to the mode like any allow.
func TestSelectorNeverLoosensADeny(t *testing.T) {
	for _, mode := range []Action{Ask, Allow} {
		plan := Compose(Layers{}, Selector{Mode: mode}, planAgent)
		if got := eval(planAgent, plan, "edit", "src/a.go"); got != Deny {
			t.Errorf("%s: plan edit = %s, want deny", mode, got)
		}
		if got := eval(planAgent, plan, "edit", ".opencode/plans/x.md"); got != mode {
			t.Errorf("%s: plan's plan file = %s, want %s", mode, got, mode)
		}
		explore := ChildRules(Layers{}, Selector{Mode: mode}, exploreAgent)
		for _, perm := range []string{"edit", "task", "webfetch", "an_mcp_tool"} {
			if got := eval(exploreAgent, explore, perm, "x"); got != Deny {
				t.Errorf("%s: explore %s = %s, want its own deny", mode, perm, got)
			}
		}
		if got := eval(exploreAgent, explore, "bash", "ls"); got != mode {
			t.Errorf("%s: explore bash = %s, want %s", mode, got, mode)
		}
		if got := eval(exploreAgent, explore, "read", "a.go"); got != Allow {
			t.Errorf("%s: explore read = %s, want allow", mode, got)
		}
	}
}

// The machine's own rules sit beneath the mode block, as they did beneath the
// person's rules; its denies still hold.
func TestSelectorOwnRulesAreBeneathTheMode(t *testing.T) {
	l := Layers{Own: []Rule{{"edit", "*", Allow}, {"webfetch", "*", Deny}, {"read", "*.secret", Deny}}}
	ask := Compose(l, Selector{}, buildAgent)
	if got := eval(buildAgent, ask, "edit", "a"); got != Ask {
		t.Errorf("own allow under Ask = %s, want ask (the mode is above it)", got)
	}
	allow := Compose(l, Selector{Mode: Allow}, buildAgent)
	if got := eval(buildAgent, allow, "webfetch", "u"); got != Deny {
		t.Errorf("own deny under Allow = %s, want deny", got)
	}
	if got := eval(buildAgent, allow, "read", "x.secret"); got != Deny {
		t.Errorf("own read deny (an untouched key) under Allow = %s, want deny", got)
	}
	if rules, _ := ComposeParts(l, Selector{}, buildAgent); !reflect.DeepEqual(rules[:3], l.Own) {
		t.Errorf("the machine's own rules are not first: %+v", rules[:3])
	}
}

func TestSelectorExceptionsPlacement(t *testing.T) {
	ex := Exception{ID: "ex_1", Permission: "bash", Patterns: []string{"git status *"}}
	sel := func(m Action) Selector { return Selector{Mode: m, Exceptions: []Exception{ex}} }

	ask := Compose(Layers{}, sel(Ask), buildAgent)
	if got := eval(buildAgent, ask, "bash", "git status"); got != Allow {
		t.Errorf("Ask: git status = %s, want the exception's allow", got)
	}
	if got := eval(buildAgent, ask, "bash", "git log"); got != Ask {
		t.Errorf("Ask: git log = %s, want ask", got)
	}
	allow := Compose(Layers{}, sel(Allow), buildAgent)
	if got := eval(buildAgent, allow, "bash", "git log"); got != Allow {
		t.Errorf("Allow: git log = %s, want allow", got)
	}
	deny := Compose(Layers{}, sel(Deny), buildAgent)
	if got := eval(buildAgent, deny, "bash", "git status"); got != Deny {
		t.Errorf("Deny: git status = %s, want deny: Deny beats an exception", got)
	}
	// Kept while blocked: the same selector back on Ask allows it again.
	back := Compose(Layers{}, sel(Ask), buildAgent)
	if got := eval(buildAgent, back, "bash", "git status"); got != Allow {
		t.Errorf("back on Ask: git status = %s, want allow restored", got)
	}
}

// What a re-send sits behind: opencode only appends a session's rules, so a
// later block has to beat an earlier one for every input, exceptions included.
func TestSelectorALaterBlockBeatsAnEarlierOne(t *testing.T) {
	ex := Exception{ID: "ex_1", Permission: "bash", Patterns: []string{"git status *"}}
	first := Compose(Layers{}, Selector{Mode: Allow, Exceptions: []Exception{ex}}, buildAgent)
	second := Compose(Layers{}, Selector{Mode: Ask}, buildAgent) // exception removed, mode back to Ask
	stacked := append(append([]Rule(nil), first...), second...)
	if got := eval(buildAgent, stacked, "bash", "git status"); got != Ask {
		t.Errorf("git status after the exception was removed = %s, want ask", got)
	}
	if got := eval(buildAgent, stacked, "edit", "a.go"); got != Ask {
		t.Errorf("edit after Allow then Ask = %s, want ask", got)
	}
}

func TestSelectorCeilingCapsEverythingAboveIt(t *testing.T) {
	ex := Exception{ID: "ex_1", Permission: "bash", Patterns: []string{"git status *"}}
	l := Layers{Ceiling: Ceiling{Max: map[string]Action{"bash": Ask, "edit": Deny}}}
	session := Compose(l, Selector{Mode: Allow, Exceptions: []Exception{ex}}, buildAgent)
	if got := eval(buildAgent, session, "bash", "git status"); got != Ask {
		t.Errorf("a capped key's exception = %s, want ask (the ceiling is last)", got)
	}
	if got := eval(buildAgent, session, "bash", "ls"); got != Ask {
		t.Errorf("Allow on a capped key = %s, want the cap", got)
	}
	if got := eval(buildAgent, session, "edit", "a"); got != Deny {
		t.Errorf("edit capped at deny = %s", got)
	}
	if got := eval(buildAgent, session, "webfetch", "u"); got != Allow {
		t.Errorf("an uncapped key under Allow = %s, want allow", got)
	}
}

func TestSelectorEffectiveDefaultsToAsk(t *testing.T) {
	if (Selector{}).Effective() != Ask || (Selector{Mode: "bogus"}).Effective() != Ask {
		t.Error("an unset or invalid mode must read as ask")
	}
}

func TestSelectorExceptionSetOps(t *testing.T) {
	s := Selector{}
	s, a := s.With(Exception{ID: "ex_a", Permission: "bash", Patterns: []string{"ls *"}})
	s, b := s.With(Exception{ID: "ex_b", Permission: "bash", Patterns: []string{"ls *"}})
	if a.ID != "ex_a" || b.ID != "ex_a" || len(s.Exceptions) != 1 {
		t.Errorf("the same permission and patterns twice = %+v / %+v / %d entries, want one", a, b, len(s.Exceptions))
	}
	if _, ok := s.Find("ex_a"); !ok {
		t.Error("Find lost the exception")
	}
	if _, ok := s.Without("ex_zzz"); ok {
		t.Error("Without reported removing an id it never held")
	}
	if got, ok := s.Without("ex_a"); !ok || len(got.Exceptions) != 0 || len(s.Exceptions) != 1 {
		t.Errorf("Without = %+v ok=%v (and the original must be untouched)", got, ok)
	}
}

// The subagent's block is the ROOT's selector over the child agent's rules,
// capped, with no machine allow in it.
func TestSelectorChildFollowsTheRootsMode(t *testing.T) {
	general := []Rule{{"*", "*", Allow}}
	l := Layers{Own: []Rule{{"edit", "*", Allow}}}
	ex := Exception{ID: "ex_1", Permission: "bash", Patterns: []string{"git status *"}}
	for _, tc := range []struct {
		mode Action
		edit Action
		git  Action
	}{{Allow, Allow, Allow}, {Ask, Ask, Allow}, {Deny, Deny, Deny}} {
		rules := ChildRules(l, Selector{Mode: tc.mode, Exceptions: []Exception{ex}}, general)
		if got := eval(general, rules, "edit", "a.go"); got != tc.edit {
			t.Errorf("root on %s: child edit = %s, want %s", tc.mode, got, tc.edit)
		}
		if got := eval(general, rules, "bash", "git status"); got != tc.git {
			t.Errorf("root on %s: child git status = %s, want %s", tc.mode, got, tc.git)
		}
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

	inGeneral := append(append([]Rule(nil), general...), ChildRules(l, Selector{}, general)...)
	if got := Evaluate(inGeneral, "edit", "a.go"); got != Ask {
		t.Errorf("general child edit = %s, want the machine's ask", got)
	}
	if got := Evaluate(inGeneral, "bash", "ls"); got != Deny {
		t.Errorf("general child bash = %s, want the machine's deny", got)
	}
	inExplore := append(append([]Rule(nil), explore...), ChildRules(l, Selector{}, explore)...)
	if got := Evaluate(inExplore, "edit", "a.go"); got != Deny {
		t.Errorf("explore child edit = %s: the machine's ask softened a deny", got)
	}
	// The machine's allows are not carried: an edit allow of the machine's own
	// (or any other blanket-name allow) never reaches a child under Ask.
	for _, r := range ChildRules(l, Selector{}, general) {
		if r.Action == Allow && !IsUntouched(r.Permission) {
			t.Errorf("an allow reached a child: %+v", r)
		}
	}
	if got := Evaluate(append(append([]Rule(nil), explore...), ChildRules(l, Selector{}, explore)...), "webfetch", "x"); got != Deny {
		t.Errorf("explore webfetch = %s, want its own deny untouched by the machine's allow", got)
	}
	// The cap is the stricter of the machine's ceiling and its own rule.
	l.Ceiling = Ceiling{Max: map[string]Action{"edit": Deny}}
	if got := l.ChildCeiling().Of("edit"); got != Deny {
		t.Errorf("child ceiling for edit = %s, want deny (the ceiling is stricter)", got)
	}
}

// The floor also holds the subagents to the machine's own restricting rules —
// a subagent's first tool call can beat the rules galopin applies to its
// session — and only the subagents: the primaries get them as session rules.
func TestLayersFloorHoldsSubagentsToTheMachinesRestrictingRules(t *testing.T) {
	l := Layers{Own: []Rule{{"edit", "*", Ask}, {"bash", "*", Deny}, {"read", "*", Allow}}}
	f := l.Floor()
	agents := f["agent"].(map[string]any)
	perm := func(name string) map[string]any {
		a, ok := agents[name].(map[string]any)
		if !ok {
			return map[string]any{}
		}
		return a["permission"].(map[string]any)
	}
	if perm("general")["edit"] != "ask" || perm("general")["bash"] != "deny" {
		t.Errorf("general floor = %v, want the machine's ask and deny", perm("general"))
	}
	if perm("explore")["edit"] != "deny" {
		t.Errorf("explore edit = %v: the machine's ask softened a read-only agent", perm("explore")["edit"])
	}
	if perm("explore")["bash"] != "deny" {
		t.Errorf("explore bash = %v, want the machine's deny", perm("explore")["bash"])
	}
	if perm("build")["edit"] == "ask" || perm("build")["bash"] == "deny" {
		t.Errorf("build floor = %v: the machine's own rules reach a primary agent as session rules, not as floor", perm("build"))
	}
	if _, ok := f["permission"]; ok {
		t.Errorf("top-level permission = %v, want none (no ceiling deny)", f["permission"])
	}
	if !containsRule(l.FloorRules("general"), Rule{"edit", "*", Ask}) {
		t.Error("FloorRules does not agree with Floor")
	}
	// With no machine rules the primaries' floor is the ceiling's alone.
	c := Ceiling{Max: map[string]Action{"edit": Ask}}
	lf := Layers{Ceiling: c}.Floor()["agent"].(map[string]any)
	cf := c.Floor()["agent"].(map[string]any)
	for _, name := range []string{"build", "plan"} {
		if !reflect.DeepEqual(lf[name], cf[name]) {
			t.Errorf("%s: Layers.Floor %v differs from Ceiling.Floor %v without machine rules", name, lf[name], cf[name])
		}
	}
}

// A subagent starts working before its session has the root's selector, so the
// floor makes its default ask — on a machine with no ceiling and no rules too —
// for exactly the names the blanket moves and its agent grants, never loosening
// anything (a deny stays, a name the agent does not grant is not written).
func TestLayersFloorMakesSubagentsAskByDefault(t *testing.T) {
	f := Layers{}.Floor()["agent"].(map[string]any)
	perm := func(name string) map[string]any {
		a, ok := f[name].(map[string]any)
		if !ok {
			return map[string]any{}
		}
		return a["permission"].(map[string]any)
	}
	for _, k := range []string{"edit", "bash", "webfetch", "websearch", "codesearch", "task"} {
		if perm("general")[k] != "ask" {
			t.Errorf("general %s = %v, want ask", k, perm("general")[k])
		}
	}
	if perm("explore")["bash"] != "ask" || perm("explore")["edit"] != "deny" {
		t.Errorf("explore = %v, want bash ask and its edit deny kept", perm("explore"))
	}
	if _, ok := perm("explore")["task"]; ok {
		t.Error("explore does not grant task: nothing to tighten, and a written ask could only loosen its deny")
	}
	for _, name := range []string{"build", "plan"} {
		if perm(name)["bash"] == "ask" || perm(name)["task"] == "ask" {
			t.Errorf("%s: the primaries get their rules in the session create, not from the floor: %v", name, perm(name))
		}
	}
}

// The machine's own rule for one of galopin's coordination tools is the
// machine's explicit consent (or refusal), which the blanket must not bury —
// except under Deny, where the person has said no.
func TestSelectorKeepsTheMachinesRulesForGalopinsTools(t *testing.T) {
	l := Layers{Own: []Rule{{"session_spawn", "*", Allow}, {"session_send", "*", Ask}}}
	for _, mode := range []Action{Ask, Allow} {
		rules := Compose(l, Selector{Mode: mode}, buildAgent)
		if got := Grant(append(append([]Rule(nil), buildAgent...), rules...), "session_spawn"); got != Allow {
			t.Errorf("%s: session_spawn grant = %s, want the machine's allow", mode, got)
		}
		if got := Grant(append(append([]Rule(nil), buildAgent...), rules...), "session_send"); got != Ask {
			t.Errorf("%s: session_send grant = %s, want the machine's ask", mode, got)
		}
		if got := Grant(append(append([]Rule(nil), buildAgent...), rules...), "session_list"); got != Ask {
			t.Errorf("%s: a tool the machine has no rule for = %s, want ask", mode, got)
		}
	}
	deny := Compose(l, Selector{Mode: Deny}, buildAgent)
	if got := Grant(append(append([]Rule(nil), buildAgent...), deny...), "session_spawn"); got != Deny {
		t.Errorf("Deny: session_spawn grant = %s, want deny (the person's Deny beats the machine's allow)", got)
	}
}

// grantOf is Grant over the agent's rules and what Compose gave the session:
// the answer a coordination tool call gets.
func grantOf(l Layers, sel Selector, tool string) Action {
	return Grant(append(append([]Rule(nil), buildAgent...), Compose(l, sel, buildAgent)...), tool)
}

func TestNormalizeCoordinationAcceptsOnlyTheFourKeys(t *testing.T) {
	got, bad, ok := NormalizeCoordination([]string{"session_spawn", "session_read", "session_read", "session_list", "session_send"})
	if !ok || bad != "" || len(got) != 4 || got[0] != "session_list" || got[1] != "session_read" || got[2] != "session_send" || got[3] != "session_spawn" {
		t.Errorf("got %v bad=%q, want the four, de-duplicated and sorted", got, bad)
	}
	for _, key := range []string{"bash", "edit", "*", "session_*", "task", "", "SESSION_SEND", "external_directory"} {
		if _, bad, ok := NormalizeCoordination([]string{"session_send", key}); ok || bad != key {
			t.Errorf("%q: bad = %q, want it refused", key, bad)
		}
	}
	if got, bad, ok := NormalizeCoordination(nil); got != nil || bad != "" || !ok {
		t.Errorf("an empty list is a clear: got %v %q", got, bad)
	}
}

// A grant allows exactly the keys it names, on Ask and on Allow, and nothing else:
// not the keys it leaves out, and not the opencode tools a blanket moves.
func TestGrantAllowsOnlyTheNamedCoordinationKeys(t *testing.T) {
	for _, mode := range []Action{Ask, Allow} {
		sel := Selector{Mode: mode, Coordination: []string{"session_list", "session_read", "session_send"}}
		for _, k := range []string{"session_list", "session_read", "session_send"} {
			if got := grantOf(Layers{}, sel, k); got != Allow {
				t.Errorf("%s: %s = %s, want allow", mode, k, got)
			}
		}
		if got := grantOf(Layers{}, sel, "session_spawn"); got != Ask {
			t.Errorf("%s: session_spawn = %s, want ask (not granted)", mode, got)
		}
		all := append(append([]Rule(nil), buildAgent...), Compose(Layers{}, sel, buildAgent)...)
		if got := Evaluate(all, "bash", "ls"); got == Allow && mode == Ask {
			t.Errorf("a coordination grant moved bash to allow")
		}
	}
	// A grant of nothing is no grant.
	if got := grantOf(Layers{}, Selector{Coordination: []string{}}, "session_send"); got != Ask {
		t.Errorf("an empty grant = %s, want ask", got)
	}
}

// The machine's ceiling caps a grant like every other rule: ask still asks and
// deny still refuses; a key the ceiling does not name is allowed.
func TestGrantNeverPassesTheCeiling(t *testing.T) {
	sel := Selector{Coordination: []string{"session_read", "session_send", "session_spawn"}}
	l := Layers{Ceiling: Ceiling{Max: map[string]Action{"session_send": Ask, "session_spawn": Deny}}}
	if got := grantOf(l, sel, "session_read"); got != Allow {
		t.Errorf("an uncapped key = %s, want allow", got)
	}
	if got := grantOf(l, sel, "session_send"); got != Ask {
		t.Errorf("a key capped at ask = %s, want ask", got)
	}
	if got := grantOf(l, sel, "session_spawn"); got != Deny {
		t.Errorf("a key capped at deny = %s, want deny", got)
	}
}

// The owner's own rule for a tool is more specific than a caller's grant: an
// ask or deny written on the machine still wins.
func TestGrantDoesNotLoosenTheMachinesOwnRule(t *testing.T) {
	sel := Selector{Coordination: []string{"session_send", "session_read", "session_spawn"}}
	l := Layers{Own: []Rule{{"session_send", "*", Ask}, {"session_read", "*", Deny}}}
	if got := grantOf(l, sel, "session_send"); got != Ask {
		t.Errorf("own ask = %s, want ask", got)
	}
	if got := grantOf(l, sel, "session_read"); got != Deny {
		t.Errorf("own deny = %s, want deny", got)
	}
	if got := grantOf(l, sel, "session_spawn"); got != Allow {
		t.Errorf("no own rule = %s, want the grant's allow", got)
	}
}

// Deny is the person's word: a grant is kept but not applied, and comes back
// with Ask. Clearing it restores ask.
func TestGrantYieldsToDenyAndComesBack(t *testing.T) {
	sel := Selector{Mode: Deny, Coordination: []string{"session_send"}}
	if got := grantOf(Layers{}, sel, "session_send"); got != Deny {
		t.Errorf("under Deny = %s, want deny", got)
	}
	sel.Mode = Ask
	if got := grantOf(Layers{}, sel, "session_send"); got != Allow {
		t.Errorf("back on Ask = %s, want the kept grant", got)
	}
	sel.Coordination = nil
	if got := grantOf(Layers{}, sel, "session_send"); got != Ask {
		t.Errorf("cleared = %s, want ask", got)
	}
}

// A later block beats an earlier one: replacing a grant with a smaller one (or
// none) leaves nothing of the first allowed, even though opencode only appends.
func TestAReplacedGrantLeavesNothingOfTheOldOne(t *testing.T) {
	first := Compose(Layers{}, Selector{Coordination: []string{"session_send", "session_read"}}, buildAgent)
	second := Compose(Layers{}, Selector{Coordination: []string{"session_read"}}, buildAgent)
	all := append(append(append([]Rule(nil), buildAgent...), first...), second...)
	if got := Grant(all, "session_send"); got != Ask {
		t.Errorf("session_send after the grant shrank = %s, want ask", got)
	}
	if got := Grant(all, "session_read"); got != Allow {
		t.Errorf("session_read = %s, want allow", got)
	}
}

// A subagent follows its root's grant, under the child ceiling.
func TestChildFollowsTheRootsGrant(t *testing.T) {
	root := Selector{Coordination: []string{"session_read"}}
	l := Layers{Ceiling: Ceiling{Max: map[string]Action{"session_read": Ask}}}
	child := ChildRules(l, root, buildAgent)
	if got := Grant(append(append([]Rule(nil), buildAgent...), child...), "session_read"); got != Ask {
		t.Errorf("a capped child = %s, want ask", got)
	}
	child = ChildRules(Layers{}, root, buildAgent)
	if got := Grant(append(append([]Rule(nil), buildAgent...), child...), "session_read"); got != Allow {
		t.Errorf("an uncapped child = %s, want the root's grant", got)
	}
}
