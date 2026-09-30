package main

import (
	"strings"
	"testing"

	"galopin/internal/backend"
)

func TestModeAllowed(t *testing.T) {
	cases := []struct {
		caller, requested string
		want              string
		refuse            string
	}{
		{"", "", "", ""},
		{"", "inherit", "", ""},
		{"plan", "inherit", "plan", ""},
		{"plan", "plan", "plan", ""},
		{"build", "plan", "plan", ""},
		{"", "plan", "plan", ""},         // the strictest mode is safe from any caller
		{"", "build", "", "cannot rank"}, // an empty mode is the backend's unverified default
		{"plan", "build", "", "more permissive"},
		{"custom", "plan", "", "can rank against"},
		{"custom", "custom", "custom", ""},
		{"plan", "custom", "", "can rank against"},
	}
	for _, c := range cases {
		got, err := modeAllowed(c.caller, c.requested)
		if c.refuse != "" {
			if err == nil || !strings.Contains(err.Error(), c.refuse) {
				t.Errorf("modeAllowed(%q,%q) = %q, %v; want refusal %q", c.caller, c.requested, got, err, c.refuse)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("modeAllowed(%q,%q) = %q, %v; want %q", c.caller, c.requested, got, err, c.want)
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

func TestNoMorePermissive(t *testing.T) {
	cases := []struct {
		sender, target string
		want           bool
	}{
		{"build", "build", true},
		{"build", "plan", true},
		{"plan", "plan", true},
		{"plan", "build", false},
		{"build", "custom", false},  // an unrankable target counts as more permissive
		{"custom", "custom", false}, // ...even when it is the sender's own mode
		{"custom", "plan", false},   // an unrankable sender is never read as permissive
		{"custom", "build", false},
		{"", "build", false}, // an empty mode is the backend's unverified default: unknown
		{"build", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		if got := noMorePermissive(c.sender, c.target); got != c.want {
			t.Errorf("noMorePermissive(%q,%q) = %v, want %v", c.sender, c.target, got, c.want)
		}
	}
}
