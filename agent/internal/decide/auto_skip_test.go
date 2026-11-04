package decide

import (
	"reflect"
	"testing"

	"galopin/internal/permrules"
)

var autoRequests = []Request{
	{Key: "read", Patterns: []string{ws + "/a.go"}, Workspace: ws},
	{Key: "read", Patterns: []string{"/etc/passwd"}, Workspace: ws},
	{Key: "read", Patterns: []string{ws + "/.env"}, Workspace: ws},
	{Key: "edit", Patterns: []string{"a.go"}, Workspace: ws},
	{Key: "bash", Patterns: []string{"ls"}, Workspace: ws},
	{Key: "webfetch", Patterns: []string{"https://x"}, Workspace: ws},
	{Key: "srv_tool", Patterns: []string{"*"}, Workspace: ws},
	{Key: "task", Patterns: []string{"general"}, Workspace: ws},
	{Key: "doom_loop", Patterns: []string{"bash"}, Workspace: ws},
	{Key: "external_directory", Patterns: []string{"/tmp/*"}, Workspace: ws},
	{Key: "external_directory", Patterns: []string{"/etc/*"}, Workspace: ws},
}

// Auto is decided exactly as Ask: the same verdict, step and category for every
// request, with and without a ceiling, and it cannot be widened by a stray
// Mode of allow beside the flag.
func TestAutoDecidesExactlyAsAsk(t *testing.T) {
	ex := []permrules.Exception{{ID: "ex_1", Permission: "bash", Patterns: []string{"ls"}}}
	for name, p := range map[string]Policy{
		"no ceiling":   pol(nil),
		"bash ask":     pol(map[string]permrules.Action{"bash": permrules.Ask}),
		"edit denied":  pol(map[string]permrules.Action{"edit": permrules.Deny}),
		"external ask": pol(map[string]permrules.Action{"external_directory": permrules.Ask}),
	} {
		for _, r := range autoRequests {
			ask := Decide(p, State{Mode: permrules.Ask, Exceptions: ex}, r)
			for label, st := range map[string]State{
				"auto":             {Mode: permrules.Ask, Auto: true, Exceptions: ex},
				"auto, mode unset": {Auto: true, Exceptions: ex},
				"auto with allow":  {Mode: permrules.Allow, Auto: true, Exceptions: ex},
			} {
				if got := Decide(p, st, r); !reflect.DeepEqual(got, ask) {
					t.Errorf("%s / %s %v: %+v, want exactly Ask's %+v", name, label, r, got, ask)
				}
			}
		}
	}
}

func TestAutoNeverLiftsPlan(t *testing.T) {
	plan := Decide(pol(nil), State{Mode: permrules.Deny}, Request{Key: "edit", Patterns: []string{"a.go"}, Workspace: ws})
	got := Decide(pol(nil), State{Mode: permrules.Deny, Auto: true}, Request{Key: "edit", Patterns: []string{"a.go"}, Workspace: ws})
	if plan.Verdict != Reject || !reflect.DeepEqual(got, plan) {
		t.Errorf("plan = %+v, plan+auto flag = %+v", plan, got)
	}
}

func TestCeilingForcedMarksExactlyTheCardsTheCeilingPutToAPerson(t *testing.T) {
	bashAsk := pol(map[string]permrules.Action{"bash": permrules.Ask})
	tests := []struct {
		name   string
		p      Policy
		s      State
		r      Request
		v      Verdict
		forced bool
	}{
		{"bash on a bash=ask ceiling", bashAsk, State{Auto: true}, Request{Key: "bash", Patterns: []string{"ls"}, Workspace: ws}, Card, true},
		{"bash on Allow still forced", bashAsk, State{Mode: permrules.Allow}, Request{Key: "bash", Patterns: []string{"ls"}, Workspace: ws}, Card, true},
		{"edit uncapped", bashAsk, State{Auto: true}, Request{Key: "edit", Patterns: []string{"a.go"}, Workspace: ws}, Card, false},
		{"no ceiling at all", pol(nil), State{Auto: true}, Request{Key: "bash", Patterns: []string{"ls"}, Workspace: ws}, Card, false},
		{"the brake is the session's own reason", bashAsk, State{Auto: true}, Request{Key: "doom_loop", Patterns: []string{"x"}, Workspace: ws}, Card, false},
		{"an outside ask is the session's reason", bashAsk, State{Auto: true}, Request{Key: "external_directory", Patterns: []string{"/etc/*"}, Workspace: ws}, Card, false},
		{"an outside ask under an external_directory ceiling", pol(map[string]permrules.Action{"external_directory": permrules.Ask}), State{Auto: true}, Request{Key: "external_directory", Patterns: []string{"/etc/*"}, Workspace: ws}, Card, true},
		{"an outside read capped through external_directory", pol(map[string]permrules.Action{"external_directory": permrules.Ask}), State{Auto: true}, Request{Key: "read", Patterns: []string{"/etc/passwd"}, Workspace: ws}, Card, true},
		{"an answered ask is not forced", bashAsk, State{Auto: true}, Request{Key: "read", Patterns: []string{ws + "/a.go"}, Workspace: ws}, Once, false},
		{"a refusal is not a card", pol(map[string]permrules.Action{"bash": permrules.Deny}), State{Auto: true}, Request{Key: "bash", Patterns: []string{"ls"}, Workspace: ws}, Reject, false},
	}
	for _, tc := range tests {
		got := Decide(tc.p, tc.s, tc.r)
		if got.Verdict != tc.v || got.CeilingForced != tc.forced {
			t.Errorf("%s: verdict %s forced %v, want %s %v", tc.name, got.Verdict, got.CeilingForced, tc.v, tc.forced)
		}
	}
}

func skipOf(p Policy, s State, r Request) Result {
	pr := NewProtected("/home/u", "/home/u/.config/galopin")
	return Skip(p, pr, r, Decide(p, s, r))
}

func TestSkipAnswersAllowForEveryCardButTheCeilingTheRejectListAndTheBrake(t *testing.T) {
	bashAsk := pol(map[string]permrules.Action{"bash": permrules.Ask})
	req := func(key string, pats ...string) Request { return Request{Key: key, Patterns: pats, Workspace: ws} }
	tests := []struct {
		name string
		p    Policy
		r    Request
		v    Verdict
		step string
	}{
		{"edit", bashAsk, req("edit", "a.go"), Once, SkipAllow},
		{"web", bashAsk, req("webfetch", "https://x"), Once, SkipAllow},
		{"mcp", bashAsk, req("srv_tool", "*"), Once, SkipAllow},
		{"a .env read is dissolved (ADR 0105 §1)", bashAsk, req("read", ws+"/.env"), Once, SkipAllow},
		{"an outside ask not on the list is dissolved", bashAsk, req("external_directory", "/srv/data/*"), Once, SkipAllow},
		{"bash on a default enrollment is refused", bashAsk, req("bash", "ls"), Reject, SkipCeiling},
		{"bash with no ceiling is allowed", pol(nil), req("bash", "ls"), Once, SkipAllow},
		{"bash naming the policy file", pol(nil), req("bash", "cat /home/u/.config/galopin/policy.json"), Reject, SkipProtected},
		{"bash naming ~/.ssh", pol(nil), req("bash", "cat ~/.ssh/id_ed25519"), Reject, SkipProtected},
		{"the loop brake", bashAsk, req("doom_loop", "bash"), Reject, SkipLoop},
		{"galopin's own state dir", bashAsk, req("edit", "/home/u/.config/galopin/policy.json"), Reject, SkipProtected},
		{"outside: ssh", bashAsk, req("external_directory", "/home/u/.ssh/*"), Reject, SkipProtected},
		{"outside: aws creds", bashAsk, req("read", "/home/u/.aws/credentials"), Reject, SkipProtected},
		{"outside: the cache root", bashAsk, req("edit", "/home/u/.cache/anything"), Reject, SkipProtected},
		{"outside: opencode auth", bashAsk, req("read", "/home/u/.local/share/opencode/auth.json"), Reject, SkipProtected},
		{"CI: workflow write", bashAsk, req("edit", ".github/workflows/ci.yml"), Reject, SkipProtected},
		{"CI: workflow write, absolute", bashAsk, req("edit", ws+"/.github/workflows/sub/x.yaml"), Reject, SkipProtected},
		{"CI: gitlab", bashAsk, req("edit", ".gitlab-ci.yml"), Reject, SkipProtected},
		{"CI: circleci", bashAsk, req("edit", ".circleci/config.yml"), Reject, SkipProtected},
		{"CI: buildkite", bashAsk, req("edit", ".buildkite/pipeline.yml"), Reject, SkipProtected},
		{"CI: azure", bashAsk, req("edit", "azure-pipelines.yml"), Reject, SkipProtected},
		{"CI: jenkins", bashAsk, req("edit", "Jenkinsfile"), Reject, SkipProtected},
		{"CI: bash text", pol(nil), req("bash", "echo x >> .github/workflows/ci.yml"), Reject, SkipProtected},
		{"CI is a write path: a lookalike file is fine", bashAsk, req("edit", "docs/github-workflows.md"), Once, SkipAllow},
	}
	for _, tc := range tests {
		got := skipOf(tc.p, State{}, tc.r)
		if got.Verdict != tc.v || got.Step != tc.step {
			t.Errorf("%s: %s/%s, want %s/%s (%+v)", tc.name, got.Verdict, got.Step, tc.v, tc.step, got)
		}
		if got.Verdict == Reject && got.Reason == "" {
			t.Errorf("%s: a refusal must carry the text the model reads", tc.name)
		}
	}
}

// A read of CI configuration is a read: never refused, and where it is a card
// (outside the project) skip allows it.
func TestSkipCIReadsStayAllowed(t *testing.T) {
	for _, r := range []Request{
		{Key: "read", Patterns: []string{".github/workflows/ci.yml"}, Workspace: ws},
		{Key: "read", Patterns: []string{ws + "/Jenkinsfile"}, Workspace: ws},
		{Key: "grep", Patterns: []string{"x"}, Workspace: ws},
	} {
		got := skipOf(pol(nil), State{}, r)
		if got.Verdict != Once {
			t.Errorf("%v: %+v, want a read to be answered", r, got)
		}
	}
}

// Skip never turns a refusal or an answer into anything: only cards change.
func TestSkipLeavesNonCardsAlone(t *testing.T) {
	p := pol(map[string]permrules.Action{"edit": permrules.Deny})
	for _, st := range []State{{Mode: permrules.Deny}, {}} {
		for _, r := range autoRequests {
			base := Decide(p, st, r)
			if base.Verdict == Card {
				continue
			}
			if got := Skip(p, NewProtected("/home/u", "/s"), r, base); !reflect.DeepEqual(got, base) {
				t.Errorf("%v: skip changed a %s into %+v", r, base.Verdict, got)
			}
		}
	}
}

// galopin's own tools raise gp_ cards the ceiling already capped: skip must not
// answer those with an allow either.
func TestSkipRefusesAGalopinCardTheCeilingCaps(t *testing.T) {
	res := Result{Verdict: Card, Step: "gp"}
	capped := pol(map[string]permrules.Action{"session_spawn": permrules.Ask})
	if got := Skip(capped, NewProtected("", ""), Request{Key: "session_spawn"}, res); got.Verdict != Reject || got.Step != SkipCeiling {
		t.Errorf("capped gp ask: %+v", got)
	}
	if got := Skip(pol(nil), NewProtected("", ""), Request{Key: "session_spawn"}, res); got.Verdict != Once {
		t.Errorf("uncapped gp ask: %+v", got)
	}
}

// The ONE list: skip's Reject list names every class auto's escalate list
// escalates on that a path can express.
func TestProtectedListNamesTheSharedClasses(t *testing.T) {
	pr := NewProtected("/home/u", "/home/u/.config/galopin")
	for _, want := range []string{
		"/home/u/.config/galopin", "/home/u/.cache", "/home/u/.ssh", "/home/u/.gnupg", "/home/u/.aws",
		"/home/u/.local/share/opencode", "/home/u/.config/opencode", "/home/u/.config/pystino", "/home/u/.config/cerea",
	} {
		found := false
		for _, d := range pr.Dirs {
			found = found || d == want
		}
		if !found {
			t.Errorf("the shared list lacks %s: %v", want, pr.Dirs)
		}
	}
	if !reflect.DeepEqual(pr.WorkspaceGlobs, CIGlobs) {
		t.Errorf("CI globs = %v", pr.WorkspaceGlobs)
	}
}
