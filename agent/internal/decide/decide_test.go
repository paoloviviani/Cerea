package decide

import (
	"testing"

	"galopin/internal/permrules"
)

const ws = "/work/proj"

func pol(deny ...Class) Policy {
	d := map[Class]bool{}
	for _, c := range deny {
		d[c] = true
	}
	return Policy{Deny: d, SafeDirs: []string{"/tmp"}}
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

// TestWordFloorDenyTable is the decision table (ADR 0109): every class, every
// session word, with and without a local deny. No class limits exist: the word
// decides, the floor lifts a run to a card on credentials, loop alerts (and git
// and CI writes, tested below), and a local deny refuses.
func TestWordFloorDenyTable(t *testing.T) {
	modes := []permrules.Action{permrules.Deny, permrules.Ask, permrules.Allow}
	for _, c := range Classes {
		for _, m := range modes {
			r := classRequests[c]
			want := Card
			switch {
			case c == ClassAgents: // task is not a change in itself
				want = Once
			case m == permrules.Deny:
				want = Reject
			case m == permrules.Allow && c != ClassSecrets && c != ClassLoop:
				want = Once
			}
			got := Decide(pol(), State{Mode: m}, r)
			if got.Verdict != want {
				t.Errorf("%s mode=%s: got %s (%s), want %s", c, m, got.Verdict, got.Step, want)
			}
			if got.Class != c {
				t.Errorf("%s mode=%s: labelled %q", c, m, got.Class)
			}
			if got.Verdict == Reject && got.Reason == "" {
				t.Errorf("%s mode=%s: a reject needs a reason", c, m)
			}
			// A local deny refuses whatever the word, except the classes that are
			// not requests of their own (agents' task, the loop alert).
			dg := Decide(pol(c), State{Mode: m}, r)
			if c == ClassLoop {
				continue
			}
			if dg.Verdict != Reject || dg.Step != "deny" {
				t.Errorf("%s mode=%s deny: got %s/%s, want deny reject", c, m, dg.Verdict, dg.Step)
			}
		}
	}
}

func TestDenyOnlyRefuses(t *testing.T) {
	// Denying one class never touches another.
	if got := Decide(pol(ClassCommand), State{Mode: permrules.Allow}, classRequests[ClassEdit]); got.Verdict != Once {
		t.Errorf("edit with command denied: %+v", got)
	}
	if ClassLoop.Denyable() {
		t.Error("loop must not be denyable")
	}
	if _, err := ParseDeny("loop"); err == nil {
		t.Error("ParseDeny(loop) should fail")
	}
	if _, err := ParseDeny("nonsense"); err == nil {
		t.Error("ParseDeny(nonsense) should fail")
	}
}

func TestWordsWithoutLimits(t *testing.T) {
	p := pol()
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
		{"allow bash runs", State{Mode: permrules.Allow}, classRequests[ClassCommand], Once},
		{"allow outside runs", State{Mode: permrules.Allow}, classRequests[ClassOutside], Once},
		{"allow .env is a card", State{Mode: permrules.Allow}, classRequests[ClassSecrets], Card},
		{"allow loop is a card", State{Mode: permrules.Allow}, classRequests[ClassLoop], Card},
		{"outside read asks", State{}, Request{Key: "read", Patterns: []string{"/etc/passwd"}, Workspace: ws}, Card},
		{"allow outside read runs", State{Mode: permrules.Allow}, Request{Key: "read", Patterns: []string{"/etc/passwd"}, Workspace: ws}, Once},
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

func TestAutoRunsOnlyTheClassesItsMapSays(t *testing.T) {
	runs := AutoRunSet(map[string]string{"edit": "run", "web": "run", "command": "ask", "secrets": "run", "loop": "run", "bogus": "run", "tools": "RUN"})
	if runs[ClassSecrets] || runs[ClassLoop] || runs[ClassCommand] || runs[ClassTools] || len(runs) != 2 {
		t.Fatalf("AutoRunSet: %v", runs)
	}
	auto := State{Mode: permrules.Ask, Auto: true, AutoRun: runs}
	for _, tc := range []struct {
		c    Class
		want Verdict
	}{{ClassEdit, Once}, {ClassWeb, Once}, {ClassCommand, Card}, {ClassOutside, Card}, {ClassSecrets, Card}, {ClassTools, Card}, {ClassLoop, Card}} {
		if got := Decide(pol(), auto, classRequests[tc.c]); got.Verdict != tc.want {
			t.Errorf("auto %s: got %s/%s, want %s", tc.c, got.Verdict, got.Step, tc.want)
		}
	}
	// Fail closed: an Auto session with no map runs nothing that is a class.
	if got := Decide(pol(), State{Mode: permrules.Ask, Auto: true}, classRequests[ClassEdit]); got.Verdict != Card {
		t.Errorf("auto with no map: %+v", got)
	}
	// In-project reads still run, and the floor and a local deny still apply.
	if got := Decide(pol(), auto, Request{Key: "read", Patterns: []string{ws + "/a.go"}, Workspace: ws}); got.Verdict != Once {
		t.Errorf("auto read: %+v", got)
	}
	if got := Decide(pol(ClassEdit), auto, classRequests[ClassEdit]); got.Verdict != Reject {
		t.Errorf("auto with edit denied: %+v", got)
	}
	pr := Policy{Protected: NewProtected("/home/u", "/home/u/.config/galopin")}
	if got := Decide(pr, auto, Request{Key: "edit", Patterns: []string{".git/config"}, Workspace: ws}); got.Verdict != Card {
		t.Errorf("auto .git write: %+v", got)
	}
	if got := Decide(pr, auto, Request{Key: "edit", Patterns: []string{"/home/u/.config/galopin/policy.json"}, Workspace: ws}); got.Verdict != Reject {
		t.Errorf("auto own state: %+v", got)
	}
	// A request in several classes runs only when all of them run.
	multi := Request{Key: "read", Patterns: []string{"/srv/x/.env"}, Workspace: ws}
	if got := Decide(pol(), State{Mode: permrules.Ask, Auto: true, AutoRun: AutoRunSet(map[string]string{"outside": "run"})}, multi); got.Verdict != Card {
		t.Errorf("outside+secrets: %+v", got)
	}
	// Coordination and connector calls follow the map too.
	if a, _ := ConnectorCall(pol(), State{Mode: permrules.Ask, Auto: true, AutoRun: AutoRunSet(map[string]string{"tools": "run"})}, false); a != permrules.Allow {
		t.Errorf("connector call, tools run: %s", a)
	}
	if a, _ := ConnectorCall(pol(), auto, false); a != permrules.Ask {
		t.Errorf("connector call, tools ask: %s", a)
	}
	if a, _ := CoordinationFor(pol(), State{Mode: permrules.Ask, Auto: true, AutoRun: AutoRunSet(map[string]string{"agents": "run"})}, "session_send", false, ""); a != permrules.Allow {
		t.Errorf("coordination, agents run: %s", a)
	}
}

func TestSecretsAndLoopAreCardsEvenOnAllow(t *testing.T) {
	// A credential store reached from a command is the secrets class too.
	p := Policy{Protected: NewProtected("/home/u", "/home/u/.config/galopin")}
	got := Decide(p, State{Mode: permrules.Allow}, Request{Key: "read", Patterns: []string{"/home/u/.ssh/id_ed25519"}, Workspace: ws})
	if got.Verdict != Card || got.Class != ClassSecrets {
		t.Errorf("a credential read: %+v", got)
	}
	got = Decide(p, State{Mode: permrules.Allow}, Request{Key: "bash", Patterns: []string{"cat ~/.aws/credentials"}, Workspace: ws})
	if got.Verdict != Card || got.Class != ClassSecrets {
		t.Errorf("a command touching a credential store: %+v", got)
	}
	// .env wins the label over outside.
	got = Decide(pol(), State{Mode: permrules.Allow}, Request{Key: "read", Patterns: []string{"/srv/other/.env"}, Workspace: ws})
	if got.Class != ClassSecrets {
		t.Errorf("an .env read outside the project is labelled %q", got.Class)
	}
}

func TestGalopinsOwnStateIsNeverAllowed(t *testing.T) {
	prot := NewProtected("/home/u", "/home/u/.config/galopin")
	p := Policy{Protected: prot}
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

func TestExceptions(t *testing.T) {
	ex := []permrules.Exception{{ID: "e", Permission: "bash", Patterns: []string{"go test *"}}}
	r := Request{Key: "bash", Patterns: []string{"go test ./..."}, Workspace: ws}
	got := Decide(pol(), State{Exceptions: ex}, r)
	if got.Verdict != Once || got.Step != "exception" {
		t.Errorf("an exception: %+v", got)
	}
	if got := Decide(pol(ClassCommand), State{Exceptions: ex}, r); got.Verdict != Reject {
		t.Errorf("command denied with an exception: %+v", got)
	}
	// A credential ask only stands on a human's (OverAsk) exception; plan and
	// loop never.
	env := Request{Key: "read", Patterns: []string{ws + "/.env"}, Workspace: ws}
	plain := []permrules.Exception{{ID: "e", Permission: "read", Patterns: []string{"*"}}}
	if got := Decide(pol(), State{Mode: permrules.Allow, Exceptions: plain}, env); got.Verdict != Card {
		t.Errorf(".env with a plain exception: %+v", got)
	}
	over := []permrules.Exception{{ID: "e", Permission: "read", Patterns: []string{ws + "/.env"}, OverAsk: true}}
	if got := Decide(pol(), State{Exceptions: over}, env); got.Verdict != Once || got.Step != "exception-ask" {
		t.Errorf(".env with a human's exception: %+v", got)
	}
	if got := Decide(pol(), State{Mode: permrules.Deny, Exceptions: over}, env); got.Verdict != Reject {
		t.Errorf("plan: %+v", got)
	}
	loop := []permrules.Exception{{ID: "l", Permission: "doom_loop", Patterns: []string{"*"}, OverAsk: true}}
	lr := classRequests[ClassLoop]
	if got := Decide(pol(), State{Mode: permrules.Allow, Exceptions: loop}, lr); got.Verdict != Card {
		t.Errorf("loop: %+v", got)
	}
	if AskAlwaysOK(pol(), lr) || !AskAlwaysOK(pol(), env) || AskAlwaysOK(pol(), r) {
		t.Error("AskAlwaysOK: only a credential ask is over-ask")
	}
}

func TestClassOfLabelsEveryRequest(t *testing.T) {
	for c, r := range classRequests {
		if got := ClassOf(pol(), r); got != c {
			t.Errorf("%s request labelled %q", c, got)
		}
	}
	if got := ClassOf(pol(), Request{Key: "read", Patterns: []string{ws + "/a.go"}, Workspace: ws}); got != "" {
		t.Errorf("an in-project read has no class, got %q", got)
	}
	if got := ClassOf(pol(), Request{Key: "session_send", Workspace: ws}); got != ClassAgents {
		t.Errorf("session_send: %q", got)
	}
}

func TestCoordinationTool(t *testing.T) {
	grant := State{Coordination: []string{"session_read", "session_send"}}
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
		{"Ask sends to a more cautious Plan session: still asks", Policy{}, State{Mode: permrules.Ask}, "session_send", false, permrules.Deny, permrules.Ask},
		{"Ask sends to an Allow session: the session word applies", Policy{}, State{Mode: permrules.Ask}, "session_send", false, permrules.Allow, permrules.Ask},
		{"Allow sends to an Ask session: free", Policy{}, State{Mode: permrules.Allow}, "session_send", false, permrules.Ask, permrules.Allow},
		{"Allow reads an Ask session: free", Policy{}, State{Mode: permrules.Allow}, "session_read", false, permrules.Ask, permrules.Allow},
		{"Ask reads an Allow session: asks", Policy{}, State{Mode: permrules.Ask}, "session_read", false, permrules.Allow, permrules.Ask},
		{"agents denied locally", pol(ClassAgents), State{Mode: permrules.Allow}, "session_send", false, permrules.Ask, permrules.Deny},
		{"agents denied beats a delegate", pol(ClassAgents), State{}, "session_read", true, "", permrules.Deny},
		{"delegate read in ask", Policy{}, State{}, "session_read", true, "", permrules.Allow},
		{"a Plan spawner's send to its delegate is rejected", Policy{}, State{Mode: permrules.Deny}, "session_send", true, "", permrules.Deny},
		{"a Plan spawner reads its delegate", Policy{}, State{Mode: permrules.Deny}, "session_read", true, "", permrules.Allow},
		{"a Plan caller's spawn is rejected, delegate or not", Policy{}, State{Mode: permrules.Deny}, "session_spawn", true, permrules.Deny, permrules.Deny},
		{"a Plan caller's schedule is rejected", Policy{}, State{Mode: permrules.Deny}, "schedule", true, "", permrules.Deny},
		{"an Ask spawner's send to its delegate is once", Policy{}, State{}, "session_send", true, "", permrules.Allow},
	}
	for _, tc := range tests {
		got, reason := CoordinationFor(tc.p, tc.s, tc.key, tc.delegate, tc.target)
		if got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
		if got == permrules.Deny && reason == "" {
			t.Errorf("%s: a refusal without a reason", tc.name)
		}
	}
}

// ConnectorCall is the tools class for galopin's connector tools (ADR 0108):
// the session's word decides, a local deny refuses, reading the list is free.
func TestConnectorCallDecision(t *testing.T) {
	type row struct {
		deny bool
		mode permrules.Action
		list bool
		want permrules.Action
	}
	for _, c := range []row{
		{false, permrules.Allow, false, permrules.Allow},
		{false, permrules.Ask, false, permrules.Ask},
		{false, permrules.Deny, false, permrules.Deny},
		{true, permrules.Allow, false, permrules.Deny},
		{false, permrules.Deny, true, permrules.Allow},
		{false, permrules.Ask, true, permrules.Allow},
		{true, permrules.Allow, true, permrules.Deny},
	} {
		p := pol()
		if c.deny {
			p = pol(ClassTools)
		}
		got, reason := ConnectorCall(p, State{Mode: c.mode}, c.list)
		if got != c.want {
			t.Errorf("deny %v mode %s list %v: got %s, want %s", c.deny, c.mode, c.list, got, c.want)
		}
		if got == permrules.Deny && reason == "" {
			t.Errorf("deny %v mode %s: a refusal without a reason", c.deny, c.mode)
		}
	}
}
