package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/internal/decide"
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

func TestParseLimitFlags(t *testing.T) {
	got, err := parseLimitFlags([]string{"command=run", " outside = never ", "loop=stop", "secrets=never"})
	if err != nil || got[decide.ClassCommand] != decide.Run || got[decide.ClassOutside] != decide.Never ||
		got[decide.ClassLoop] != decide.Stop || got[decide.ClassSecrets] != decide.Never {
		t.Fatalf("parse = %v, %v", got, err)
	}
	for _, bad := range []string{"command", "=ask", "command=", "command=maybe", "colour=ask", "secrets=run", "loop=run", "loop=never", "command=allow", "command=deny"} {
		if _, err := parseLimitFlags([]string{bad}); err == nil {
			t.Errorf("%q: want a refusal", bad)
		}
	}
	if _, err := parseLimitFlags([]string{"secrets=run"}); err == nil || !strings.Contains(err.Error(), "never or ask") {
		t.Errorf("the refusal must say what the class takes: %v", err)
	}
}

func TestPolicySetLimitsOnlyTighten(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	start := policy.Default()
	start.Permission.Limits["edit"] = "run"
	if err := policy.Save(path, start); err != nil {
		t.Fatal(err)
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--limit", "edit=ask", "--limit", "command=never", "--limit", "loop=stop", "--no-auto-accept"}); err != nil {
		t.Fatal(err)
	}
	got, err := policy.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if l := got.Permission.Limits; l["edit"] != "ask" || l["command"] != "never" || l["loop"] != "stop" || l["web"] != "run" {
		t.Errorf("after set: %+v", l)
	}
	for _, loosen := range []string{"command=ask", "command=run", "loop=ask", "edit=run"} {
		if err := runPolicySet([]string{"--state-dir", dir, "--limit", loosen}); err == nil || !strings.Contains(err.Error(), "re-run enroll") {
			t.Errorf("--limit %s: err = %v, want a refusal naming enroll", loosen, err)
		}
	}
	after, _ := policy.Load(path)
	if after.Permission.Limits["command"] != "never" || after.Permission.Limits["edit"] != "ask" {
		t.Errorf("a refused set changed the file: %+v", after.Permission.Limits)
	}
}

func TestPolicySetAliasesMapOntoClassesAndOnlyTighten(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	if err := policy.Save(path, policy.Default()); err != nil {
		t.Fatal(err)
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--permission-max", "webfetch=ask", "--permission-max", "bash=deny"}); err != nil {
		t.Fatal(err)
	}
	got, _ := policy.Load(path)
	if l := got.Permission.Limits; l["web"] != "ask" || l["command"] != "never" {
		t.Errorf("aliases did not map to classes: %+v", l)
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--permission-max", "bash=ask"}); err == nil {
		t.Error("raising bash from deny to ask must be refused")
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--permission-rule", "edit=allow"}); err == nil {
		t.Error("a rule's allow is not a tightening")
	}
}

func TestEnrollDefaultsAndStaticFile(t *testing.T) {
	c := policy.Default().Permission.Ceiling()
	if got := c.Keys(); len(got) != 1 || got[0] != "bash" || c.Of("bash") != "ask" {
		t.Errorf("default ceiling keys = %v, want bash=ask alone (the command class; everything else runs)", got)
	}
	cfg := buildOpencodeConfig("127.0.0.1:1", "s", nil, false, false)
	cfg.Permission = staticPermission()
	for _, k := range []string{"edit", "bash", "webfetch"} {
		if cfg.Permission[k] != "ask" {
			t.Errorf("static %s = %q, want ask", k, cfg.Permission[k])
		}
	}
}

func TestPermissionSummaryIsTheClassTable(t *testing.T) {
	s := permissionPolicySummary(policy.Default())
	for _, want := range []string{"edit ", "command", "web ", "outside", "secrets", "agents", "tools", "loop",
		"judged before it happens, by whoever Cerea routes it to", "start on Ask", "never allowed, whatever the table says"} {
		if !strings.Contains(s, want) {
			t.Errorf("summary lacks %q:\n%s", want, s)
		}
	}
	pol := policy.Default()
	pol.Permission.Limits["command"] = "never"
	pol.Permission.Notices = []string{"your own allow rules for the edit class were dropped"}
	s = permissionPolicySummary(pol)
	if !strings.Contains(s, "never allowed") || !strings.Contains(s, "Note: your own allow rules for the edit class were dropped") {
		t.Errorf("summary = %s", s)
	}
}

func TestEnrollPolicyDefaultsAndFlags(t *testing.T) {
	pol, err := enrollPolicy(&enrollOptions{maxTerminals: policy.DefaultMaxTerminals})
	if err != nil {
		t.Fatal(err)
	}
	for c, want := range policy.DefaultLimits() {
		if pol.Permission.Limits[c] != want {
			t.Errorf("default enroll %s = %s, want %s", c, pol.Permission.Limits[c], want)
		}
	}
	if len(pol.Permission.Rules) != 0 {
		t.Errorf("default enroll rules = %v", pol.Permission.Rules)
	}

	pol, err = enrollPolicy(&enrollOptions{allowAutoAccept: true, limits: []string{"edit=ask", "command=run"}, maxTerminals: 8})
	if err != nil {
		t.Fatal(err)
	}
	if l := pol.Permission.Limits; l["edit"] != "ask" || l["command"] != "run" || l["web"] != "run" || l["outside"] != "ask" {
		t.Errorf("flagged enroll limits = %+v", l)
	}
	for _, bad := range []string{"command=sometimes", "secrets=run", "nope=ask"} {
		if _, err := enrollPolicy(&enrollOptions{limits: []string{bad}}); err == nil {
			t.Errorf("--limit %s was accepted", bad)
		}
	}
	if _, err := enrollPolicy(&enrollOptions{permissionMax: []string{"bash=sometimes"}}); err == nil {
		t.Error("a bad action word was accepted")
	}
	// The policy it writes is one Load accepts back, with no autoAccept field.
	path := filepath.Join(t.TempDir(), policyFileName)
	if err := policy.Save(path, pol); err != nil {
		t.Fatal(err)
	}
	back, err := policy.Load(path)
	if err != nil {
		t.Fatalf("the enrolled policy does not load back: %v", err)
	}
	if back.Permission.Limits["edit"] != "ask" {
		t.Errorf("limits lost in the round trip: %+v", back.Permission.Limits)
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), "autoAccept") || strings.Contains(string(raw), `"max"`) {
		t.Errorf("policy.json carries a retired field:\n%s", raw)
	}
}

func TestOldPermissionFlagsAreAliasesOntoClasses(t *testing.T) {
	// --permission-max states ceilings per key: a class takes the most cautious
	// of its named keys, the old default (bash=ask) is not implied.
	pol, err := enrollPolicy(&enrollOptions{permissionMax: []string{"edit=ask", "webfetch=deny"}, maxTerminals: 8})
	if err != nil {
		t.Fatal(err)
	}
	if l := pol.Permission.Limits; l["edit"] != "ask" || l["web"] != "never" || l["command"] != "ask" {
		t.Errorf("alias limits = %+v (the machine's default command=ask stays: a re-enroll keeps what it does not name)", l)
	}
	pol, err = enrollPolicy(&enrollOptions{permissionMax: []string{"bash=allow"}, permissionRules: []string{"external_directory=allow"}, maxTerminals: 8})
	if err != nil {
		t.Fatal(err)
	}
	if l := pol.Permission.Limits; l["command"] != "run" || l["outside"] != "run" {
		t.Errorf("alias limits = %+v", l)
	}
	// A rule that covers only some keys of a class is not carried.
	pol, err = enrollPolicy(&enrollOptions{permissionRules: []string{"webfetch=allow"}, maxTerminals: 8})
	if err != nil {
		t.Fatal(err)
	}
	if len(pol.Permission.Rules) != 0 {
		t.Errorf("a partial class rule was carried: %v", pol.Permission.Rules)
	}
	lims, _, notices, err := legacyLimits([]string{"bash=ask"}, nil)
	if err != nil || lims[decide.ClassCommand] != decide.AskLimit || !strings.Contains(strings.Join(notices, "\n"), "deprecated") {
		t.Errorf("legacyLimits = %v %v %v", lims, notices, err)
	}
}

func TestStaticOpencodeConfigCarriesThePermissionBlock(t *testing.T) {
	cfg := buildOpencodeConfig("127.0.0.1:1", "s", nil, false, false)
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

// The agents class carries session_read and session_send together: a fresh
// machine leaves both uncapped, and tightening the class caps both.
func TestAgentsClassCoversTheSessionTools(t *testing.T) {
	pol, err := enrollPolicy(&enrollOptions{limits: []string{"agents=ask"}, maxTerminals: 8})
	if err != nil {
		t.Fatal(err)
	}
	c := pol.Permission.Ceiling()
	for _, k := range []string{"session_read", "session_send", "session_spawn", "task", "schedule"} {
		if c.Of(k) != "ask" {
			t.Errorf("agents=ask leaves %s at %s", k, c.Of(k))
		}
	}
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	if err := policy.Save(path, pol); err != nil {
		t.Fatal(err)
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--limit", "agents=never"}); err != nil {
		t.Fatal(err)
	}
	if got, _ := policy.Load(path); got.Permission.Ceiling().Of("session_read") != "deny" {
		t.Errorf("tightened = %v", got.Permission.Limits)
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--limit", "agents=ask"}); err == nil {
		t.Error("loosening agents must be refused")
	}
}
