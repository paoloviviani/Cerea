package decide

import (
	"testing"

	"galopin/internal/permrules"
)

const ws = "/work/proj"

func pol(limits map[Class]Limit) Policy {
	return Policy{Limits: limits, SafeDirs: []string{"/tmp"}}
}

// one request per class, the shape opencode raises it in.
var classRequests = map[Class]Request{
	ClassEdit:    {Key: "edit", Patterns: []string{"a.go"}, Workspace: ws},
	ClassCommand: {Key: "bash", Patterns: []string{"ls"}, Workspace: ws},
	ClassWeb:     {Key: "websearch", Patterns: []string{"q"}, Workspace: ws},
	ClassOutside: {Key: "external_directory", Patterns: []string{"/etc/*"}, Workspace: ws},
	ClassSecrets: {Key: "read", Patterns: []string{ws + "/.env"}, Workspace: ws},
	ClassAgents:  {Key: "task", Patterns: []string{"general"}, Workspace: ws},
	ClassTools:   {Key: "srv_tool", Patterns: []string{"*"}, Workspace: ws},
	ClassLoop:    {Key: "doom_loop", Patterns: []string{"bash"}, Workspace: ws},
}

// TestEveryClassEveryLimitEverySessionWord is the decision table: for each class,
// each limit the class allows and each session word, the verdict is the
// stricter of the limit and the word's answer, and never looser than either.
func TestEveryClassEveryLimitEverySessionWord(t *testing.T) {
	limits := []Limit{Never, AskLimit, Run, Stop}
	modes := []permrules.Action{permrules.Deny, permrules.Ask, permrules.Allow}
	for _, c := range Classes {
		for _, l := range limits {
			if !c.Allows(l) {
				continue
			}
			for _, m := range modes {
				r := classRequests[c]
				got := Decide(pol(map[Class]Limit{c: l}), State{Mode: m}, r)
				// What the session's word alone says for this request.
				word := Card
				switch {
				case c == ClassAgents: // task is not a change in itself
					word = Once
					if m == permrules.Deny {
						word = Once
					}
				case m == permrules.Deny:
					word = Reject
				case m == permrules.Allow:
					word = Once
				}
				want := word
				switch l {
				case Never, Stop:
					want = Reject
				case AskLimit:
					want = stricter(word, Card)
				}
				if got.Verdict != want {
					t.Errorf("%s limit=%s mode=%s: got %s (%s), want %s", c, l.Word(), m, got.Verdict, got.Step, want)
				}
				if got.Class != c {
					t.Errorf("%s limit=%s mode=%s: labelled %q", c, l.Word(), m, got.Class)
				}
				if got.Verdict == Reject && got.Reason == "" {
					t.Errorf("%s limit=%s mode=%s: a reject needs a reason", c, l.Word(), m)
				}
				if l == Stop && m != permrules.Deny && !got.Stop {
					t.Errorf("%s: a stop limit must mark the result Stop", c)
				}
			}
		}
	}
}

func TestDefaultsReproduceTodaysBehaviour(t *testing.T) {
	p := pol(nil)
	for _, tc := range []struct {
		name string
		s    State
		r    Request
		want Verdict
	}{
		{"ask read", State{}, Request{Key: "read", Patterns: []string{ws + "/a.go"}, Workspace: ws}, Once},
		{"ask edit", State{}, classRequests[ClassEdit], Card},
		{"allow edit", State{Mode: permrules.Allow}, classRequests[ClassEdit], Once},
		{"allow web", State{Mode: permrules.Allow}, classRequests[ClassWeb], Once},
		{"allow mcp", State{Mode: permrules.Allow}, classRequests[ClassTools], Once},
		{"allow bash asks (command=ask)", State{Mode: permrules.Allow}, classRequests[ClassCommand], Card},
		{"allow outside asks", State{Mode: permrules.Allow}, classRequests[ClassOutside], Card},
		{"allow .env asks", State{Mode: permrules.Allow}, classRequests[ClassSecrets], Card},
		{"allow loop asks", State{Mode: permrules.Allow}, classRequests[ClassLoop], Card},
		{"outside read asks", State{}, Request{Key: "read", Patterns: []string{"/etc/passwd"}, Workspace: ws}, Card},
		{"env example is an ordinary read", State{}, Request{Key: "read", Patterns: []string{ws + "/.env.example"}, Workspace: ws}, Once},
		{"plan rejects edit", State{Mode: permrules.Deny}, classRequests[ClassEdit], Reject},
		{"plan reads", State{Mode: permrules.Deny}, Request{Key: "grep", Patterns: []string{"x"}, Workspace: ws}, Once},
		{"plan env read rejected", State{Mode: permrules.Deny}, classRequests[ClassSecrets], Reject},
		{"plan plan-file", State{Mode: permrules.Deny}, Request{Key: "edit", Patterns: []string{".opencode/plans/x.md"}, Workspace: ws}, Once},
		{"todo", State{}, Request{Key: "todowrite", Workspace: ws}, Once},
		{"task", State{}, classRequests[ClassAgents], Once},
	} {
		if got := Decide(p, tc.s, tc.r); got.Verdict != tc.want {
			t.Errorf("%s: got %s/%s, want %s", tc.name, got.Verdict, got.Step, tc.want)
		}
	}
}

func TestOutsideVersusSafeDirs(t *testing.T) {
	safe := Request{Key: "external_directory", Patterns: []string{"/tmp/*"}, Workspace: ws}
	for _, l := range []Limit{Never, AskLimit, Run} {
		p := pol(map[Class]Limit{ClassOutside: l})
		// A safe directory is not "outside": the outside limit does not touch it.
		for _, m := range []permrules.Action{permrules.Ask, permrules.Allow} {
			if got := Decide(p, State{Mode: m}, safe); got.Verdict != Once || got.Step != "safe-dir" || got.Class != "" {
				t.Errorf("outside=%s mode=%s: safe dir got %s/%s class %q", l.Word(), m, got.Verdict, got.Step, got.Class)
			}
		}
		if got := Decide(p, State{Mode: permrules.Deny}, safe); got.Verdict != Once {
			t.Errorf("plan safe dir: %s", got.Verdict)
		}
	}
	// An outside read or edit (a path outside project and safe dirs) is outside.
	for _, r := range []Request{
		{Key: "read", Patterns: []string{"/etc/passwd"}, Workspace: ws},
		{Key: "edit", Patterns: []string{"/etc/x"}, Workspace: ws},
	} {
		if got := Decide(pol(map[Class]Limit{ClassOutside: Never}), State{Mode: permrules.Allow}, r); got.Verdict != Reject || got.Class != ClassOutside {
			t.Errorf("%s outside never: %+v", r.Key, got)
		}
		if got := Decide(pol(map[Class]Limit{ClassOutside: Run}), State{Mode: permrules.Allow}, r); got.Verdict != Once {
			t.Errorf("%s outside run, Allow: %+v", r.Key, got)
		}
		if got := Decide(pol(map[Class]Limit{ClassOutside: Run}), State{Mode: permrules.Ask}, r); got.Verdict != Card {
			t.Errorf("%s outside run, Ask: %+v", r.Key, got)
		}
	}
	// Inside a safe directory an edit is an ordinary edit.
	if got := Decide(pol(nil), State{Mode: permrules.Allow}, Request{Key: "edit", Patterns: []string{"/tmp/x"}, Workspace: ws}); got.Verdict != Once || got.Class != ClassEdit {
		t.Errorf("edit in a safe dir: %+v", got)
	}
}

func TestSecretsAndLoopRestrictions(t *testing.T) {
	if ClassSecrets.Allows(Run) || ClassLoop.Allows(Run) || ClassLoop.Allows(Never) {
		t.Fatal("secrets never runs; loop is ask or stop")
	}
	if !ClassLoop.Allows(Stop) || !ClassLoop.Allows(AskLimit) || !ClassSecrets.Allows(Never) {
		t.Fatal("allowed values are wrong")
	}
	// A limit the class does not allow falls back to the default, never to run.
	p := pol(map[Class]Limit{ClassSecrets: Run, ClassLoop: Run})
	if got := Decide(p, State{Mode: permrules.Allow}, classRequests[ClassSecrets]); got.Verdict != Card {
		t.Errorf("secrets=run in the file must not run: %+v", got)
	}
	if got := Decide(p, State{Mode: permrules.Allow}, classRequests[ClassLoop]); got.Verdict != Card {
		t.Errorf("loop=run in the file must not run: %+v", got)
	}
	// A credential store reached from a command is the secrets class too.
	p = Policy{Protected: NewProtected("/home/u", "/home/u/.config/galopin")}
	got := Decide(p, State{Mode: permrules.Allow}, Request{Key: "read", Patterns: []string{"/home/u/.ssh/id_ed25519"}, Workspace: ws})
	if got.Verdict != Card || got.Class != ClassSecrets {
		t.Errorf("a credential read: %+v", got)
	}
	p.Limits = map[Class]Limit{ClassCommand: Run}
	got = Decide(p, State{Mode: permrules.Allow}, Request{Key: "bash", Patterns: []string{"cat ~/.aws/credentials"}, Workspace: ws})
	if got.Verdict != Card || got.Class != ClassSecrets {
		t.Errorf("a command touching a credential store, command=run: %+v", got)
	}
	// .env wins the label over outside.
	got = Decide(pol(nil), State{Mode: permrules.Allow}, Request{Key: "read", Patterns: []string{"/srv/other/.env"}, Workspace: ws})
	if got.Class != ClassSecrets {
		t.Errorf("an .env read outside the project is labelled %q", got.Class)
	}
}

func TestGalopinsOwnStateIsNeverAllowedWhateverTheLimits(t *testing.T) {
	prot := NewProtected("/home/u", "/home/u/.config/galopin")
	all := map[Class]Limit{ClassEdit: Run, ClassCommand: Run, ClassOutside: Run, ClassTools: Run, ClassAgents: Run}
	p := Policy{Limits: all, Protected: prot}
	for _, r := range []Request{
		{Key: "read", Patterns: []string{"/home/u/.config/galopin/policy.json"}, Workspace: ws},
		{Key: "edit", Patterns: []string{"/home/u/.config/galopin/policy.json"}, Workspace: ws},
		{Key: "edit", Patterns: []string{"/home/u/.config/opencode/opencode.json"}, Workspace: ws},
		{Key: "bash", Patterns: []string{"sed -i s/ask/allow/ ~/.config/galopin/policy.json"}, Workspace: ws},
		{Key: "external_directory", Patterns: []string{"/home/u/.local/share/opencode/*"}, Workspace: ws},
	} {
		for _, m := range []permrules.Action{permrules.Deny, permrules.Ask, permrules.Allow} {
			got := Decide(p, State{Mode: m, Exceptions: []permrules.Exception{{Permission: r.Key, Patterns: []string{"*"}}}}, r)
			if got.Verdict != Reject || got.Step != "floor" {
				t.Errorf("%s %v mode %s: got %s/%s, want floor reject", r.Key, r.Patterns, m, got.Verdict, got.Step)
			}
		}
	}
	// An ordinary file in the project is not caught by the floor.
	if got := Decide(p, State{Mode: permrules.Allow}, Request{Key: "edit", Patterns: []string{"a.go"}, Workspace: ws}); got.Verdict != Once {
		t.Errorf("project edit: %+v", got)
	}
}

func TestAnAskLimitIsNotLiftedByAnException(t *testing.T) {
	ex := []permrules.Exception{{ID: "e", Permission: "bash", Patterns: []string{"go test *"}}}
	r := Request{Key: "bash", Patterns: []string{"go test ./..."}, Workspace: ws}
	if got := Decide(pol(map[Class]Limit{ClassCommand: AskLimit}), State{Exceptions: ex}, r); got.Verdict != Card {
		t.Errorf("command=ask with an exception: %+v", got)
	}
	got := Decide(pol(map[Class]Limit{ClassCommand: Run}), State{Exceptions: ex}, r)
	if got.Verdict != Once || got.Step != "exception" {
		t.Errorf("command=run with an exception: %+v", got)
	}
	if got := Decide(pol(map[Class]Limit{ClassCommand: Never}), State{Exceptions: ex}, r); got.Verdict != Reject {
		t.Errorf("command=never with an exception: %+v", got)
	}
}

func TestAnOverAskExceptionHoldsUnderAnAskLimitExceptForLoopNeverAndPlan(t *testing.T) {
	ex := []permrules.Exception{{ID: "e", Permission: "bash", Patterns: []string{"go test *"}, OverAsk: true}}
	r := Request{Key: "bash", Patterns: []string{"go test ./..."}, Workspace: ws}
	got := Decide(pol(map[Class]Limit{ClassCommand: AskLimit}), State{Exceptions: ex}, r)
	if got.Verdict != Once || got.Step != "exception-ask" {
		t.Errorf("ask limit with an OverAsk exception: %+v", got)
	}
	if got := Decide(pol(map[Class]Limit{ClassCommand: Never}), State{Exceptions: ex}, r); got.Verdict != Reject {
		t.Errorf("never: %+v", got)
	}
	if got := Decide(pol(map[Class]Limit{ClassCommand: AskLimit}), State{Mode: permrules.Deny, Exceptions: ex}, r); got.Verdict != Reject {
		t.Errorf("plan: %+v", got)
	}
	loop := []permrules.Exception{{ID: "l", Permission: "doom_loop", Patterns: []string{"*"}, OverAsk: true}}
	lr := Request{Key: "doom_loop", Patterns: []string{"*"}, Workspace: ws}
	if got := Decide(pol(map[Class]Limit{ClassLoop: AskLimit}), State{Mode: permrules.Allow, Exceptions: loop}, lr); got.Verdict != Card {
		t.Errorf("loop: %+v", got)
	}
	if AskAlwaysOK(pol(map[Class]Limit{ClassLoop: AskLimit}), lr) {
		t.Error("AskAlwaysOK for loop")
	}
	if !AskAlwaysOK(pol(map[Class]Limit{ClassCommand: AskLimit}), r) || AskAlwaysOK(pol(map[Class]Limit{ClassCommand: Run}), r) || AskAlwaysOK(pol(map[Class]Limit{ClassCommand: Never}), r) {
		t.Error("AskAlwaysOK limit handling")
	}
}

func TestClassOfLabelsEveryRequest(t *testing.T) {
	for c, r := range classRequests {
		if got := ClassOf(pol(nil), r); got != c {
			t.Errorf("%s request labelled %q", c, got)
		}
	}
	if got := ClassOf(pol(nil), Request{Key: "read", Patterns: []string{ws + "/a.go"}, Workspace: ws}); got != "" {
		t.Errorf("an in-project read has no class, got %q", got)
	}
	if got := ClassOf(pol(nil), Request{Key: "session_send", Workspace: ws}); got != ClassAgents {
		t.Errorf("session_send: %q", got)
	}
}

// With the open question about Ask callers answered the other way, the rank
// rule frees them too: the rule itself, target by target.
func TestAgentsRankRuleForAskCallersIfTheOwnerWantsIt(t *testing.T) {
	askCallersAreFree = true
	defer func() { askCallersAreFree = false }()
	for _, tc := range []struct {
		target permrules.Action
		want   permrules.Action
	}{{permrules.Deny, permrules.Allow}, {permrules.Ask, permrules.Allow}, {permrules.Allow, permrules.Ask}} {
		if got, _ := CoordinationFor(Policy{}, State{Mode: permrules.Ask}, "session_send", false, tc.target); got != tc.want {
			t.Errorf("Ask caller to %s target: %s, want %s", tc.target, got, tc.want)
		}
	}
	if got, _ := CoordinationFor(Policy{Limits: map[Class]Limit{ClassAgents: AskLimit}}, State{Mode: permrules.Ask}, "session_send", false, permrules.Deny); got != permrules.Ask {
		t.Errorf("agents=ask still wins: %s", got)
	}
}

func TestCoordinationTool(t *testing.T) {
	grant := State{Coordination: []string{"session_read", "session_send"}}
	lim := func(l Limit) Policy { return Policy{Limits: map[Class]Limit{ClassAgents: l}} }
	tests := []struct {
		name     string
		p        Policy
		s        State
		key      string
		delegate bool
		target   permrules.Action
		want     permrules.Action
	}{
		{"an Ask caller's spawn still asks (see askCallersAreFree)", Policy{}, State{}, "session_spawn", false, permrules.Ask, permrules.Ask},
		{"allow spawn", Policy{}, State{Mode: permrules.Allow}, "session_spawn", false, permrules.Allow, permrules.Allow},
		{"no target, Ask: the word applies", Policy{}, State{}, "session_spawn", false, "", permrules.Ask},
		{"allow send, no target", Policy{}, State{Mode: permrules.Allow}, "session_send", false, "", permrules.Allow},
		{"allow read with no target is grant-gated", Policy{}, State{Mode: permrules.Allow}, "session_read", false, "", permrules.Ask},
		{"list needs no approval", Policy{}, State{}, "session_list", false, "", permrules.Allow},
		{"grant read", Policy{}, grant, "session_read", false, "", permrules.Allow},
		{"grant does not cover spawn", Policy{}, grant, "session_spawn", false, "", permrules.Ask},
		{"plan refuses", Policy{}, State{Mode: permrules.Deny, Coordination: []string{"session_send"}}, "session_send", false, permrules.Deny, permrules.Deny},
		// the agents rank rule
		{"Ask sends to a more cautious Plan session: still asks", Policy{}, State{Mode: permrules.Ask}, "session_send", false, permrules.Deny, permrules.Ask},
		{"Ask sends to an Ask session: still asks", Policy{}, State{Mode: permrules.Ask}, "session_send", false, permrules.Ask, permrules.Ask},
		{"Ask sends to an Allow session: the session word applies", Policy{}, State{Mode: permrules.Ask}, "session_send", false, permrules.Allow, permrules.Ask},
		{"Allow sends to an Ask session: free", Policy{}, State{Mode: permrules.Allow}, "session_send", false, permrules.Ask, permrules.Allow},
		{"Allow reads an Ask session: free", Policy{}, State{Mode: permrules.Allow}, "session_read", false, permrules.Ask, permrules.Allow},
		{"Ask reads an Allow session: asks", Policy{}, State{Mode: permrules.Ask}, "session_read", false, permrules.Allow, permrules.Ask},
		// the agents limit
		{"agents=ask beats the rank rule", lim(AskLimit), State{Mode: permrules.Allow}, "session_send", false, permrules.Ask, permrules.Ask},
		{"agents=ask beats a grant", lim(AskLimit), grant, "session_send", false, "", permrules.Ask},
		{"agents=never", lim(Never), State{Mode: permrules.Allow}, "session_send", false, permrules.Ask, permrules.Deny},
		{"agents=never beats a delegate", lim(Never), State{}, "session_read", true, "", permrules.Deny},
		{"agents=ask beats a delegate", lim(AskLimit), State{}, "session_read", true, "", permrules.Ask},
		{"machine ask beats grant", Policy{Own: []permrules.Rule{{Permission: "session_send", Pattern: "*", Action: permrules.Ask}}}, grant, "session_send", false, "", permrules.Ask},
		{"machine allow", Policy{Own: []permrules.Rule{{Permission: "session_read", Pattern: "*", Action: permrules.Allow}}}, State{}, "session_read", false, "", permrules.Allow},
		{"delegate read in ask", Policy{}, State{}, "session_read", true, "", permrules.Allow},
		{"a Plan spawner's send to its delegate is rejected", Policy{}, State{Mode: permrules.Deny}, "session_send", true, "", permrules.Deny},
		{"a Plan spawner reads its delegate", Policy{}, State{Mode: permrules.Deny}, "session_read", true, "", permrules.Allow},
		{"a Plan caller's spawn is rejected, delegate or not", Policy{}, State{Mode: permrules.Deny}, "session_spawn", true, permrules.Deny, permrules.Deny},
		{"a Plan caller's schedule is rejected", Policy{}, State{Mode: permrules.Deny}, "schedule", true, "", permrules.Deny},
		{"an Ask spawner's send to its delegate is once", Policy{}, State{}, "session_send", true, "", permrules.Allow},
	}
	for _, tc := range tests {
		got, _ := CoordinationFor(tc.p, tc.s, tc.key, tc.delegate, tc.target)
		if got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}
}
