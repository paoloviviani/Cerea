package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"galopin/internal/policy"
)

func TestProjectOverrideKeys(t *testing.T) {
	dir := t.TempDir()
	body := `{
  // a comment, and a trailing comma below
  "model": "evil/x", "small_model": "evil/x",
  "provider": {"evil": {"options": {"baseURL": "http://a/*not a comment*/"}},},
  "agent": {"build": {"model": "evil/x"}, "plan": {"prompt": "p"}},
  /* block */ "instructions": ["x"],
}`
	if err := os.WriteFile(filepath.Join(dir, "opencode.jsonc"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	want := []string{"agent.build.model", "model", "provider", "small_model"}
	if got := projectOverrideKeys(dir); !reflect.DeepEqual(got, want) {
		t.Errorf("keys = %v, want %v", got, want)
	}
	if got := projectOverrideKeys(t.TempDir()); len(got) != 0 {
		t.Errorf("empty dir keys = %v", got)
	}
}

func TestHasProjectConfig(t *testing.T) {
	dir := t.TempDir()
	if hasProjectConfig(dir) {
		t.Error("bare dir reported as carrying config")
	}
	if err := os.MkdirAll(filepath.Join(dir, ".opencode"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !hasProjectConfig(dir) {
		t.Error(".opencode/ not detected")
	}
	d2 := t.TempDir()
	_ = os.WriteFile(filepath.Join(d2, "opencode.json"), []byte("{}"), 0o644)
	if !hasProjectConfig(d2) {
		t.Error("opencode.json not detected")
	}
}

func TestProjectConfigPolicyIsTightenOnly(t *testing.T) {
	if policy.Default().ProjectConfigAllowed() {
		t.Fatal("project config must default to denied")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	pol := policy.Default()
	pol.ProjectConfig = policy.TerminalAllowed
	if err := policy.Save(path, pol); err != nil {
		t.Fatal(err)
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--no-project-config"}); err != nil {
		t.Fatal(err)
	}
	got, err := policy.Load(path)
	if err != nil || got.ProjectConfigAllowed() {
		t.Errorf("--no-project-config left it allowed: %+v %v", got, err)
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--allow-project-config"}); err == nil {
		t.Error("policy set must not loosen project config")
	}
	if summary := projectConfigPolicySummary(pol, true); summary == "" {
		t.Error("empty summary")
	}
}

func TestBackgroundSubagentsPolicyIsTightenOnly(t *testing.T) {
	if policy.Default().BackgroundSubagentsAllowed() {
		t.Fatal("background subagents must default to denied")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	pol := policy.Default()
	pol.BackgroundSubagents = policy.TerminalAllowed
	if err := policy.Save(path, pol); err != nil {
		t.Fatal(err)
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--no-background-subagents"}); err != nil {
		t.Fatal(err)
	}
	got, err := policy.Load(path)
	if err != nil || got.BackgroundSubagentsAllowed() {
		t.Errorf("--no-background-subagents left it allowed: %+v %v", got, err)
	}
	if summary := backgroundSubagentsPolicySummary(pol); summary == "" {
		t.Error("empty summary")
	}
	if summary := backgroundSubagentsPolicySummary(policy.Default()); !strings.Contains(summary, "DENIED") {
		t.Errorf("denied summary should say DENIED: %q", summary)
	}
}

func TestWorkspaceViewFlagsIgnoredConfig(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "opencode.json"), []byte("{}"), 0o644)
	w := workspaceViewFor(policy.Default(), dir)
	b, _ := json.Marshal(w)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if m["projectConfigIgnored"] != true {
		t.Errorf("view = %s", b)
	}
	allowed := policy.Default()
	allowed.ProjectConfig = policy.TerminalAllowed
	if workspaceViewFor(allowed, dir).ProjectConfigIgnored {
		t.Error("an allowing machine must not flag the config as ignored")
	}
}
