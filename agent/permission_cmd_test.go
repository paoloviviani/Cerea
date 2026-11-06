package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/internal/decide"
	"galopin/internal/policy"
)

// captureStderr runs f and returns what it wrote to os.Stderr.
func captureStderr(t *testing.T, f func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stderr
	os.Stderr = w
	done := make(chan string)
	go func() {
		var b bytes.Buffer
		_, _ = io.Copy(&b, r)
		done <- b.String()
	}()
	f()
	os.Stderr = old
	_ = w.Close()
	return <-done
}

func TestParseDenyFlags(t *testing.T) {
	got, err := parseDenyFlags("deny", []string{"command", " web "})
	if err != nil || len(got) != 2 || got[0] != decide.ClassCommand || got[1] != decide.ClassWeb {
		t.Fatalf("parse = %v, %v", got, err)
	}
	for _, bad := range []string{"", "colour", "loop", "command=never"} {
		if _, err := parseDenyFlags("deny", []string{bad}); err == nil {
			t.Errorf("%q: want a refusal", bad)
		}
	}
}

func TestEnrollDefaultsHaveNoLimitsAndNoDeny(t *testing.T) {
	pol, err := enrollPolicy(&enrollOptions{maxTerminals: policy.DefaultMaxTerminals})
	if err != nil {
		t.Fatal(err)
	}
	if pol.Permission.Limits != nil || pol.Permission.Max != nil || pol.Permission.Rules != nil || len(pol.Permission.Deny) != 0 {
		t.Errorf("default enroll permission = %+v", pol.Permission)
	}
	if c := pol.Permission.Ceiling(); len(c.Keys()) != 0 {
		t.Errorf("default ceiling keys = %v, want none", c.Keys())
	}
	cfg := buildOpencodeConfig("127.0.0.1:1", "s", nil, false, false)
	cfg.Permission = staticPermission()
	for _, k := range []string{"edit", "bash", "webfetch"} {
		if cfg.Permission[k] != "ask" {
			t.Errorf("static %s = %q, want ask", k, cfg.Permission[k])
		}
	}
}

func TestEnrollDenyFlag(t *testing.T) {
	pol, err := enrollPolicy(&enrollOptions{deny: []string{"web", "command", "web"}, maxTerminals: 8})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(pol.Permission.Deny, ","); got != "command,web" {
		t.Errorf("deny = %s", got)
	}
	for _, bad := range []string{"loop", "nope"} {
		if _, err := enrollPolicy(&enrollOptions{deny: []string{bad}}); err == nil {
			t.Errorf("--deny %s was accepted", bad)
		}
	}
	// The policy it writes loads back with the deny and no retired field.
	path := filepath.Join(t.TempDir(), policyFileName)
	if err := policy.Save(path, pol); err != nil {
		t.Fatal(err)
	}
	back, err := policy.Load(path)
	if err != nil || !back.Permission.Denied(decide.ClassWeb) || !back.Permission.Denied(decide.ClassCommand) {
		t.Fatalf("the deny did not round trip: %+v, %v", back.Permission, err)
	}
	raw, _ := os.ReadFile(path)
	for _, w := range []string{"autoAccept", `"max"`, `"limits"`, `"rules"`} {
		if strings.Contains(string(raw), w) {
			t.Errorf("policy.json carries a retired field %s:\n%s", w, raw)
		}
	}
}

func TestRetiredFlagsAreAcceptedWarnedAndIgnored(t *testing.T) {
	var pol policy.Policy
	out := captureStderr(t, func() {
		var err error
		pol, err = enrollPolicy(&enrollOptions{
			limits: []string{"edit=ask", "nonsense"}, permissionMax: []string{"bash=deny"}, permissionRules: []string{"edit=allow"},
			maxTerminals: 8,
		})
		if err != nil {
			t.Fatal(err)
		}
	})
	for _, w := range []string{"--limit is ignored", "--permission-max is ignored", "--permission-rule is ignored"} {
		if !strings.Contains(out, w) {
			t.Errorf("no warning %q in:\n%s", w, out)
		}
	}
	if len(pol.Permission.DenySet()) != 0 || pol.Permission.Limits != nil || pol.Permission.Max != nil || pol.Permission.Rules != nil {
		t.Errorf("a retired flag changed the policy: %+v", pol.Permission)
	}
}

func TestPolicySetDenyAndNoDeny(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	if err := policy.Save(path, policy.Default()); err != nil {
		t.Fatal(err)
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--deny", "command", "--deny", "web", "--no-auto-accept"}); err != nil {
		t.Fatal(err)
	}
	got, _ := policy.Load(path)
	if !got.Permission.Denied(decide.ClassCommand) || !got.Permission.Denied(decide.ClassWeb) {
		t.Errorf("after set --deny: %+v", got.Permission)
	}
	if got.Permission.Ceiling().Of("bash") != "deny" {
		t.Error("a denied command class must cap bash")
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--no-deny", "web"}); err != nil {
		t.Fatal(err)
	}
	got, _ = policy.Load(path)
	if got.Permission.Denied(decide.ClassWeb) || !got.Permission.Denied(decide.ClassCommand) {
		t.Errorf("after --no-deny web: %+v", got.Permission)
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--no-deny", "web"}); err == nil {
		t.Error("--no-deny of a class that is not denied must say so")
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--deny", "loop"}); err == nil {
		t.Error("--deny loop must be refused")
	}
	// --limit is gone from policy set's own tightening: accepted, warned, ignored.
	out := captureStderr(t, func() {
		if err := runPolicySet([]string{"--state-dir", dir, "--limit", "edit=never", "--deny", "outside"}); err != nil {
			t.Fatal(err)
		}
	})
	if !strings.Contains(out, "--limit is ignored") {
		t.Errorf("no warning for --limit:\n%s", out)
	}
	got, _ = policy.Load(path)
	if got.Permission.Denied(decide.ClassEdit) {
		t.Error("--limit edit=never must not deny edit")
	}
}

func TestPolicyShowSaysLimitsAreIgnored(t *testing.T) {
	s := permissionPolicySummary(policy.Default())
	for _, want := range []string{"no limits of its own", "Local deny: none", "ignored", "start on Ask", "Auto"} {
		if !strings.Contains(s, want) {
			t.Errorf("summary lacks %q:\n%s", want, s)
		}
	}
	pol := policy.Default()
	pol.Permission.Deny = []string{"command"}
	pol.Permission.Notices = []string{policy.LimitsIgnoredNotice}
	s = permissionPolicySummary(pol)
	if !strings.Contains(s, "Local deny: command") || !strings.Contains(s, "Note: policy.json carries permission limits") {
		t.Errorf("summary = %s", s)
	}
}

// An old policy.json with limits loads, says so, and refuses nothing.
func TestOldPolicyWithLimitsMigrates(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	old := `{"permission":{"limits":{"command":"never","web":"never"},"max":{"bash":"deny"},"rules":{"edit":"allow"}}}`
	if err := os.WriteFile(path, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := policy.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Permission.DenySet()) != 0 || len(got.Permission.Ceiling().Keys()) != 0 {
		t.Errorf("old limits must be ignored: %+v", got.Permission)
	}
	s := permissionPolicySummary(got)
	if !strings.Contains(s, "ignored") || !strings.Contains(s, "Note: policy.json carries permission limits") {
		t.Errorf("policy show must say so:\n%s", s)
	}
}
