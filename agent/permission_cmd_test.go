package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/internal/policy"
)

func TestParseKeyActions(t *testing.T) {
	got, err := parseKeyActions("permission-max", []string{"bash=ask", " edit = deny "})
	if err != nil || got["bash"] != "ask" || got["edit"] != "deny" {
		t.Fatalf("parse = %v, %v", got, err)
	}
	for _, bad := range []string{"bash", "=ask", "bash=maybe", "*=deny", "ba*=ask"} {
		if _, err := parseKeyActions("permission-max", []string{bad}); err == nil {
			t.Errorf("%q: want a refusal", bad)
		}
	}
}

func TestTightenOnlyLowers(t *testing.T) {
	have := map[string]string{"bash": "ask", "edit": "allow"}
	got, err := tighten("permission-max", have, map[string]string{"bash": "deny", "edit": "ask", "webfetch": "ask"})
	if err != nil {
		t.Fatal(err)
	}
	if got["bash"] != "deny" || got["edit"] != "ask" || got["webfetch"] != "ask" {
		t.Errorf("tightened = %v", got)
	}
	if have["bash"] != "ask" {
		t.Error("tighten must not mutate its input")
	}
	// Same value is a no-op, not a refusal.
	if _, err := tighten("permission-max", have, map[string]string{"bash": "ask"}); err != nil {
		t.Errorf("an unchanged value: %v", err)
	}
	// Loosening is refused and names the re-run.
	for _, want := range []map[string]string{{"bash": "allow"}, {"bash": "ask", "edit": "allow"}} {
		_, err := tighten("permission-max", have, want)
		if want["bash"] == "allow" && (err == nil || !strings.Contains(err.Error(), "re-run enroll")) {
			t.Errorf("%v: err = %v, want a refusal naming enroll", want, err)
		}
	}
	// A key absent from have reads as allow: setting allow there is no change,
	// and a rule's allow where there was none is not accepted as a tightening.
	if got, err := tighten("permission-rule", nil, map[string]string{"edit": "allow"}); err != nil || len(got) != 0 {
		t.Errorf("allow over nothing = %v, %v; want it ignored", got, err)
	}
}

func TestPolicySetPermissionFlagsOnlyTighten(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	start := policy.Default()
	start.Permission = policy.Permission{Max: map[string]string{"bash": "ask"}}
	if err := policy.Save(path, start); err != nil {
		t.Fatal(err)
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--permission-max", "edit=ask", "--permission-max", "bash=deny", "--no-auto-accept"}); err != nil {
		t.Fatal(err)
	}
	got, err := policy.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.Permission.Max["bash"] != "deny" || got.Permission.Max["edit"] != "ask" {
		t.Errorf("after set: %+v", got.Permission)
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--permission-max", "bash=ask"}); err == nil {
		t.Error("raising bash from deny to ask must be refused")
	}
	after, _ := policy.Load(path)
	if after.Permission.Max["bash"] != "deny" {
		t.Errorf("a refused set changed the file: %+v", after.Permission)
	}
}

func TestEnrollDefaultsAndStaticFile(t *testing.T) {
	if got := defaultEnrollMax(); got["bash"] != "ask" || got["session_spawn"] != "ask" || len(got) != 2 {
		t.Errorf("default ceiling = %v, want bash=ask and session_spawn=ask", got)
	}
	cfg := buildOpencodeConfig("127.0.0.1:1", "s", nil, false)
	cfg.Permission = staticPermission()
	for _, k := range []string{"edit", "bash", "webfetch"} {
		if cfg.Permission[k] != "ask" {
			t.Errorf("static %s = %q, want ask", k, cfg.Permission[k])
		}
	}
}

func TestPermissionSummaryNamesTheTrade(t *testing.T) {
	pol := policy.Default()
	if s := permissionPolicySummary(pol); !strings.Contains(s, "start on Ask") || !strings.Contains(s, "no ceiling") {
		t.Errorf("default summary = %q", s)
	}
	pol.Permission = policy.Permission{Max: map[string]string{"bash": "ask"}, Rules: map[string]string{"edit": "allow"}}
	s := permissionPolicySummary(pol)
	for _, want := range []string{"bash≤ask", "edit=allow", "start on Ask"} {
		if !strings.Contains(s, want) {
			t.Errorf("summary %q lacks %q", s, want)
		}
	}
}

func TestEnrollPolicyDefaultsAndFlags(t *testing.T) {
	pol, err := enrollPolicy(&enrollOptions{maxTerminals: policy.DefaultMaxTerminals})
	if err != nil {
		t.Fatal(err)
	}
	if pol.Permission.Max["bash"] != "ask" || pol.Permission.Max["session_spawn"] != "ask" || len(pol.Permission.Max) != 2 || len(pol.Permission.Rules) != 0 {
		t.Errorf("default enroll permission = %+v, want bash=ask and session_spawn=ask", pol.Permission)
	}

	pol, err = enrollPolicy(&enrollOptions{allowAutoAccept: true, permissionMax: []string{"edit=ask"}, permissionRules: []string{"session_send=allow"}, maxTerminals: 8})
	if err != nil {
		t.Fatal(err)
	}
	if pol.Permission.Max["edit"] != "ask" || pol.Permission.Max["bash"] != "" || pol.Permission.Rules["session_send"] != "allow" {
		t.Errorf("flagged enroll permission = %+v: --allow-auto-accept is a no-op now, a given ceiling replaces the default", pol.Permission)
	}

	if _, err := enrollPolicy(&enrollOptions{permissionMax: []string{"bash=sometimes"}}); err == nil {
		t.Error("a bad action word was accepted")
	}
	// The policy it writes is one Load accepts back, with no autoAccept field.
	path := filepath.Join(t.TempDir(), policyFileName)
	if err := policy.Save(path, pol); err != nil {
		t.Fatal(err)
	}
	if _, err := policy.Load(path); err != nil {
		t.Errorf("the enrolled policy does not load back: %v", err)
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), "autoAccept") {
		t.Errorf("policy.json still carries autoAccept:\n%s", raw)
	}
}

func TestStaticOpencodeConfigCarriesThePermissionBlock(t *testing.T) {
	cfg := buildOpencodeConfig("127.0.0.1:1", "s", nil, false)
	cfg.Permission = staticPermission()
	dir := t.TempDir()
	if err := writeOpencodeConfig(filepath.Join(dir, "opencode.json"), cfg); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "opencode.json"))
	var got struct {
		Permission map[string]string `json:"permission"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Permission["edit"] != "ask" || got.Permission["bash"] != "ask" || got.Permission["webfetch"] != "ask" || len(got.Permission) != 3 {
		t.Errorf("written permission block = %v", got.Permission)
	}
}
