package acp

import (
	"testing"

	"galopin/internal/backend"
	"galopin/internal/decide"
	"galopin/internal/permrules"
)

// session/request_permission goes through the same function as opencode's asks:
// the kind and paths of the tool call become a permission key and patterns.
func TestAcpAsksAreDecidedByTheSameFunction(t *testing.T) {
	b := New(Config{})
	ask := func(kind string, locs []any, raw map[string]any) backend.PermissionRequest {
		tc := map[string]any{"kind": kind, "locations": locs, "rawInput": raw}
		return backend.PermissionRequest{ID: "s:perm:1", SessionID: "s", Tool: kind, Metadata: askMetadata(tc)}
	}
	cases := []struct {
		name string
		req  backend.PermissionRequest
		mode permrules.Action
		want decide.Verdict
	}{
		{"read in ask", ask("read", []any{map[string]any{"path": "/w/a.go"}}, nil), permrules.Ask, decide.Once},
		{"edit in ask", ask("edit", []any{map[string]any{"path": "/w/a.go"}}, nil), permrules.Ask, decide.Card},
		{"execute in plan", ask("execute", nil, map[string]any{"command": "rm -rf /"}), permrules.Deny, decide.Reject},
		{"execute in allow", ask("execute", nil, map[string]any{"command": "ls"}), permrules.Allow, decide.Once},
		{"fetch in plan", ask("fetch", nil, nil), permrules.Deny, decide.Reject},
		{"unknown kind in ask", ask("teleport", nil, nil), permrules.Ask, decide.Card},
		{"unknown kind in allow", ask("teleport", nil, nil), permrules.Allow, decide.Once},
		{"read outside the workspace asks in ask", ask("read", []any{map[string]any{"path": "/etc/shadow"}}, nil), permrules.Ask, decide.Card},
	}
	for _, c := range cases {
		key, patterns := b.NormalizeAsk(c.req)
		got := decide.Decide(decide.Policy{}, decide.State{Mode: c.mode}, decide.Request{Key: key, Patterns: patterns, Workspace: "/w"})
		if got.Verdict != c.want {
			t.Errorf("%s: key %q patterns %v: %s, want %s", c.name, key, patterns, got.Verdict, c.want)
		}
	}
}

// goose sends kind "other" on every ask; the shell, write and tree tools are
// told apart by their raw input and title (found live against goose 1.57.0).
func TestAcpOtherKindIsInferredForGoose(t *testing.T) {
	b := New(Config{})
	ask := func(title string, raw map[string]any) backend.PermissionRequest {
		tc := map[string]any{"kind": "other", "title": title, "rawInput": raw}
		return backend.PermissionRequest{ID: "s:perm:1", SessionID: "s", Tool: "other", Title: title, Metadata: askMetadata(tc)}
	}
	cases := []struct {
		name string
		req  backend.PermissionRequest
		mode permrules.Action
		want decide.Verdict
		key  string
	}{
		{"shell in plan", ask("shell · rm -rf x", map[string]any{"command": "rm -rf x"}), permrules.Deny, decide.Reject, "bash"},
		{"shell in ask", ask("shell · cat a.txt", map[string]any{"command": "cat a.txt"}), permrules.Ask, decide.Card, "bash"},
		{"write in ask", ask("write · b.txt", map[string]any{"path": "b.txt", "content": "hi"}), permrules.Ask, decide.Card, "edit"},
		{"write in plan", ask("write · b.txt", map[string]any{"path": "b.txt", "content": "hi"}), permrules.Deny, decide.Reject, "edit"},
		{"tree in ask", ask("tree · .", map[string]any{"path": ".", "depth": 1}), permrules.Ask, decide.Once, "read"},
		{"unknown tool stays cautious", ask("frobnicate · x", map[string]any{"x": 1}), permrules.Ask, decide.Card, "acp_other"},
	}
	for _, c := range cases {
		key, patterns := b.NormalizeAsk(c.req)
		if key != c.key {
			t.Errorf("%s: key %q, want %q", c.name, key, c.key)
		}
		got := decide.Decide(decide.Policy{}, decide.State{Mode: c.mode}, decide.Request{Key: key, Patterns: patterns, Workspace: "/w"})
		if got.Verdict != c.want {
			t.Errorf("%s: key %q patterns %v: %s, want %s", c.name, key, patterns, got.Verdict, c.want)
		}
	}
}

// pi-acp forwards the permission-gate extension's confirm as an "other" ask
// titled "pi <tool>" whose message carries the tool call as JSON.
func TestAcpPiGateAskIsUnwrapped(t *testing.T) {
	b := New(Config{})
	ask := func(tool, input string) backend.PermissionRequest {
		tc := map[string]any{"kind": "other", "title": "pi " + tool, "rawInput": map[string]any{
			"method": "confirm", "title": "pi " + tool, "message": `{"tool":"` + tool + `","input":` + input + `}`}}
		return backend.PermissionRequest{ID: "s:perm:1", SessionID: "s", Tool: "other", Title: "pi " + tool, Metadata: askMetadata(tc)}
	}
	cases := []struct {
		name string
		req  backend.PermissionRequest
		mode permrules.Action
		want decide.Verdict
		key  string
	}{
		{"bash in plan", ask("bash", `{"command":"rm -rf x"}`), permrules.Deny, decide.Reject, "bash"},
		{"write in plan", ask("write", `{"path":"b.txt","content":"hi"}`), permrules.Deny, decide.Reject, "edit"},
		{"write outside the workspace asks in ask", ask("write", `{"path":"/etc/x","content":"hi"}`), permrules.Ask, decide.Card, "edit"},
		{"read in ask", ask("read", `{"path":"a.txt"}`), permrules.Ask, decide.Once, "read"},
	}
	for _, c := range cases {
		key, patterns := b.NormalizeAsk(c.req)
		if key != c.key {
			t.Errorf("%s: key %q, want %q", c.name, key, c.key)
		}
		got := decide.Decide(decide.Policy{}, decide.State{Mode: c.mode}, decide.Request{Key: key, Patterns: patterns, Workspace: "/w"})
		if got.Verdict != c.want {
			t.Errorf("%s: key %q patterns %v: %s, want %s", c.name, key, patterns, got.Verdict, c.want)
		}
	}
	// A foreign "pi ..." confirm that is not the gate's shape stays an unknown tool.
	tc := map[string]any{"kind": "other", "title": "pi Trust project?", "rawInput": map[string]any{"method": "confirm", "message": "/w"}}
	req := backend.PermissionRequest{Tool: "other", Metadata: askMetadata(tc)}
	if key, _ := b.NormalizeAsk(req); key != "acp_other" {
		t.Errorf("foreign confirm: key %q, want acp_other", key)
	}
}

func TestAcpSelectorIsGalopinsOwnState(t *testing.T) {
	b := New(Config{})
	if b.PermissionMode("s") != permrules.Ask {
		t.Fatal("a new session must be on Ask")
	}
	_ = b.SetPermissionMode(nil, "", "s", permrules.Deny)
	if b.PermissionMode("s") != permrules.Deny {
		t.Error("the mode was not kept")
	}
	e, _ := b.AddException(nil, "", "s", permrules.Exception{ID: "ex_1", Permission: "bash", Patterns: []string{"ls"}})
	if got := b.Exceptions("s"); len(got) != 1 || got[0].ID != e.ID {
		t.Errorf("exceptions = %+v", got)
	}
}
