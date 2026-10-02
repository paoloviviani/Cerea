package opencode

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
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
			_, _ = io.WriteString(w, fakeAgents)
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
		if r.Permission == "session_spawn" || r.Action == permrules.Allow {
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

func TestRemovingASavedApprovalOnlyAcceptsListedIDs(t *testing.T) {
	b, f := newPermFake(t, nil)
	f.saved = []map[string]any{{"id": "sav_1", "projectID": "p", "action": "bash", "resource": "ls *"}}
	list, err := b.SavedApprovals(context.Background())
	if err != nil || len(list) != 1 || list[0].ID != "sav_1" || list[0].Action != "bash" || list[0].Resource != "ls *" {
		t.Fatalf("list = %+v, %v", list, err)
	}
	if err := b.RemoveSavedApproval(context.Background(), "../session/ses_1"); err == nil {
		t.Error("an id the listing does not name was passed to opencode")
	}
	if len(f.deleted) != 0 {
		t.Errorf("deleted = %v, want none", f.deleted)
	}
	if err := b.RemoveSavedApproval(context.Background(), "sav_1"); err != nil {
		t.Fatal(err)
	}
	if len(f.deleted) != 1 || f.deleted[0] != "sav_1" {
		t.Errorf("deleted = %v", f.deleted)
	}
}

func TestFloorConfigMergesOverThePinnedContent(t *testing.T) {
	base := map[string]any{
		"model":      "pystino/m",
		"permission": map[string]any{"read": "allow"},
		"agent":      map[string]any{"build": map[string]any{"model": "pystino/m", "permission": map[string]any{"read": "allow"}}},
	}
	body, err := floorConfig(base, permrules.Ceiling{Max: map[string]permrules.Action{"bash": permrules.Deny}})
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
