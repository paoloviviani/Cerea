package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/internal/policy"
)

func TestPolicySetTightens(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	pol := policy.Default()
	pol.Terminal = policy.TerminalAllowed
	pol.MaxTerminals = 8
	if err := policy.Save(path, pol); err != nil {
		t.Fatal(err)
	}

	if err := runPolicySet([]string{"--state-dir", dir, "--no-terminal"}); err != nil {
		t.Fatalf("--no-terminal: %v", err)
	}
	got, err := policy.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.TerminalAllowed() {
		t.Error("terminal should now be denied")
	}

	// Re-allow it directly in the file (as if enroll had run again) so the
	// next tightening move (lowering maxTerminals) has something to lower.
	got.Terminal = policy.TerminalAllowed
	if err := policy.Save(path, got); err != nil {
		t.Fatal(err)
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--max-terminals", "3"}); err != nil {
		t.Fatalf("lowering maxTerminals: %v", err)
	}
	got, err = policy.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.EffectiveMaxTerminals() != 3 {
		t.Errorf("maxTerminals = %d, want 3", got.EffectiveMaxTerminals())
	}
}

func TestPolicySetRefusesLoosening(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	pol := policy.Default()
	pol.MaxTerminals = 3
	if err := policy.Save(path, pol); err != nil {
		t.Fatal(err)
	}

	err := runPolicySet([]string{"--state-dir", dir, "--max-terminals", "10"})
	if err == nil {
		t.Fatal("raising maxTerminals must be refused")
	}
	if !strings.Contains(err.Error(), "enroll") {
		t.Errorf("refusal message should point at enroll, got: %v", err)
	}
	got, loadErr := policy.Load(path)
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if got.EffectiveMaxTerminals() != 3 {
		t.Errorf("policy.json must be unchanged after a refused loosening, got maxTerminals=%d", got.EffectiveMaxTerminals())
	}
}

func TestPolicySetHasNoWayToLoosenFilesOrTerminal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	if err := policy.Save(path, policy.Default()); err != nil {
		t.Fatal(err)
	}
	// There is deliberately no --allow-terminal / --allow-files flag on
	// `policy set` at all: attempting one is an unrecognized-flag error,
	// the structural version of "loosening always needs enroll".
	if err := runPolicySet([]string{"--state-dir", dir, "--allow-terminal"}); err == nil {
		t.Fatal("policy set must not accept a flag that loosens the policy")
	}
}

// commandShell joins the tighten-only set: `policy set --no-command-shell`
// turns it off, and there is no flag that turns it back on — loosening
// needs enroll, like every other veto here.
func TestPolicySetTightensCommandShell(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	pol := policy.Default()
	pol.CommandShell = policy.TerminalAllowed
	if err := policy.Save(path, pol); err != nil {
		t.Fatal(err)
	}

	if err := runPolicySet([]string{"--state-dir", dir, "--no-command-shell"}); err != nil {
		t.Fatalf("--no-command-shell: %v", err)
	}
	got, err := policy.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.CommandShellAllowed() {
		t.Error("command shell should now be denied")
	}
}

func TestPolicySetHasNoWayToLoosenCommandShell(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	if err := policy.Save(path, policy.Default()); err != nil {
		t.Fatal(err)
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--allow-command-shell"}); err == nil {
		t.Fatal("policy set must not accept a flag that re-opens command shell")
	}
}

func TestDefaultPolicyDeniesCommandShell(t *testing.T) {
	// The default is the whole point of the gate: a machine enrolled before
	// the flag existed denies command shell, and so does a policy.json that
	// predates the field.
	if policy.Default().CommandShellAllowed() {
		t.Fatal("the default policy must deny command shell")
	}
	pol, err := policy.Load(filepath.Join(t.TempDir(), "missing.json"))
	if err != nil {
		t.Fatal(err)
	}
	if pol.CommandShellAllowed() {
		t.Fatal("a missing policy file must deny command shell")
	}
}

func TestAgentToolsPolicyDefaultsAllowedAndOnlyTightens(t *testing.T) {
	// On by default, including for a policy.json that predates the field.
	if !policy.Default().AgentToolsAllowed() {
		t.Fatal("the default policy must allow agent tools")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	if err := os.WriteFile(path, []byte(`{"autoAccept":"denied"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	old, err := policy.Load(path)
	if err != nil || !old.AgentToolsAllowed() {
		t.Fatalf("a policy.json without the field must load as allowed: %+v %v", old, err)
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--no-agent-tools"}); err != nil {
		t.Fatalf("--no-agent-tools: %v", err)
	}
	got, err := policy.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.AgentToolsAllowed() {
		t.Error("agent tools should now be denied")
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--allow-agent-tools"}); err == nil {
		t.Fatal("policy set must not accept a flag that turns agent tools back on")
	}
}

func TestAgentToolsDirFollowsPolicy(t *testing.T) {
	on := policy.Default()
	if got := agentToolsDir(on, "/state"); got != "/state/opencode-tools" {
		t.Errorf("allowed: %q", got)
	}
	off := policy.Default()
	off.AgentTools = policy.TerminalDenied
	if got := agentToolsDir(off, "/state"); got != "" {
		t.Errorf("denied must install nothing, got %q", got)
	}
	if agentToolsPolicyWord(off) != policy.TerminalDenied || agentToolsPolicyWord(on) != policy.TerminalAllowed {
		t.Error("hello.policy.agentTools does not follow the policy")
	}
}
