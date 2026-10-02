package main

import (
	"testing"

	"galopin/internal/backend"
	"galopin/internal/permrules"
	"galopin/internal/policy"
)

// The upgrade canaries. galopin's composer is written against four things the
// opencode binary does with rules; none of them is documented as a guarantee,
// all were read from 1.18.32, and a release can change any of them without
// anything else going red. Each canary asserts one directly against the real
// process and says, in its failure, what to revisit. They are the first thing
// to run after bumping the pinned opencode.

// Canary 1: the LAST matching rule wins. Every cap permrules.Compose builds —
// the tail restating rules lowered to the ceiling — is correct only under it.
func TestUpgradeCanaryLastMatchWins(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	allowThenDeny := r.rawSession([]permrules.Rule{
		{Permission: "edit", Pattern: "*", Action: permrules.Allow},
		{Permission: "edit", Pattern: "*", Action: permrules.Deny},
	})
	ask, part, _ := r.try(allowThenDeny, "c1-deny.txt")
	if ask != nil || !refused(part) || r.exists("c1-deny.txt") {
		t.Errorf("[allow, deny]: ask=%v part=%+v exists=%v; the later deny should have won. "+
			"If opencode no longer resolves rules last-match-wins, permrules.Compose/Tail are wrong: revisit them before shipping this opencode.",
			ask, part, r.exists("c1-deny.txt"))
	}
	denyThenAllow := r.rawSession([]permrules.Rule{
		{Permission: "edit", Pattern: "*", Action: permrules.Deny},
		{Permission: "edit", Pattern: "*", Action: permrules.Allow},
	})
	ask, part, _ = r.try(denyThenAllow, "c1-allow.txt")
	if ask != nil || part.ToolStatus != backend.ToolCompleted || !r.exists("c1-allow.txt") {
		t.Errorf("[deny, allow]: ask=%v part=%+v exists=%v; the later allow should have won", ask, part, r.exists("c1-allow.txt"))
	}
}

// Canary 2: session rules sit above the agent's. The plan agent denies edit;
// a session that allows it writes anyway. Everything "the machine's rules beat
// the file and the agent" is this ordering.
func TestUpgradeCanarySessionRulesAreAfterTheAgentsRules(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	plan := r.rawSession(nil)
	if _, err := r.oc.SetMode(r.ctx, r.work, plan.ID, "plan"); err != nil {
		t.Fatal(err)
	}
	if ask, part, _ := r.try(plan, "c2-plain.txt"); ask != nil || !refused(part) || r.exists("c2-plain.txt") {
		t.Fatalf("control: plan mode without a session rule: ask=%v part=%+v exists=%v; plan should deny edit", ask, part, r.exists("c2-plain.txt"))
	}
	allowing := r.rawSession([]permrules.Rule{{Permission: "edit", Pattern: "*", Action: permrules.Allow}})
	if _, err := r.oc.SetMode(r.ctx, r.work, allowing.ID, "plan"); err != nil {
		t.Fatal(err)
	}
	ask, part, _ := r.try(allowing, "c2-allowed.txt")
	if ask != nil || part.ToolStatus != backend.ToolCompleted || !r.exists("c2-allowed.txt") {
		t.Errorf("plan + session allow: ask=%v part=%+v exists=%v; the session rule should sit after the agent's. "+
			"If it no longer does, the machine's rules no longer beat the agent's and the precedence in PROTOCOL.md §6 is false.",
			ask, part, r.exists("c2-allowed.txt"))
	}
}

// Canary 3: a subagent inherits only its parent's DENIES. A parent's ask does
// not reach it (it falls back to its own agent's rules, which allow), a parent's
// deny does. permrules.ChildRules and the agent-level floor exist because of
// the first half; the second is why a deny needs no help.
func TestUpgradeCanaryChildrenInheritOnlyDenies(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	asking := r.rawSession([]permrules.Rule{{Permission: "edit", Pattern: "*", Action: permrules.Ask}})
	child, mark := r.delegate(asking, "c3-ask-marker", "c3-ask.txt")
	ask, part := r.childOutcome(child, mark)
	if ask != nil {
		t.Errorf("the subagent was asked (%+v): a parent's ask now reaches children. "+
			"The ceiling's ask cap would then arrive without the floor; revisit permrules.ChildRules and Floor.", ask)
	} else if part.ToolStatus != backend.ToolCompleted || !r.exists("c3-ask.txt") {
		t.Errorf("the subagent's write: %+v exists=%v", part, r.exists("c3-ask.txt"))
	}

	denying := r.rawSession([]permrules.Rule{{Permission: "edit", Pattern: "*", Action: permrules.Deny}})
	child, mark = r.delegate(denying, "c3-deny-marker", "c3-deny.txt")
	ask, part = r.childOutcome(child, mark)
	if ask != nil || !refused(part) || r.exists("c3-deny.txt") {
		t.Errorf("a parent's deny did not reach the subagent: ask=%v part=%+v exists=%v. "+
			"galopin applies no deny to children itself; revisit.", ask, part, r.exists("c3-deny.txt"))
	}
}

// Canary 4: an "always" is shared by every session in the workspace and
// checked AFTER the rules, so it beats even a later deny. This is why a
// tightened ceiling restarts opencode and why a capped "always" is turned into
// "once" before it is ever given.
func TestUpgradeCanaryAlwaysIsSharedAndCheckedAfterRules(t *testing.T) {
	r := newPermRig(t, permRigOpts{file: map[string]any{"edit": "ask"}})
	a := r.rawSession(nil)
	ask, _, mark := r.try(a, "c4-a.txt")
	if ask == nil {
		t.Fatal("no first ask")
	}
	// Straight to the backend: the machine would have capped nothing here, but
	// this canary is about opencode, not about galopin's choice to send it.
	if err := r.oc.ReplyPermission(r.ctx, r.work, a.ID, ask.ID, backend.DecisionAlways, ""); err != nil {
		t.Fatal(err)
	}
	r.idle(a, mark)

	// Another session, and a deny that covers a file the always did not name
	// outright but whose pattern the always's does. The write lands anyway.
	b := r.rawSession([]permrules.Rule{{Permission: "edit", Pattern: "c4-b*", Action: permrules.Deny}})
	ask, part, _ := r.try(b, "c4-b.txt")
	if ask != nil || part.ToolStatus != backend.ToolCompleted || !r.exists("c4-b.txt") {
		t.Errorf("session B, deny on c4-b*: ask=%v part=%+v exists=%v; session A's always should have beaten it. "+
			"If an always no longer outranks a later deny or no longer crosses sessions, RestartForPolicy and the always-to-once cap are over-cautious: "+
			"revisit them (they are safe, only costly).", ask, part, r.exists("c4-b.txt"))
	}
}

// The floor canary: for every built-in agent and every capped key, the config
// galopin hands opencode never lets an agent do MORE than it did without it,
// and lowers exactly what permrules.Floor claims to lower. It compares the live
// GET /agent of the same process before and after a restart under a ceiling.
// permrules.agentGrants is a table of 1.18.32's built-in agents; this is what
// keeps it honest.
func TestUpgradeCanaryTheFloorNeverLoosensAndCaps(t *testing.T) {
	r := newPermRig(t, permRigOpts{file: map[string]any{"edit": "ask", "bash": "ask", "webfetch": "ask"}})
	agents := []string{"build", "plan", "general", "explore"}
	keys := []string{"edit", "bash", "webfetch", "websearch", "task"}
	patterns := []string{"*", "src/a.go", ".opencode/plans/x.md", "general", "ls -la"}
	before := map[string][]permrules.Rule{}
	for _, a := range agents {
		before[a] = r.agentRules(a)
	}

	ch := r.live.Tighten(policy.Permission{Max: map[string]string{
		"edit": "ask", "bash": "ask", "webfetch": "deny", "websearch": "ask", "task": "ask",
	}})
	if !ch.Tightened {
		t.Fatal("not tightened")
	}
	r.mc.policyTightened(r.ctx, ch)
	ceiling := r.live.Layers().Ceiling

	for _, a := range agents {
		after := r.agentRules(a)
		for _, k := range keys {
			for _, pat := range patterns {
				was := permrules.Evaluate(before[a], k, pat)
				now := permrules.Evaluate(after, k, pat)
				if permrules.Min(was, now) != now {
					t.Errorf("agent %s, %s %q: %s before, %s after — the floor LOOSENED it. permrules.agentGrants no longer matches opencode's built-in agents.",
						a, k, pat, was, now)
				}
				// Where the floor claims to cap (the agent grants the key by
				// default), it must cap exactly.
				if was == permrules.Allow && ceiling.Of(k) != permrules.Allow && now == permrules.Allow && a != "plan" {
					t.Errorf("agent %s, %s %q: allowed before and after under a ceiling of %s — the floor did not cap an agent it should have.",
						a, k, pat, ceiling.Of(k))
				}
			}
		}
	}
	// And the two read-only agents keep their edit deny despite a static
	// `edit: ask` in opencode.json, which sits after them in opencode's merge.
	for _, a := range []string{"plan", "explore"} {
		if got := permrules.Evaluate(r.agentRules(a), "edit", "src/a.go"); got != permrules.Deny {
			t.Errorf("agent %s edit = %s under the static edit: ask, want deny", a, got)
		}
	}
}
