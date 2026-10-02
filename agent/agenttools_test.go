package main

import (
	"testing"

	"galopin/internal/backend"
)

func TestSpawnMode(t *testing.T) {
	cases := []struct {
		caller, requested string
		want              string
		escalates         bool
	}{
		{"", "", "", false},
		{"", "inherit", "", false},
		{"plan", "inherit", "plan", false},
		{"plan", "plan", "plan", false},
		{"build", "plan", "plan", false},
		{"", "plan", "plan", false},       // the read-only built-in is never an escalation
		{"custom", "plan", "plan", false}, // ...from any caller
		{"custom", "custom", "custom", false},
		{"build", "build", "build", false},
		{"", "build", "build", true}, // an empty mode is the backend's unverified default
		{"plan", "build", "build", true},
		{"plan", "custom", "custom", true},
		{"build", "custom", "custom", true}, // a name galopin cannot compare is never read as stricter
	}
	for _, c := range cases {
		got, esc := spawnMode(c.caller, c.requested)
		if got != c.want || esc != c.escalates {
			t.Errorf("spawnMode(%q,%q) = %q, %v; want %q, %v", c.caller, c.requested, got, esc, c.want, c.escalates)
		}
	}
}

func TestSpawnChain(t *testing.T) {
	marks := map[string]backend.SpawnedBy{"c1": {SessionID: "r"}, "c2": {SessionID: "c1"}}
	if d, root := spawnChain(marks, "r"); d != 0 || root != "r" {
		t.Errorf("root: %d %s", d, root)
	}
	if d, root := spawnChain(marks, "c2"); d != 2 || root != "r" {
		t.Errorf("c2: %d %s", d, root)
	}
	cyclic := map[string]backend.SpawnedBy{"a": {SessionID: "b"}, "b": {SessionID: "a"}}
	if d, _ := spawnChain(cyclic, "a"); d < maxSpawnDepth {
		t.Errorf("a marker cycle must read as deep, got %d", d)
	}
}

func TestDecodeArgsRefusesUnknownKeys(t *testing.T) {
	if _, err := decodeArgs([]byte(`{"title":"t","prompt":"p","mode":"m","workspaceId":"w"}`), "title", "prompt", "mode"); err == nil {
		t.Error("a workspaceId argument must be refused")
	}
	if _, err := decodeArgs([]byte(`{"title":1}`), "title"); err == nil {
		t.Error("a non-string argument must be refused")
	}
	if got, err := decodeArgs([]byte(`{"title":"t"}`), "title"); err != nil || got["title"] != "t" {
		t.Errorf("valid args: %v %v", got, err)
	}
}
