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
		{"read outside the workspace asks", ask("read", []any{map[string]any{"path": "/etc/shadow"}}, nil), permrules.Allow, decide.Card},
	}
	for _, c := range cases {
		key, patterns := b.NormalizeAsk(c.req)
		got := decide.Decide(decide.Policy{}, decide.State{Mode: c.mode}, decide.Request{Key: key, Patterns: patterns, Workspace: "/w"})
		if got.Verdict != c.want {
			t.Errorf("%s: key %q patterns %v: %s, want %s", c.name, key, patterns, got.Verdict, c.want)
		}
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
