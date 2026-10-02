package main

import (
	"encoding/json"
	"strings"
	"testing"

	"galopin/internal/policy"
)

// Cerea validates the hello strictly and silently drops one it cannot parse,
// so a default policy (no workspace roots) must still send an array.
func TestHelloSendsEmptyWorkspaceRootsNotNull(t *testing.T) {
	body, err := json.Marshal(buildHello(newE2EFakeBackend(), policy.Default()))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"workspaceRoots":[]`) {
		t.Fatalf("hello policy must carry workspaceRoots as [], got %s", body)
	}
}

// The permission policy rides in the hello so the panel can explain a capped
// "always" or a missing toggle; the old autoAccept word stays as a mirror of
// responders (Cerea's hello schema still requires it).
func TestHelloCarriesThePermissionPolicy(t *testing.T) {
	pol := policy.Default()
	pol.Permission = policy.Permission{Responders: policy.TerminalAllowed, Max: map[string]string{"bash": "ask"}}
	body, err := json.Marshal(buildHello(newE2EFakeBackend(), pol))
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Policy struct {
			AutoAccept string `json:"autoAccept"`
			Permission struct {
				Responders string            `json:"responders"`
				Max        map[string]string `json:"max"`
			} `json:"permission"`
		} `json:"policy"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Policy.AutoAccept != "allowed" || got.Policy.Permission.Responders != "allowed" || got.Policy.Permission.Max["bash"] != "ask" {
		t.Errorf("hello policy = %s", body)
	}
	// And a default policy still sends the strings and an object, never null.
	body, _ = json.Marshal(buildHello(newE2EFakeBackend(), policy.Default()))
	if !strings.Contains(string(body), `"autoAccept":"denied"`) || !strings.Contains(string(body), `"max":{}`) {
		t.Errorf("default hello policy = %s", body)
	}
}
