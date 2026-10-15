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
	// patchIDs parallels patches with the session each PATCH named, so a
	// test can count one session's own PATCHes.
	patchIDs []string
	prompts  []map[string]any
	saved    []map[string]any
	deleted  []string
	agents   string // GET /agent's answer; fakeAgents when empty
	// gone answers PATCH /session/<id> with the status (404 for a child
	// opencode no longer has, 500 for one that merely fails), opencode's
	// NotFoundError body for the 404.
	gone map[string]int
	// stored answers GET /session/<id> with these exact rules as its
	// permission field (what opencode keeps for the session), so the
	// stale-deny detector can be driven without a real server history.
	stored map[string][]permrules.Rule
	// gets parallels stored reads: every GET /session/<id> received, so a
	// test can tell whether detection re-read or used its cache.
	gets []string
}

func (f *permFake) snapshot() (creates, patches, prompts []map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.creates...), append([]map[string]any(nil), f.patches...), append([]map[string]any(nil), f.prompts...)
}

// patchCount is how many PATCHes the fake received naming sessionID —
// received, answered however.
func (f *permFake) patchCount(sessionID string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, id := range f.patchIDs {
		if id == sessionID {
			n++
		}
	}
	return n
}

// getCount is how many GET /session/<id> reads the fake received — the
// stale-deny detector's read, which it must skip when nothing moved.
func (f *permFake) getCount(sessionID string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, id := range f.gets {
		if id == sessionID {
			n++
		}
	}
	return n
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
			id := strings.TrimPrefix(r.URL.Path, "/session/")
			f.patchIDs = append(f.patchIDs, id)
			if status, dead := f.gone[id]; dead {
				w.WriteHeader(status)
				if status == http.StatusNotFound {
					_, _ = io.WriteString(w, `{"name":"NotFoundError","data":{"message":"Session not found: `+id+`"}}`)
				}
				return
			}
			f.patches = append(f.patches, parsed)
			_, _ = io.WriteString(w, `{"id":"ses_1","title":"t"}`)
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/session/"):
			id := strings.TrimPrefix(r.URL.Path, "/session/")
			f.gets = append(f.gets, id)
			if rules, ok := f.stored[id]; ok {
				out, _ := json.Marshal(map[string]any{"id": id, "title": "t", "permission": rules})
				_, _ = w.Write(out)
				break
			}
			_, _ = io.WriteString(w, `{"id":"`+id+`","title":"t"}`)
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

func TestCreateSessionWritesNoRules(t *testing.T) {
	b, f := newPermFake(t, ceilingAsk("bash"))
	if _, err := b.CreateSession(context.Background(), "/ws", backend.CreateSessionOptions{}); err != nil {
		t.Fatal(err)
	}
	creates, patches, _ := f.snapshot()
	if len(creates) != 1 || creates[0]["permission"] != nil {
		t.Errorf("create body = %v, want no permission field (ADR 0097)", creates)
	}
	if len(patches) != 0 {
		t.Errorf("patches = %v, want none", patches)
	}
}

// A session's stored rule count stays constant across any number of selector
// changes: nothing is written to opencode when the word, an exception or a
// grant changes.
func TestTenModeChangesWriteNothing(t *testing.T) {
	b, f := newPermFake(t, ceilingAsk("bash"))
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/ws", backend.CreateSessionOptions{})
	modes := []permrules.Action{permrules.Deny, permrules.Allow, permrules.Ask, permrules.Deny, permrules.Allow, permrules.Ask, permrules.Allow, permrules.Deny, permrules.Ask, permrules.Allow}
	for i, m := range modes {
		if err := b.SetPermissionMode(ctx, "/ws", s.ID, m); err != nil {
			t.Fatal(err)
		}
		if _, err := b.AddException(ctx, "/ws", s.ID, permrules.Exception{ID: "ex_" + strconv.Itoa(i), Permission: "bash", Patterns: []string{"ls " + strconv.Itoa(i)}}); err != nil {
			t.Fatal(err)
		}
		if err := b.Prompt(ctx, "/ws", s.ID, backend.Prompt{Text: "go"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := b.SetCoordination(ctx, "/ws", s.ID, []string{"session_read"}); err != nil {
		t.Fatal(err)
	}
	if n := f.patchCount(s.ID); n != 0 {
		t.Errorf("%d PATCHes after ten mode changes, ten exceptions and a grant, want 0", n)
	}
	if got := b.PermissionMode(s.ID); got != permrules.Allow {
		t.Errorf("mode = %s, want the last one set (allow)", got)
	}
}

func TestPromptNeverPatchesACleanSession(t *testing.T) {
	b, f := newPermFake(t, ceilingAsk("bash"))
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/ws", backend.CreateSessionOptions{})
	for i := 0; i < 3; i++ {
		if err := b.Prompt(ctx, "/ws", s.ID, backend.Prompt{Text: "go"}); err != nil {
			t.Fatal(err)
		}
	}
	if n := f.patchCount(s.ID); n != 0 {
		t.Errorf("a session with no stored rules was PATCHed %d times", n)
	}
}

// A session an older galopin gave rules gets ONE neutralising rule, last, and
// never another, across prompts and a restart of galopin (the overlay says so).
func TestLegacySessionIsNeutralisedOnceAndNeverAgain(t *testing.T) {
	dir := t.TempDir()
	b, f := newPermFake(t, ceilingAsk("bash"))
	b.cfg.OverlayPath = dir + "/overlay.json"
	f.stored = map[string][]permrules.Rule{"ses_old": {
		{Permission: "*", Pattern: "*", Action: permrules.Deny},
		{Permission: "bash", Pattern: "*", Action: permrules.Allow},
	}}
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if err := b.Prompt(ctx, "/ws", "ses_old", backend.Prompt{Text: "go"}); err != nil {
			t.Fatal(err)
		}
	}
	if n := f.patchCount("ses_old"); n != 1 {
		t.Fatalf("PATCHes = %d, want exactly one", n)
	}
	_, patches, _ := f.snapshot()
	rules := rulesOf(t, patches[0])
	if len(rules) != 1 || rules[0] != (permrules.Rule{Permission: "*", Pattern: "*", Action: permrules.Ask}) {
		t.Errorf("neutralising block = %+v, want the single `* * ask`", rules)
	}
	if !b.StaleDeny("ses_old") {
		t.Error("the stale blanket deny is not reported: the banner stays for legacy sessions")
	}
	if err := b.saveOverlay(); err != nil {
		t.Fatal(err)
	}
	b2, _ := newPermFake(t, ceilingAsk("bash"))
	b2.cfg.OverlayPath = b.cfg.OverlayPath
	if err := b2.loadOverlay(); err != nil {
		t.Fatal(err)
	}
	if !b2.getOverlay("ses_old").Neutralised {
		t.Error("the overlay does not remember the neutralising rule, so a restart would write again")
	}
}

func TestPlanNoteRidesOnPlanPromptsOnly(t *testing.T) {
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
		if got := last["system"] == planNote; got != c.want {
			t.Errorf("%s: system = %v, want the plan note: %v", c.mode, last["system"], c.want)
		}
	}
}

func TestPendingAsksListsWhatOpencodeStillHolds(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/permission" {
			_, _ = io.WriteString(w, `[{"id":"per_1","sessionID":"ses_1","permission":"bash","patterns":["ls"],"always":["ls *"]}]`)
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ := strconv.Atoi(portStr)
	b := New(Config{Hostname: host, Port: port, Password: "x"})
	got, err := b.PendingAsks(context.Background())
	if err != nil || len(got) != 1 || got[0].ID != "per_1" || got[0].Tool != "bash" || got[0].SessionID != "ses_1" {
		t.Errorf("PendingAsks = %+v, %v", got, err)
	}
}

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

func TestFloorConfigMergesOverThePinnedContent(t *testing.T) {
	base := map[string]any{
		"model":      "pystino/m",
		"permission": map[string]any{"read": "allow"},
		"agent":      map[string]any{"build": map[string]any{"model": "pystino/m"}},
	}
	body, err := floorConfig(base, nil)
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
	if got["permission"].(map[string]any)["read"] != "ask" {
		t.Errorf("the floor must beat a pinned read allow: %v", got["permission"])
	}
	if got["agent"].(map[string]any)["build"].(map[string]any)["model"] != "pystino/m" {
		t.Error("build's pinned model was lost")
	}
	if base["permission"].(map[string]any)["read"] != "allow" {
		t.Error("floorConfig mutated its base")
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
