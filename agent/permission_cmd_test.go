package main

import (
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
	start.Permission = policy.Permission{Responders: policy.TerminalAllowed, Max: map[string]string{"bash": "ask"}}
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
	if got.Permission.Max["bash"] != "deny" || got.Permission.Max["edit"] != "ask" || got.Permission.RespondersAllowed() {
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
	if got := defaultEnrollMax(); got["bash"] != "ask" || len(got) != 1 {
		t.Errorf("default ceiling = %v, want only bash=ask", got)
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
	if s := permissionPolicySummary(pol); !strings.Contains(s, "DENIED") || !strings.Contains(s, "no ceiling") {
		t.Errorf("default summary = %q", s)
	}
	pol.Permission = policy.Permission{Responders: policy.TerminalAllowed, Max: map[string]string{"bash": "ask"}, Rules: map[string]string{"edit": "allow"}}
	s := permissionPolicySummary(pol)
	for _, want := range []string{"bash≤ask", "edit=allow", "ALLOWED"} {
		if !strings.Contains(s, want) {
			t.Errorf("summary %q lacks %q", s, want)
		}
	}
}
