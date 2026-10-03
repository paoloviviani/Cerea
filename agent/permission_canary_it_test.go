package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

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
	r.bypass = true
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
	r.bypass = true
	r.agents = map[string]string{}
	plan := r.rawSession(nil)
	r.agents[plan.ID] = "plan"
	if ask, part, _ := r.try(plan, "c2-plain.txt"); ask != nil || !refused(part) || r.exists("c2-plain.txt") {
		t.Fatalf("control: plan mode without a session rule: ask=%v part=%+v exists=%v; plan should deny edit", ask, part, r.exists("c2-plain.txt"))
	}
	allowing := r.rawSession([]permrules.Rule{{Permission: "edit", Pattern: "*", Action: permrules.Allow}})
	r.agents[allowing.ID] = "plan"
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
// the first half; the second is why a deny needs no help. The ask is on `glob`,
// a key the floor leaves alone: the floor now makes a subagent ask for the
// blanket's own names before its session has rules, which would answer for the
// parent's ask on edit.
func TestUpgradeCanaryChildrenInheritOnlyDenies(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	r.bypass = true
	asking := r.rawSession([]permrules.Rule{{Permission: "glob", Pattern: "*", Action: permrules.Ask}})
	child, mark := r.delegateCall(asking, "c3-ask-marker", map[string]any{
		"id": "call_c3_glob", "name": "glob", "arguments": mustJSON2(map[string]any{"pattern": "*.nothing", "path": r.work}),
	})
	ask, part := r.childOutcomeOf("glob", child, mark)
	if ask != nil {
		t.Errorf("the subagent was asked (%+v): a parent's ask now reaches children. "+
			"The ceiling's ask cap would then arrive without the floor; revisit permrules.ChildRules and Floor.", ask)
	} else if part.ToolStatus != backend.ToolCompleted {
		t.Errorf("the subagent's glob: %+v", part)
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
// checked AFTER the rules, so it beats even a later deny. galopin no longer
// gives opencode one (an "always allow" is its own exception, and opencode is
// answered "once"), but a tightened ceiling still restarts opencode so that none
// held by an older process or session outlives it; this is why.
func TestUpgradeCanaryAlwaysIsSharedAndCheckedAfterRules(t *testing.T) {
	r := newPermRig(t, permRigOpts{file: map[string]any{"edit": "ask"}})
	r.bypass = true
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

// Canary 5: opencode has two permission stores and only one of them governs a
// tool call. A v1 "always" never appears in the v2 saved list (so listing that
// list would not show what an always allowed), and nothing put through the v2
// API reaches a v1 ask (so removing from it would withdraw nothing a tool call
// depends on). galopin therefore keeps its own record of the always replies it
// relays and ignores /api/permission/saved. If a release wires the two
// together, this fails: revisit permission.rules' savedApprovals and
// permission.saved.remove, which may become able to do the real thing.
func TestUpgradeCanarySavedStoreIsNotTheAlwaysStore(t *testing.T) {
	r := newPermRig(t, permRigOpts{file: map[string]any{"edit": "ask"}})
	r.bypass = true

	// A v2 request with a save does not become a v1 approval: a v1 write still
	// asks afterwards.
	b := r.rawSession(nil)
	out := r.raw(http.MethodPost, "/api/session/"+b.ID+"/permission?directory="+r.work,
		map[string]any{"action": "edit", "resources": []string{"c5-c.txt"}, "save": []string{"c5-c.txt"}})
	var created struct {
		Data struct {
			Effect string `json:"effect"`
		} `json:"data"`
	}
	_ = json.Unmarshal(out, &created)
	if created.Data.Effect == "allow" {
		t.Errorf("a v2 permission request was allowed (%s): the v2 system now evaluates against real rules; revisit", out)
	}
	if body := string(r.raw(http.MethodGet, "/api/permission/saved?directory="+r.work, nil)); body != `{"data":[]}` {
		t.Errorf("the v2 saved list after a v2 request = %s, want it empty", body)
	}
	a := r.rawSession(nil)
	ask, _, mark := r.try(a, "c5-a.txt")
	if ask == nil {
		t.Fatal("a v1 write did not ask after a v2 request: a v2 request changed a v1 decision")
	}

	// A v1 always never appears in the v2 saved list.
	if err := r.oc.ReplyPermission(r.ctx, r.work, a.ID, ask.ID, backend.DecisionAlways, ""); err != nil {
		t.Fatal(err)
	}
	r.idle(a, mark)
	if ask2, part, _ := r.try(a, "c5-b.txt"); ask2 != nil || part.ToolStatus != backend.ToolCompleted {
		t.Fatalf("the always did not hold (ask=%v part=%+v): the premise of this canary is gone", ask2, part)
	}
	var project struct {
		ProjectID string `json:"projectID"`
	}
	_ = json.Unmarshal(r.raw(http.MethodGet, "/session/"+a.ID, nil), &project)
	for _, path := range []string{"/api/permission/saved", "/api/permission/saved?projectID=" + project.ProjectID, "/api/permission/saved?directory=" + r.work} {
		if body := string(r.raw(http.MethodGet, path, nil)); body != `{"data":[]}` {
			t.Errorf("GET %s = %s after a v1 always: the v2 list now shows v1 approvals. "+
				"permission.rules could list them from opencode, and saved.remove may be able to remove them: revisit.", path, body)
		}
	}
}

// Canary 6: the task tool tells the model which agent types it can start, and
// that list does NOT follow the calling session's rules: a session that denies
// `task: general` still hears about `general`. This is why galopin does not give
// a root the Allow word by steering its tasks to a second, ask-free variant of
// each subagent (deny `general`, allow `general-allow`): the model would see
// both, pick the denied one half the time and have to retry. If a release omits
// denied types from the list, that route (a variant per subagent in the floor
// config, the main session's rules choosing between them) becomes viable and a
// subagent's first turn could follow the root's word: revisit permrules.Floor.
func TestUpgradeCanaryTaskListIgnoresTheSessionsTaskDenies(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	r.bypass = true
	s := r.rawSession([]permrules.Rule{{Permission: "task", Pattern: "general", Action: permrules.Deny}})
	r.script(map[string]any{})
	if err := r.promptSession(s, "hello"); err != nil {
		t.Fatal(err)
	}
	var desc string
	for deadline := time.Now().Add(30 * time.Second); desc == "" && time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		resp, err := http.Get(r.mock + "/__control/tools")
		if err != nil {
			t.Fatal(err)
		}
		var body struct {
			Tools map[string]string `json:"tools"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		desc = body.Tools["task"]
	}
	if desc == "" {
		t.Fatal("the model was never offered a task tool: with the session's rules the call may now be withdrawn from the list")
	}
	if !strings.Contains(desc, "- general:") {
		t.Errorf("the task tool's list omits the agent the session denies: opencode now filters the list by the caller's rules, "+
			"so a per-subagent variant steered by the main session's rules is viable (no refuse-and-retry); revisit the first-turn floor. List:\n%s", desc)
	}
	if !strings.Contains(desc, "- explore:") {
		t.Errorf("the task tool's list lacks explore: %s", desc)
	}
}
