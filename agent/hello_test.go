package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"galopin/internal/backend"
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

// The permission policy rides in the hello so the panel can say what a session's
// Allow still cannot do. The old autoAccept word stays as the constant "denied"
// for one more release (Cerea's hello schema still requires it) and there is no
// responders field any more.
func TestHelloCarriesThePermissionPolicy(t *testing.T) {
	pol := policy.Default()
	pol.Permission = policy.Permission{Deny: []string{"command"}}
	pol.Permission.Normalize()
	body, err := json.Marshal(buildHello(newE2EFakeBackend(), pol))
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Policy struct {
			AutoAccept string `json:"autoAccept"`
			Permission struct {
				Max map[string]string `json:"max"`
			} `json:"permission"`
		} `json:"policy"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Policy.AutoAccept != "denied" || got.Policy.Permission.Max["bash"] != "deny" {
		t.Errorf("hello policy = %s", body)
	}
	if strings.Contains(string(body), "responders") {
		t.Errorf("hello still names responders: %s", body)
	}
	// And a default policy still sends the strings and an object, never null.
	body, _ = json.Marshal(buildHello(newE2EFakeBackend(), policy.Default()))
	if !strings.Contains(string(body), `"autoAccept":"denied"`) || !strings.Contains(string(body), `"max":{}`) || strings.Contains(string(body), `"limits"`) {
		t.Errorf("default hello policy = %s", body)
	}
}

// allCapsBackend reports every field of backend.Capabilities true (built by
// reflection, so a capability added to the struct later is covered without
// touching this test).
type allCapsBackend struct{ backend.Backend }

func (allCapsBackend) ID() string      { return "fake-all-caps" }
func (allCapsBackend) Version() string { return "0.0.0" }
func (allCapsBackend) Capabilities() backend.Capabilities {
	caps := backend.Capabilities{}
	v := reflect.ValueOf(&caps).Elem()
	for i := 0; i < v.NumField(); i++ {
		v.Field(i).SetBool(true)
	}
	return caps
}

// Every field of backend.Capabilities must reach the hello's capabilities
// map: Cerea hides affordances a backend lacks from what the map says, so a
// field buildHello forgets is a feature that silently never switches on
// (agentTools and steer were both lost this way). The assertion walks the
// struct, so a new capability cannot be forgotten again.
func TestHelloAdvertisesEveryCapability(t *testing.T) {
	caps := buildHello(allCapsBackend{}, policy.Default()).Backends[0].Capabilities
	typ := reflect.TypeOf(backend.Capabilities{})
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		key := strings.Split(field.Tag.Get("json"), ",")[0]
		if key == "" || key == "-" {
			t.Fatalf("capability field %s carries no json name", field.Name)
		}
		got, ok := caps[key]
		if !ok {
			t.Errorf("hello capabilities miss %q (field %s): %v", key, field.Name, caps)
			continue
		}
		if !got {
			t.Errorf("backend reports %q true but the hello sends it false", key)
		}
	}
	if len(caps) != typ.NumField() {
		t.Errorf("hello capabilities carry %d keys for %d capability fields", len(caps), typ.NumField())
	}
}

// files.write is built in: the capability says so whatever the policy, and the
// policy says separately whether the owner allows it (denied by default).
func TestHelloReportsFileWriteCapabilityAndPolicy(t *testing.T) {
	h := buildHello(allCapsBackend{}, policy.Default())
	if !h.Machine.Capabilities["fileWrite"] {
		t.Errorf("machine capabilities = %v, want fileWrite true", h.Machine.Capabilities)
	}
	if h.Policy.FileWrite != policy.FileWriteDenied {
		t.Errorf("policy.fileWrite = %q, want denied by default", h.Policy.FileWrite)
	}
	pol := policy.Default()
	pol.FileWrite = policy.FileWriteAllowed
	if got := buildHello(allCapsBackend{}, pol).Policy.FileWrite; got != policy.FileWriteAllowed {
		t.Errorf("policy.fileWrite = %q, want allowed", got)
	}
	// A connectors-only machine serves no files at all.
	c := buildConnectorsHello(pol)
	if c.Machine.Capabilities["fileWrite"] || c.Policy.FileWrite != policy.FileWriteDenied {
		t.Errorf("connectors hello: capability %v, policy %q", c.Machine.Capabilities["fileWrite"], c.Policy.FileWrite)
	}
}
