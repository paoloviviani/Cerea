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

func TestCeilingIgnoresWildcardAndInvalidKeys(t *testing.T) {
	c := Ceiling{Max: map[string]Action{"*": Deny, "edit": "nonsense", "bash": Ask}}
	if got := c.Keys(); !reflect.DeepEqual(got, []string{"bash"}) {
		t.Errorf("Keys = %v, want [bash]", got)
	}
	if c.Of("edit") != Allow {
		t.Error("an invalid ceiling value must not cap")
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

// The permissiveness lattice (ADR 0105): deny < ask < auto < allow. An Allow
// session may start Auto runs; an Ask session may not.
func TestWordLattice(t *testing.T) {
	order := []string{"deny", "ask", "auto", "allow"}
	for i, lo := range order {
		for j, hi := range order {
			if got := WordWithin(lo, hi); got != (i <= j) {
				t.Errorf("WordWithin(%s, %s) = %v, want %v", lo, hi, got, i <= j)
			}
		}
	}
	if !WordWithin("auto", "allow") || WordWithin("auto", "ask") {
		t.Error("an Allow session may schedule auto runs; an Ask session may not")
	}
	if !WordWithin("plan", "ask") || WordWithin("sudo", "allow") || WordWithin("allow", "sudo") {
		t.Error("plan is deny's alias; an unknown word is within nothing")
	}
}

func TestSelectorWordAndAuto(t *testing.T) {
	if (Selector{}).Word() != "ask" || (Selector{Mode: Deny}).Word() != "deny" || (Selector{Mode: Allow}).Word() != "allow" {
		t.Error("the three old words read as they did")
	}
	if (Selector{Mode: Ask, Auto: true}).Word() != "auto" || (Selector{Auto: true}).Word() != "auto" {
		t.Error("Auto with ask (or nothing set) is auto")
	}
	// Auto never lifts a stricter word: a Plan session with a stray flag stays Plan.
	if (Selector{Mode: Deny, Auto: true}).Word() != "deny" {
		t.Error("Plan beats a stray auto flag")
	}
}
