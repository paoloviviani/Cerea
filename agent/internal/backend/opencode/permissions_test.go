package opencode

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"

	"galopin/internal/backend"
	"galopin/internal/permrules"
)

// permFake is an opencode that records what it is sent: session creates (with
// their permission), PATCHes, prompt bodies, and serves GET /agent with a
// build agent that allows everything and a plan agent that denies edit.
type permFake struct {
	mu      sync.Mutex
	creates []map[string]any
	patches []map[string]any
	prompts []map[string]any
	saved   []map[string]any
	deleted []string
	agents  string // GET /agent's answer; fakeAgents when empty
}

func (f *permFake) snapshot() (creates, patches, prompts []map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.creates...), append([]map[string]any(nil), f.patches...), append([]map[string]any(nil), f.prompts...)
}

const fakeAgents = `[
 {"name":"build","mode":"primary","permission":[{"permission":"*","pattern":"*","action":"allow"}]},
 {"name":"plan","mode":"primary","permission":[{"permission":"*","pattern":"*","action":"allow"},{"permission":"edit","pattern":"*","action":"deny"}]},
 {"name":"explore","mode":"subagent","permission":[{"permission":"*","pattern":"*","action":"deny"},{"permission":"read","pattern":"*","action":"allow"}]}
]`

func newPermFake(t *testing.T, layers func() permrules.Layers) (*Backend, *permFake) {
	t.Helper()
	f := &permFake{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var parsed map[string]any
		_ = json.Unmarshal(body, &parsed)
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.URL.Path == "/agent":
			if f.agents != "" {
				_, _ = io.WriteString(w, f.agents)
			} else {
				_, _ = io.WriteString(w, fakeAgents)
			}
		case r.Method == http.MethodPost && r.URL.Path == "/session":
			f.creates = append(f.creates, parsed)
			_, _ = io.WriteString(w, `{"id":"ses_new","title":"t"}`)
		case r.Method == http.MethodPatch && strings.HasPrefix(r.URL.Path, "/session/"):
			f.patches = append(f.patches, parsed)
			_, _ = io.WriteString(w, `{"id":"ses_1","title":"t"}`)
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/session/"):
			_, _ = io.WriteString(w, `{"id":"`+strings.TrimPrefix(r.URL.Path, "/session/")+`","title":"t"}`)
		case strings.HasSuffix(r.URL.Path, "/prompt_async"):
			f.prompts = append(f.prompts, parsed)
			w.WriteHeader(http.StatusNoContent)
		case r.URL.Path == "/api/permission/saved" && r.Method == http.MethodGet:
			out, _ := json.Marshal(map[string]any{"data": f.saved})
			_, _ = w.Write(out)
		case strings.HasPrefix(r.URL.Path, "/api/permission/saved/") && r.Method == http.MethodDelete:
			f.deleted = append(f.deleted, strings.TrimPrefix(r.URL.Path, "/api/permission/saved/"))
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ := strconv.Atoi(portStr)
	return New(Config{Hostname: host, Port: port, Password: "x", Permissions: layers}), f
}

func ceilingAsk(keys ...string) func() permrules.Layers {
	return func() permrules.Layers {
		c := permrules.Ceiling{Max: map[string]permrules.Action{}}
		for _, k := range keys {
			c.Max[k] = permrules.Ask
		}
		return permrules.Layers{Ceiling: c}
	}
}

func rulesOf(t *testing.T, body map[string]any) []permrules.Rule {
	t.Helper()
	raw, _ := json.Marshal(body["permission"])
	var rules []permrules.Rule
	if err := json.Unmarshal(raw, &rules); err != nil {
		t.Fatalf("permission field %s: %v", raw, err)
	}
	return rules
}

// The rules ride in the create itself, so the session has them before a first
// prompt can exist.
func TestCreateSessionCarriesTheRules(t *testing.T) {
	layers := func() permrules.Layers {
		return permrules.Layers{
			Own:     []permrules.Rule{{Permission: "edit", Pattern: "*", Action: permrules.Allow}},
			Ceiling: permrules.Ceiling{Max: map[string]permrules.Action{"edit": permrules.Ask}},
		}
	}
	b, f := newPermFake(t, layers)
	if _, err := b.CreateSession(context.Background(), "/ws", backend.CreateSessionOptions{Title: "t"}); err != nil {
		t.Fatal(err)
	}
	creates, patches, _ := f.snapshot()
	if len(creates) != 1 || len(patches) != 0 {
		t.Fatalf("creates=%d patches=%d, want the rules in the one create", len(creates), len(patches))
	}
	rules := rulesOf(t, creates[0])
	if rules[0] != (permrules.Rule{Permission: "edit", Pattern: "*", Action: permrules.Allow}) {
		t.Errorf("first rule = %+v, want the machine's own", rules[0])
	}
	agent := []permrules.Rule{{Permission: "*", Pattern: "*", Action: permrules.Allow}}
	if got := permrules.Evaluate(append(agent, rules...), "edit", "a.go"); got != permrules.Ask {
		t.Errorf("a build session's edit = %s, want ask (ceiling after the machine's allow)", got)
	}
}

// A plan session's create must not loosen plan's edit deny into an ask.
func TestCreateSessionInPlanModeKeepsTheDeny(t *testing.T) {
	b, f := newPermFake(t, ceilingAsk("edit"))
	if _, err := b.CreateSession(context.Background(), "/ws", backend.CreateSessionOptions{ModeID: "plan"}); err != nil {
		t.Fatal(err)
	}
	creates, _, _ := f.snapshot()
	plan := []permrules.Rule{{Permission: "*", Pattern: "*", Action: permrules.Allow}, {Permission: "edit", Pattern: "*", Action: permrules.Deny}}
	if got := permrules.Evaluate(append(plan, rulesOf(t, creates[0])...), "edit", "a.go"); got != permrules.Deny {
		t.Errorf("plan edit = %s, want deny kept", got)
	}
}

func TestNoPermissionsConfiguredSendsNothingExtra(t *testing.T) {
	b, f := newPermFake(t, nil)
	if _, err := b.CreateSession(context.Background(), "/ws", backend.CreateSessionOptions{Title: "t"}); err != nil {
		t.Fatal(err)
	}
	if err := b.Prompt(context.Background(), "/ws", "ses_1", backend.Prompt{Text: "x"}); err != nil {
		t.Fatal(err)
	}
	creates, patches, _ := f.snapshot()
	if _, has := creates[0]["permission"]; has || len(patches) != 0 {
		t.Errorf("creates=%v patches=%v, want no permission traffic", creates, patches)
	}
}

// Re-sent only on change: a second prompt under the same rules PATCHes nothing,
// a tightened ceiling PATCHes once, a mode change PATCHes for the new agent.
func TestRulesAreResentOnlyOnChange(t *testing.T) {
	var mu sync.Mutex
	keys := []string{"bash"}
	layers := func() permrules.Layers {
		mu.Lock()
		defer mu.Unlock()
		return ceilingAsk(keys...)()
	}
	b, f := newPermFake(t, layers)
	ctx := context.Background()
	s, err := b.CreateSession(ctx, "/ws", backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	prompt := func() {
		t.Helper()
		if err := b.Prompt(ctx, "/ws", s.ID, backend.Prompt{Text: "go"}); err != nil {
			t.Fatal(err)
		}
	}
	prompt()
	prompt()
	if _, patches, prompts := f.snapshot(); len(patches) != 0 || len(prompts) != 2 {
		t.Fatalf("patches=%d prompts=%d, want 0 and 2: the create already carried the rules", len(patches), len(prompts))
	}

	mu.Lock()
	keys = []string{"bash", "edit"}
	mu.Unlock()
	prompt()
	_, patches, _ := f.snapshot()
	if len(patches) != 1 {
		t.Fatalf("patches = %d after the ceiling tightened, want 1", len(patches))
	}
	prompt()
	if _, patches, _ = f.snapshot(); len(patches) != 1 {
		t.Fatalf("patches = %d, want still 1: nothing changed", len(patches))
	}

	if _, err := b.SetMode(ctx, "/ws", s.ID, "plan"); err != nil {
		t.Fatal(err)
	}
	prompt()
	if _, patches, _ = f.snapshot(); len(patches) != 2 {
		t.Fatalf("patches = %d after a mode change, want 2", len(patches))
	}
}

// A prompt whose rules cannot be applied is not sent: fail closed.
func TestPromptIsNotSentWhenTheCeilingCannotBeApplied(t *testing.T) {
	b, f := newPermFake(t, ceilingAsk("edit"))
	ctx := context.Background()
	s, err := b.CreateSession(ctx, "/ws", backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.SetMode(ctx, "/ws", s.ID, "no-such-agent"); err != nil {
		t.Fatal(err)
	}
	if err := b.Prompt(ctx, "/ws", s.ID, backend.Prompt{Text: "go"}); err == nil {
		t.Fatal("a prompt went out under rules galopin could not compose")
	}
	if _, _, prompts := f.snapshot(); len(prompts) != 0 {
		t.Errorf("prompts = %v, want none", prompts)
	}
}

// P7: nothing carrying `tools` reaches opencode — it REPLACES a session's
// rules wholesale, which would drop the ceiling in one field.
func TestToolsNeverReachesOpencode(t *testing.T) {
	var got map[string]any
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		_ = json.Unmarshal(body, &got)
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ := strconv.Atoi(portStr)
	b := New(Config{Hostname: host, Port: port, Password: "x"})
	body := map[string]any{"parts": []any{}, "tools": map[string]bool{"bash": true}, "permission": []any{}}
	if err := b.doJSON(context.Background(), http.MethodPost, "/session/ses_1/prompt_async", body, nil); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if _, has := got["tools"]; has {
		t.Errorf("opencode received a tools field: %v", got)
	}
	if _, has := got["permission"]; !has {
		t.Error("the guard removed more than tools")
	}
}

func TestEffectiveRulesIsTheAgentsThenGalopins(t *testing.T) {
	b, _ := newPermFake(t, ceilingAsk("edit"))
	rules, err := b.EffectiveRules(context.Background(), "/ws", "ses_1")
	if err != nil {
		t.Fatal(err)
	}
	if rules[0] != (permrules.Rule{Permission: "*", Pattern: "*", Action: permrules.Allow}) {
		t.Errorf("first = %+v, want build's own first", rules[0])
	}
	if got := permrules.Evaluate(rules, "edit", "a.go"); got != permrules.Ask {
		t.Errorf("effective edit = %s, want ask", got)
	}
	if got := permrules.Grant(rules, "session_spawn"); got != permrules.Ask {
		t.Errorf("grant over build's allow-all = %s, want ask (a wildcard allow is not consent)", got)
	}
}

func TestChildRulesNeverCarryTheMachinesAllows(t *testing.T) {
	layers := func() permrules.Layers {
		return permrules.Layers{
			Own:     []permrules.Rule{{Permission: "session_spawn", Pattern: "*", Action: permrules.Allow}, {Permission: "edit", Pattern: "*", Action: permrules.Allow}},
			Ceiling: permrules.Ceiling{Max: map[string]permrules.Action{"edit": permrules.Ask}},
		}
	}
	b, f := newPermFake(t, layers)
	b.noteSession(backend.Session{ID: "ses_child", ParentID: "ses_1"})
	if err := b.ApplyChildRules(context.Background(), "/ws", "ses_child", "explore"); err != nil {
		t.Fatal(err)
	}
	_, patches, _ := f.snapshot()
	if len(patches) != 1 {
		t.Fatalf("patches = %d, want 1", len(patches))
	}
	for _, r := range rulesOf(t, patches[0]) {
		if r.Permission == "session_spawn" || (r.Action == permrules.Allow && !permrules.IsUntouched(r.Permission)) {
			t.Errorf("an allow reached a child: %+v", r)
		}
	}
	// explore denies edit: the cap restated over it must stay a deny.
	explore := []permrules.Rule{{Permission: "*", Pattern: "*", Action: permrules.Deny}, {Permission: "read", Pattern: "*", Action: permrules.Allow}}
	if got := permrules.Evaluate(append(explore, rulesOf(t, patches[0])...), "edit", "a.go"); got != permrules.Deny {
		t.Errorf("explore child edit = %s, want deny kept", got)
	}
	// And the same call again sends nothing.
	if err := b.ApplyChildRules(context.Background(), "/ws", "ses_child", "explore"); err != nil {
		t.Fatal(err)
	}
	if _, patches, _ = f.snapshot(); len(patches) != 1 {
		t.Errorf("patches = %d, want still 1", len(patches))
	}
	// A child of unknown type gets denies only: an ask cap restated blind
	// could soften a read-only agent.
	b.noteSession(backend.Session{ID: "ses_child2", ParentID: "ses_1"})
	denyAll := func() permrules.Layers {
		return permrules.Layers{Ceiling: permrules.Ceiling{Max: map[string]permrules.Action{"edit": permrules.Ask, "bash": permrules.Deny}}}
	}
	b.cfg.Permissions = denyAll
	if err := b.ApplyChildRules(context.Background(), "/ws", "ses_child2", ""); err != nil {
		t.Fatal(err)
	}
	_, patches, _ = f.snapshot()
	for _, r := range rulesOf(t, patches[len(patches)-1]) {
		if r.Action != permrules.Deny {
			t.Errorf("a child of unknown type got a non-deny rule: %+v", r)
		}
	}
}

func TestFloorConfigMergesOverThePinnedContent(t *testing.T) {
	base := map[string]any{
		"model":      "pystino/m",
		"permission": map[string]any{"read": "allow"},
		"agent":      map[string]any{"build": map[string]any{"model": "pystino/m", "permission": map[string]any{"read": "allow"}}},
	}
	body, err := floorConfig(base, permrules.Layers{Ceiling: permrules.Ceiling{Max: map[string]permrules.Action{"bash": permrules.Deny}}})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	if got["model"] != "pystino/m" {
		t.Error("the pinned model was lost")
	}
	perm := got["permission"].(map[string]any)
	if perm["read"] != "allow" || perm["bash"] != "deny" {
		t.Errorf("top-level permission = %v, want read kept and bash denied", perm)
	}
	build := got["agent"].(map[string]any)["build"].(map[string]any)
	if build["model"] != "pystino/m" || build["permission"].(map[string]any)["bash"] != "deny" || build["permission"].(map[string]any)["read"] != "allow" {
		t.Errorf("build = %v, want its model and read kept, bash denied", build)
	}
	if base["permission"].(map[string]any)["bash"] != nil {
		t.Error("floorConfig mutated its base")
	}
}

// opencode returns an agent's ruleset merged; the sources are attributed by
// galopin from what it wrote itself (the floor) and the static file it owns.
func TestRuleLayersAttributesSources(t *testing.T) {
	dir := t.TempDir()
	cfgPath := dir + "/opencode.json"
	if err := os.WriteFile(cfgPath, []byte(`{"permission":{"edit":"ask","bash":{"ls *":"allow"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	layers := func() permrules.Layers {
		return permrules.Layers{
			Own:     []permrules.Rule{{Permission: "webfetch", Pattern: "*", Action: permrules.Allow}},
			Ceiling: permrules.Ceiling{Max: map[string]permrules.Action{"edit": permrules.Ask}},
		}
	}
	b, f := newPermFake(t, layers)
	b.cfg.ConfigPath = cfgPath
	// build as opencode would report it with the file and the floor merged in.
	f.agents = `[{"name":"build","mode":"primary","permission":[
	  {"permission":"*","pattern":"*","action":"allow"},
	  {"permission":"doom_loop","pattern":"*","action":"ask"},
	  {"permission":"edit","pattern":"*","action":"ask"},
	  {"permission":"bash","pattern":"ls *","action":"allow"},
	  {"permission":"edit","pattern":"*","action":"ask"}]}]`
	l, err := b.RuleLayers(context.Background(), "/ws", "ses_1")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, r := range l.Rules {
		if n := len(got); n > 0 && got[n-1] == r.Source {
			continue
		}
		got = append(got, r.Source)
	}
	// opencode's list (its own, the file's, the floor's), then the machine's
	// rule, then the selector's block, then the cap, last.
	want := []string{"default", "file", "floor", "machine", "cerea", "ceiling"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("source runs = %v\nwant        %v", got, want)
	}
	var first []string
	for _, r := range l.Rules[:5] {
		first = append(first, r.Permission+":"+r.Source)
	}
	if strings.Join(first, " ") != "*:default doom_loop:default edit:file bash:file edit:floor" {
		t.Errorf("opencode's list, walked from the end = %v", first)
	}
	if l.Mode != "ask" {
		t.Errorf("mode = %q, want ask for a session nobody set", l.Mode)
	}
	if l.Agent != "build" {
		t.Errorf("agent = %q", l.Agent)
	}
	if last := l.Rules[len(l.Rules)-1]; last.Source != backend.SourceCeiling {
		t.Errorf("last rule = %+v, want the ceiling's", last)
	}
}

// stackOf is what opencode holds for a session after the creates and PATCHes it
// was sent, behind the agent's own rules (build's, here): it only ever appends.
func stackOf(t *testing.T, base []permrules.Rule, f *permFake, from int) []permrules.Rule {
	t.Helper()
	creates, patches, _ := f.snapshot()
	all := append([]permrules.Rule(nil), base...)
	for _, c := range creates {
		all = append(all, rulesOf(t, c)...)
	}
	for _, p := range patches[from:] {
		all = append(all, rulesOf(t, p)...)
	}
	return all
}

var buildOnly = []permrules.Rule{{Permission: "*", Pattern: "*", Action: permrules.Allow}}

// A new session is on Ask even on a machine with no rules and no ceiling at
// all (a policy.json that predates permissions): the create carries the block.
func TestANewSessionIsOnAskEvenOnALegacyMachine(t *testing.T) {
	b, f := newPermFake(t, func() permrules.Layers { return permrules.Layers{} })
	s, err := b.CreateSession(context.Background(), "/ws", backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	creates, _, _ := f.snapshot()
	if _, has := creates[0]["permission"]; !has {
		t.Fatal("a legacy machine's create carried no rules: it would write without asking")
	}
	all := stackOf(t, buildOnly, f, 0)
	if got := permrules.Evaluate(all, "edit", "a.go"); got != permrules.Ask {
		t.Errorf("edit on a legacy machine = %s, want ask", got)
	}
	if got := permrules.Evaluate(all, "read", "a.go"); got != permrules.Allow {
		t.Errorf("read = %s, want allow", got)
	}
	if b.PermissionMode(s.ID) != permrules.Ask {
		t.Errorf("mode = %s, want ask", b.PermissionMode(s.ID))
	}
}

// The mode is applied at once, replaces the earlier one for every input (opencode
// only appends), is not re-sent when nothing changed, and survives in the overlay.
func TestSetPermissionModeAppliesAndReplaces(t *testing.T) {
	b, f := newPermFake(t, func() permrules.Layers { return permrules.Layers{} })
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/ws", backend.CreateSessionOptions{})

	if err := b.SetPermissionMode(ctx, "/ws", s.ID, permrules.Allow); err != nil {
		t.Fatal(err)
	}
	if _, patches, _ := f.snapshot(); len(patches) != 1 {
		t.Fatalf("patches = %d, want the change applied at once", len(patches))
	}
	if got := permrules.Evaluate(stackOf(t, buildOnly, f, 0), "bash", "ls"); got != permrules.Allow {
		t.Errorf("bash under Allow = %s", got)
	}
	if err := b.SetPermissionMode(ctx, "/ws", s.ID, permrules.Allow); err != nil {
		t.Fatal(err)
	}
	if _, patches, _ := f.snapshot(); len(patches) != 1 {
		t.Errorf("patches = %d after setting the same mode, want still 1", len(patches))
	}
	if err := b.SetPermissionMode(ctx, "/ws", s.ID, permrules.Deny); err != nil {
		t.Fatal(err)
	}
	all := stackOf(t, buildOnly, f, 0)
	if got := permrules.Evaluate(all, "edit", "a"); got != permrules.Deny {
		t.Errorf("edit after Allow then Deny = %s, want deny", got)
	}
	if got := permrules.Evaluate(all, "read", "a"); got != permrules.Allow {
		t.Errorf("read under Deny = %s, want allow", got)
	}
	if got := b.getOverlay(s.ID).Selector.Mode; got != permrules.Deny {
		t.Errorf("stored mode = %q", got)
	}
}

func TestExceptionsComeAndGoWithTheirRules(t *testing.T) {
	b, f := newPermFake(t, func() permrules.Layers { return permrules.Layers{} })
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/ws", backend.CreateSessionOptions{})
	ex, err := b.AddException(ctx, "/ws", s.ID, permrules.Exception{ID: "ex_1", Permission: "bash", Patterns: []string{"git status *"}})
	if err != nil {
		t.Fatal(err)
	}
	if ex.ID != "ex_1" || len(b.Exceptions(s.ID)) != 1 {
		t.Fatalf("exceptions = %+v", b.Exceptions(s.ID))
	}
	all := stackOf(t, buildOnly, f, 0)
	if permrules.Evaluate(all, "bash", "git status") != permrules.Allow || permrules.Evaluate(all, "bash", "git log") != permrules.Ask {
		t.Error("the exception must allow git status and nothing else")
	}
	// Deny blocks it, Ask restores it.
	_ = b.SetPermissionMode(ctx, "/ws", s.ID, permrules.Deny)
	if got := permrules.Evaluate(stackOf(t, buildOnly, f, 0), "bash", "git status"); got != permrules.Deny {
		t.Errorf("under Deny = %s", got)
	}
	_ = b.SetPermissionMode(ctx, "/ws", s.ID, permrules.Ask)
	if got := permrules.Evaluate(stackOf(t, buildOnly, f, 0), "bash", "git status"); got != permrules.Allow {
		t.Errorf("back on Ask = %s, want the kept exception", got)
	}
	// Removing it makes the command ask again, even behind the older PATCHes.
	if found, err := b.RemoveException(ctx, "/ws", s.ID, "ex_zzz"); found || err != nil {
		t.Errorf("removing an unknown id = %v, %v", found, err)
	}
	if found, err := b.RemoveException(ctx, "/ws", s.ID, "ex_1"); !found || err != nil {
		t.Fatalf("removing = %v, %v", found, err)
	}
	if got := permrules.Evaluate(stackOf(t, buildOnly, f, 0), "bash", "git status"); got != permrules.Ask {
		t.Errorf("after removal = %s, want ask", got)
	}
}

// A subagent has no selector: it follows its root's, and a change to the root
// reaches a child that is already running.
func TestARootChangeIsReappliedToItsSubagents(t *testing.T) {
	b, f := newPermFake(t, func() permrules.Layers { return permrules.Layers{} })
	f.agents = `[
	 {"name":"build","mode":"primary","permission":[{"permission":"*","pattern":"*","action":"allow"}]},
	 {"name":"general","mode":"subagent","permission":[{"permission":"*","pattern":"*","action":"allow"}]}]`
	ctx := context.Background()
	root, _ := b.CreateSession(ctx, "/ws", backend.CreateSessionOptions{})
	b.noteSession(backend.Session{ID: "ses_kid", ParentID: root.ID})
	b.noteSession(backend.Session{ID: "ses_grandkid", ParentID: "ses_kid"})
	if got := b.rootOf("ses_grandkid"); got != root.ID {
		t.Fatalf("root of a grandchild = %q, want %q", got, root.ID)
	}
	if err := b.ApplyChildRules(ctx, "/ws", "ses_kid", "general"); err != nil {
		t.Fatal(err)
	}
	if err := b.ApplyChildRules(ctx, "/ws", "ses_grandkid", "general"); err != nil {
		t.Fatal(err)
	}
	_, before, _ := f.snapshot()
	if err := b.SetPermissionMode(ctx, "/ws", root.ID, permrules.Allow); err != nil {
		t.Fatal(err)
	}
	_, after, _ := f.snapshot()
	if len(after)-len(before) != 3 {
		t.Fatalf("patches for the change = %d, want the root and both descendants", len(after)-len(before))
	}
	child := rulesOf(t, after[len(after)-1])
	if got := permrules.Evaluate(append(append([]permrules.Rule(nil), buildOnly...), child...), "edit", "a"); got != permrules.Allow {
		t.Errorf("a running grandchild's edit after the root went to Allow = %s", got)
	}
	if b.PermissionMode("ses_grandkid") != permrules.Allow {
		t.Error("a descendant must report its root's mode")
	}
	// Its own overlay carries no selector.
	if got := b.getOverlay("ses_kid").Selector; got.Mode != "" || len(got.Exceptions) != 0 {
		t.Errorf("a subagent holds a selector of its own: %+v", got)
	}
}

// A root that cannot be given its rules keeps its old mode: what is shown must
// be what is enforced.
func TestARootThatCannotBeReachedKeepsItsOldMode(t *testing.T) {
	b, f := newPermFake(t, func() permrules.Layers { return permrules.Layers{} })
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/ws", backend.CreateSessionOptions{})
	f.mu.Lock()
	f.agents = `[]`
	f.mu.Unlock()
	b.forgetAgentRules()
	if err := b.SetPermissionMode(ctx, "/ws", s.ID, permrules.Deny); err == nil {
		t.Fatal("setting a mode went through with the agent's rules unreadable")
	}
	if got := b.PermissionMode(s.ID); got != permrules.Ask {
		t.Errorf("mode after a failed change = %s, want the old ask", got)
	}
}

// F2: the machine's own ask reaches a subagent, as a cap over the child's agent.
func TestChildGetsTheMachinesAskAndNeverSoftensADeny(t *testing.T) {
	layers := func() permrules.Layers {
		return permrules.Layers{Own: []permrules.Rule{{Permission: "edit", Pattern: "*", Action: permrules.Ask}, {Permission: "read", Pattern: "*", Action: permrules.Allow}}}
	}
	b, f := newPermFake(t, layers)
	f.agents = `[
	 {"name":"general","mode":"subagent","permission":[{"permission":"*","pattern":"*","action":"allow"}]},
	 {"name":"explore","mode":"subagent","permission":[{"permission":"*","pattern":"*","action":"deny"},{"permission":"read","pattern":"*","action":"allow"}]}]`
	b.noteSession(backend.Session{ID: "ses_g", ParentID: "ses_1"})
	b.noteSession(backend.Session{ID: "ses_e", ParentID: "ses_1"})
	if err := b.ApplyChildRules(context.Background(), "/ws", "ses_g", "general"); err != nil {
		t.Fatal(err)
	}
	if err := b.ApplyChildRules(context.Background(), "/ws", "ses_e", "explore"); err != nil {
		t.Fatal(err)
	}
	_, patches, _ := f.snapshot()
	if len(patches) != 2 {
		t.Fatalf("patches = %d", len(patches))
	}
	general := []permrules.Rule{{Permission: "*", Pattern: "*", Action: permrules.Allow}}
	explore := []permrules.Rule{{Permission: "*", Pattern: "*", Action: permrules.Deny}, {Permission: "read", Pattern: "*", Action: permrules.Allow}}
	if got := permrules.Evaluate(append(general, rulesOf(t, patches[0])...), "edit", "a"); got != permrules.Ask {
		t.Errorf("general child edit = %s, want ask", got)
	}
	if got := permrules.Evaluate(append(explore, rulesOf(t, patches[1])...), "edit", "a"); got != permrules.Deny {
		t.Errorf("explore child edit = %s, want its deny kept", got)
	}
	// An unknown-type child gets denies only.
	b.noteSession(backend.Session{ID: "ses_u", ParentID: "ses_1"})
	b.cfg.Permissions = func() permrules.Layers {
		return permrules.Layers{Own: []permrules.Rule{{Permission: "bash", Pattern: "*", Action: permrules.Deny}, {Permission: "edit", Pattern: "*", Action: permrules.Ask}}}
	}
	if err := b.ApplyChildRules(context.Background(), "/ws", "ses_u", ""); err != nil {
		t.Fatal(err)
	}
	_, patches, _ = f.snapshot()
	for _, r := range rulesOf(t, patches[len(patches)-1]) {
		if r.Action != permrules.Deny || r.Permission != "bash" {
			t.Errorf("an unknown-type child got %+v, want only the machine's deny", r)
		}
	}
}

func TestAgentFromTitleReadsOnlyOpencodesOwnSuffix(t *testing.T) {
	for title, want := range map[string]string{
		"write a file (@general subagent)":               "general",
		"look around (@explore subagent)":                "explore",
		"  padded (@general subagent) ":                  "general",
		"sneaky (@explore subagent) (@general subagent)": "general",
		"sneaky (@general subagent) and then some":       "",
		"a title with no suffix":                         "",
		"":                                               "",
		"(@my-custom.agent_1 subagent)":                  "my-custom.agent_1",
		"(@general subagent) trailing":                   "",
	} {
		if got := agentFromTitle(title); got != want {
			t.Errorf("agentFromTitle(%q) = %q, want %q", title, got, want)
		}
	}
}

// The title names the agent from the child's first event, before the parent's
// task call does, so the first application already has the full block for it —
// and a later authoritative one changes nothing when the hint was right.
func TestChildGetsItsRulesFromTheTitleHint(t *testing.T) {
	b, f := newPermFake(t, func() permrules.Layers { return permrules.Layers{} })
	f.agents = `[
	 {"name":"general","mode":"subagent","permission":[{"permission":"*","pattern":"*","action":"allow"}]},
	 {"name":"explore","mode":"subagent","permission":[{"permission":"*","pattern":"*","action":"deny"},{"permission":"read","pattern":"*","action":"allow"}]}]`
	ctx := context.Background()
	b.noteSession(backend.Session{ID: "ses_g", ParentID: "ses_1", Title: "write (@general subagent)"})
	b.noteSession(backend.Session{ID: "ses_x", ParentID: "ses_1", Title: "look (@explore subagent)"})
	for _, id := range []string{"ses_g", "ses_x"} {
		if err := b.ApplyChildRules(ctx, "/ws", id, ""); err != nil {
			t.Fatal(err)
		}
	}
	_, patches, _ := f.snapshot()
	if len(patches) != 2 {
		t.Fatalf("patches = %d, want one per child", len(patches))
	}
	general := []permrules.Rule{{Permission: "*", Pattern: "*", Action: permrules.Allow}}
	if got := permrules.Evaluate(append(general, rulesOf(t, patches[0])...), "edit", "a"); got != permrules.Ask {
		t.Errorf("general child edit = %s, want the root's default ask", got)
	}
	explore := []permrules.Rule{{Permission: "*", Pattern: "*", Action: permrules.Deny}, {Permission: "read", Pattern: "*", Action: permrules.Allow}}
	if got := permrules.Evaluate(append(explore, rulesOf(t, patches[1])...), "edit", "a"); got != permrules.Deny {
		t.Errorf("explore child edit = %s, want its deny kept", got)
	}
	// The authoritative application, naming the same agent, sends nothing new.
	if err := b.ApplyChildRules(ctx, "/ws", "ses_g", "general"); err != nil {
		t.Fatal(err)
	}
	if _, patches, _ = f.snapshot(); len(patches) != 2 {
		t.Errorf("patches = %d after the confirming application, want still 2", len(patches))
	}
}

// Under Deny opencode drops the blocked tools from the model's list without a
// word, so every prompt tells the model why, as the turn's system prompt (an
// instruction, never part of what the person said); under Ask and Allow
// nothing is added.
func TestDenyPromptsTellTheModelWhyToolsAreMissing(t *testing.T) {
	b, f := newPermFake(t, func() permrules.Layers { return permrules.Layers{} })
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/ws", backend.CreateSessionOptions{})
	for _, c := range []struct {
		mode permrules.Action
		want bool
	}{{permrules.Ask, false}, {permrules.Deny, true}, {permrules.Allow, false}} {
		if err := b.SetPermissionMode(ctx, "/ws", s.ID, c.mode); err != nil {
			t.Fatal(err)
		}
		if err := b.Prompt(ctx, "/ws", s.ID, backend.Prompt{Text: "curl example.com"}); err != nil {
			t.Fatal(err)
		}
		_, _, prompts := f.snapshot()
		last := prompts[len(prompts)-1]
		if got := last["system"] == denyNote; got != c.want {
			t.Errorf("%s: system = %v, want the deny note: %v", c.mode, last["system"], c.want)
		}
		if parts, _ := last["parts"].([]any); len(parts) != 1 {
			t.Errorf("%s: parts = %v, want only the person's text", c.mode, parts)
		}
	}
}
