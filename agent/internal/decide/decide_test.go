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
	return Policy{Deny: d, SafeDirs: []string{"/tmp"}, Protected: NewProtected("/home/u", "/home/u/.config/galopin")}
}

// one request per class, the shape opencode raises it in.
var classRequests = map[Class]Request{
	ClassEdit:    {Key: "edit", Patterns: []string{"a.go"}, Workspace: ws},
	ClassCommand: {Key: "bash", Patterns: []string{"ls"}, Workspace: ws},
	ClassWeb:     {Key: "websearch", Patterns: []string{"q"}, Workspace: ws},
	ClassOutside: {Key: "external_directory", Patterns: []string{"/etc/*"}, Workspace: ws},
	// a credential store (a .env file's name alone is not a credential on Allow)
	ClassSecrets: {Key: "read", Patterns: []string{"/home/u/.ssh/id_rsa"}, Workspace: ws},
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
			case m == permrules.Allow: // Allow never asks
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
	if got := Decide(pol(ClassCommand), autoAll(), classRequests[ClassEdit]); got.Verdict != Once {
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
		{"auto (all rows run) edit", autoAll(), classRequests[ClassEdit], Once},
		{"auto (all rows run) web", autoAll(), classRequests[ClassWeb], Once},
		{"auto (all rows run) mcp", autoAll(), classRequests[ClassTools], Once},
		{"auto (all rows run) bash runs", autoAll(), classRequests[ClassCommand], Once},
		{"auto (all rows run) outside runs", autoAll(), classRequests[ClassOutside], Once},
		{"auto (all rows run): a credential store is a card", autoAll(), classRequests[ClassSecrets], Card},
		{"auto (all rows run) loop is a card", autoAll(), classRequests[ClassLoop], Card},
		{"outside read asks", State{}, Request{Key: "read", Patterns: []string{"/etc/passwd"}, Workspace: ws}, Card},
		{"auto (all rows run) outside read runs", autoAll(), Request{Key: "read", Patterns: []string{"/etc/passwd"}, Workspace: ws}, Once},
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
	multi := Request{Key: "read", Patterns: []string{"/home/u/.ssh/id_rsa"}, Workspace: ws}
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
	autoRun := State{Mode: permrules.Ask, Auto: true, AutoRun: AutoRunSet(map[string]string{"agents": "run"})}
	for _, key := range []string{"session_read", "session_send", "session_spawn"} {
		if a, _ := CoordinationFor(pol(), autoRun, key, false, "", false); a != permrules.Allow {
			t.Errorf("Auto, agents row Runs, %s: %s, want allow", key, a)
		}
		if a, _ := CoordinationFor(pol(), auto, key, false, "", false); a != permrules.Ask {
			t.Errorf("Auto, agents row not Runs, %s: %s, want ask", key, a)
		}
	}
	if a, _ := CoordinationFor(pol(), autoRun, "session_list", false, "", false); a != permrules.Allow {
		t.Errorf("Auto session_list: %s", a)
	}
	if a, _ := CoordinationFor(pol(), autoRun, "schedule", false, autoRun.Mode, false); a != permrules.Allow {
		t.Errorf("Auto, agents run, schedule: %s", a)
	}
}

func TestSecretsAndLoopAreCardsEvenOnAllow(t *testing.T) {
	// A credential store reached from a command is the secrets class too.
	p := Policy{Protected: NewProtected("/home/u", "/home/u/.config/galopin")}
	got := Decide(p, autoAll(), Request{Key: "read", Patterns: []string{"/home/u/.ssh/id_ed25519"}, Workspace: ws})
	if got.Verdict != Card || got.Class != ClassSecrets {
		t.Errorf("a credential read: %+v", got)
	}
	got = Decide(p, autoAll(), Request{Key: "bash", Patterns: []string{"cat ~/.aws/credentials"}, Workspace: ws})
	if got.Verdict != Card || got.Class != ClassSecrets {
		t.Errorf("a command touching a credential store: %+v", got)
	}
	// On Ask a .env read outside the project is a secrets card (the name wins the label
	// over outside); on Allow it is an ordinary outside read.
	got = Decide(pol(), State{Mode: permrules.Ask}, Request{Key: "read", Patterns: []string{"/srv/other/.env"}, Workspace: ws})
	if got.Verdict != Card || got.Class != ClassSecrets {
		t.Errorf("an .env read outside the project on Ask: %+v", got)
	}
	got = Decide(pol(), autoAll(), Request{Key: "read", Patterns: []string{"/srv/other/.env"}, Workspace: ws})
	if got.Verdict != Once || got.Class != ClassOutside {
		t.Errorf("an .env read outside the project on Allow: %+v", got)
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
	if got := Decide(p, autoAll(), Request{Key: "edit", Patterns: []string{"a.go"}, Workspace: ws}); got.Verdict != Once {
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
	env := Request{Key: "read", Patterns: []string{"/home/u/.ssh/id_rsa"}, Workspace: ws}
	plain := []permrules.Exception{{ID: "e", Permission: "read", Patterns: []string{"*"}}}
	if got := Decide(pol(), func() State { s := autoAll(); s.Exceptions = plain; return s }(), env); got.Verdict != Card {
		t.Errorf(".env with a plain exception: %+v", got)
	}
	over := []permrules.Exception{{ID: "e", Permission: "read", Patterns: []string{"/home/u/.ssh/id_rsa"}, OverAsk: true}}
	if got := Decide(pol(), State{Exceptions: over}, env); got.Verdict != Once || got.Step != "exception-ask" {
		t.Errorf(".env with a human's exception: %+v", got)
	}
	if got := Decide(pol(), State{Mode: permrules.Deny, Exceptions: over}, env); got.Verdict != Reject {
		t.Errorf("plan: %+v", got)
	}
	loop := []permrules.Exception{{ID: "l", Permission: "doom_loop", Patterns: []string{"*"}, OverAsk: true}}
	lr := classRequests[ClassLoop]
	if got := Decide(pol(), func() State { s := autoAll(); s.Exceptions = loop; return s }(), lr); got.Verdict != Card {
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
		{"allow spawn", Policy{}, autoAll(), "session_spawn", false, permrules.Allow, permrules.Allow},
		{"no target, Ask: the word applies", Policy{}, State{}, "session_spawn", false, "", permrules.Ask},
		{"allow send, no target", Policy{}, autoAll(), "session_send", false, "", permrules.Allow},
		{"allow read with no target runs", Policy{}, autoAll(), "session_read", false, "", permrules.Allow},
		{"list needs no approval", Policy{}, State{}, "session_list", false, "", permrules.Allow},
		{"ask read asks", Policy{}, State{}, "session_read", false, "", permrules.Ask},
		{"explicit allow runs on Ask", Policy{}, State{Exceptions: []permrules.Exception{{ID: "e", Permission: "session_send", Patterns: []string{"*"}}}}, "session_send", false, "", permrules.Allow},
		{"explicit allow is for its own tool only", Policy{}, State{Exceptions: []permrules.Exception{{ID: "e", Permission: "session_send", Patterns: []string{"*"}}}}, "session_spawn", false, "", permrules.Ask},
		{"explicit allow runs on Auto not running agents", Policy{}, State{Auto: true, Exceptions: []permrules.Exception{{ID: "e", Permission: "session_spawn", Patterns: []string{"*"}}}}, "session_spawn", false, "", permrules.Allow},
		{"plan still refuses an explicit allow", Policy{}, State{Mode: permrules.Deny, Exceptions: []permrules.Exception{{ID: "e", Permission: "session_send", Patterns: []string{"*"}}}}, "session_send", false, permrules.Allow, permrules.Deny},
		{"a local deny beats an explicit allow", pol(ClassAgents), State{Exceptions: []permrules.Exception{{ID: "e", Permission: "session_send", Patterns: []string{"*"}}}}, "session_send", false, "", permrules.Deny},
		{"plan refuses", Policy{}, State{Mode: permrules.Deny}, "session_send", false, permrules.Deny, permrules.Deny},
		{"Ask sends to a more cautious Plan session: still asks", Policy{}, State{Mode: permrules.Ask}, "session_send", false, permrules.Deny, permrules.Ask},
		{"Ask sends to an Allow session: the session word applies", Policy{}, State{Mode: permrules.Ask}, "session_send", false, permrules.Allow, permrules.Ask},
		{"Allow sends to an Ask session: free", Policy{}, autoAll(), "session_send", false, permrules.Ask, permrules.Allow},
		{"Allow reads an Ask session: free", Policy{}, autoAll(), "session_read", false, permrules.Ask, permrules.Allow},
		{"Ask reads an Allow session: asks", Policy{}, State{Mode: permrules.Ask}, "session_read", false, permrules.Allow, permrules.Ask},
		{"agents denied locally", pol(ClassAgents), autoAll(), "session_send", false, permrules.Ask, permrules.Deny},
		{"agents denied beats a delegate", pol(ClassAgents), State{}, "session_read", true, "", permrules.Deny},
		{"delegate read in ask", Policy{}, State{}, "session_read", true, "", permrules.Allow},
		{"a Plan spawner's send to its delegate is rejected", Policy{}, State{Mode: permrules.Deny}, "session_send", true, "", permrules.Deny},
		{"a Plan spawner reads its delegate", Policy{}, State{Mode: permrules.Deny}, "session_read", true, "", permrules.Allow},
		{"a Plan caller's spawn is rejected, delegate or not", Policy{}, State{Mode: permrules.Deny}, "session_spawn", true, permrules.Deny, permrules.Deny},
		{"a Plan caller's schedule is rejected", Policy{}, State{Mode: permrules.Deny}, "schedule", true, "", permrules.Deny},
		{"an Ask spawner's send to its delegate is once", Policy{}, State{}, "session_send", true, "", permrules.Allow},
	}
	for _, tc := range tests {
		got, reason := CoordinationFor(tc.p, tc.s, tc.key, tc.delegate, tc.target, false)
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

// An external_directory exception covers a read of that directory, never a write.
func TestExternalDirectoryExceptionCoversReadsNotEdits(t *testing.T) {
	exs := []permrules.Exception{{ID: "e1", Permission: "external_directory", Patterns: []string{"/srv/data/*"}}}
	if !excepted(exs, Request{Key: "read", Patterns: []string{"/srv/data/a.txt"}}) {
		t.Error("a read under the excepted directory must be covered")
	}
	if excepted(exs, Request{Key: "edit", Patterns: []string{"/srv/data/a.txt"}}) {
		t.Error("an edit under the excepted directory must still ask")
	}
}

// A relayed call (ADR 0121) is a card on every word, whatever would free a
// local call; Plan refuses it, read included; listing is the one free call.
func TestCoordinationForRelayed(t *testing.T) {
	blanket := []permrules.Exception{{ID: "e", Permission: "session_send", Patterns: []string{"*"}}}
	autoRuns := State{Mode: permrules.Ask, Auto: true, AutoRun: AutoRunSet(map[string]string{"agents": "run"})}
	tests := []struct {
		name     string
		p        Policy
		s        State
		key      string
		delegate bool
		target   permrules.Action
		want     permrules.Action
	}{
		{"Ask asks", Policy{}, State{Mode: permrules.Ask}, "session_send", false, "", permrules.Ask},
		{"Allow still asks", Policy{}, autoAll(), "session_send", false, "", permrules.Ask},
		{"Allow read still asks", Policy{}, autoAll(), "session_read", false, "", permrules.Ask},
		{"Allow spawn still asks", Policy{}, autoAll(), "session_spawn", false, permrules.Allow, permrules.Ask},
		{"Auto, Agents row Runs, still asks", Policy{}, autoRuns, "session_send", false, "", permrules.Ask},
		{"Auto, Agents row Runs, read still asks", Policy{}, autoRuns, "session_read", false, "", permrules.Ask},
		{"a blanket exception does not free it", Policy{}, State{Mode: permrules.Ask, Exceptions: blanket}, "session_send", false, "", permrules.Ask},
		{"a blanket exception on Allow does not free it", Policy{}, State{Mode: permrules.Allow, Exceptions: blanket}, "session_send", false, "", permrules.Ask},
		{"a same-or-more-cautious target does not free it", Policy{}, autoAll(), "session_send", false, permrules.Ask, permrules.Ask},
		{"a delegate flag is ignored", Policy{}, State{Mode: permrules.Ask}, "session_send", true, "", permrules.Ask},
		{"Plan refuses a send", Policy{}, State{Mode: permrules.Deny}, "session_send", false, "", permrules.Deny},
		{"Plan refuses a spawn", Policy{}, State{Mode: permrules.Deny}, "session_spawn", false, "", permrules.Deny},
		{"Plan refuses a read", Policy{}, State{Mode: permrules.Deny}, "session_read", false, "", permrules.Deny},
		{"Plan refuses a read even as a delegate", Policy{}, State{Mode: permrules.Deny}, "session_read", true, "", permrules.Deny},
		{"a local deny of agents refuses", pol(ClassAgents), autoAll(), "session_send", false, "", permrules.Deny},
		{"listing is free", Policy{}, State{Mode: permrules.Ask}, "session_list", false, "", permrules.Allow},
		{"listing is free on Plan", Policy{}, State{Mode: permrules.Deny}, "session_list", false, "", permrules.Allow},
		{"a local deny refuses listing", pol(ClassAgents), State{}, "session_list", false, "", permrules.Deny},
	}
	for _, tc := range tests {
		got, reason := CoordinationFor(tc.p, tc.s, tc.key, tc.delegate, tc.target, true)
		if got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
		if got == permrules.Deny && reason == "" {
			t.Errorf("%s: a refusal without a reason", tc.name)
		}
	}
	// The local rules are unchanged by the new input.
	if got, _ := CoordinationFor(Policy{}, autoAll(), "session_send", false, "", false); got != permrules.Allow {
		t.Errorf("a local Allow send: got %s", got)
	}
	if got, _ := CoordinationFor(Policy{}, State{Mode: permrules.Deny}, "session_read", true, "", false); got != permrules.Allow {
		t.Errorf("a local Plan read of a delegate: got %s", got)
	}
}

func TestAutomationToolsAreKnownAndCautious(t *testing.T) {
	for _, k := range []string{"automation_list", "automation_create", "automation_delete", "automation_pause", "automation_resume"} {
		if !Known(k) {
			t.Errorf("%s should be a known permission name", k)
		}
		if cat, _ := Classify(Policy{}, Request{Key: k}); cat != MCP {
			t.Errorf("%s classified %s, want the cautious default (mcp)", k, cat)
		}
	}
}

// autoAll is an Auto session whose map runs every class that can run: what the
// floor's lifts to a card (credential stores, a secret leaving the machine, git
// internals, a looping agent) are tested against now that Allow never asks.
func autoAll() State {
	return State{Mode: permrules.Ask, Auto: true, AutoRun: AutoRunSet(map[string]string{
		"edit": "run", "command": "run", "web": "run", "outside": "run", "agents": "run", "tools": "run"})}
}
