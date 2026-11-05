package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"galopin/internal/policy"
)

func enrollArgs(srv string, creds string, extra ...string) []string {
	base := []string{"--issuer", srv, "--gateway", srv, "--device", "--group", "team", "--creds", creds, "--yes", "--no-discover"}
	return append(base, extra...)
}

func loadPol(t *testing.T, creds string) policy.Policy {
	t.Helper()
	p, err := policy.Load(policyPathFor(creds))
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// A first enroll with no option writes the defaults, and the file editor is on.
func TestFreshEnrollWritesTheDefaultsWithTheFileEditorOn(t *testing.T) {
	srv := fakeEnrollServer(t)
	creds := filepath.Join(t.TempDir(), "credentials.json")
	if err := runEnroll(enrollArgs(srv.URL, creds)); err != nil {
		t.Fatal(err)
	}
	p := loadPol(t, creds)
	if !p.FileWriteAllowed() || !p.TerminalAllowed() || p.Permission.Limits["command"] != "ask" || p.Permission.Limits["edit"] != "run" {
		t.Errorf("fresh policy = %+v", p)
	}
	if !reflect.DeepEqual(p.Permission.Limits, policy.DefaultLimits()) {
		t.Errorf("limits = %v", p.Permission.Limits)
	}
	// --no-file-write turns it off; --allow-file-write stays accepted.
	creds2 := filepath.Join(t.TempDir(), "credentials.json")
	if err := runEnroll(enrollArgs(srv.URL, creds2, "--no-file-write")); err != nil {
		t.Fatal(err)
	}
	if loadPol(t, creds2).FileWriteAllowed() {
		t.Error("--no-file-write left the editor on")
	}
	creds3 := filepath.Join(t.TempDir(), "credentials.json")
	if err := runEnroll(enrollArgs(srv.URL, creds3, "--allow-file-write")); err != nil {
		t.Fatal(err)
	}
	if !loadPol(t, creds3).FileWriteAllowed() {
		t.Error("--allow-file-write must remain accepted")
	}
}

// Fixes Cerea #25: re-enrolling keeps every existing setting except the options
// passed. All of them, not just the limits.
func TestReEnrollKeepsEverythingExceptTheOptionsPassed(t *testing.T) {
	srv := fakeEnrollServer(t)
	dir := t.TempDir()
	creds := filepath.Join(dir, "credentials.json")
	root := t.TempDir()
	if err := runEnroll(enrollArgs(srv.URL, creds,
		"--limit", "command=never", "--limit", "loop=stop", "--safe-dir", "/srv/safe", "--file-deny", "*.secret",
		"--no-terminal", "--max-terminals", "3", "--workspace-root", root, "--no-file-write",
		"--no-agent-tools", "--allow-free-models", "--no-command-shell", "--allow-project-config",
	)); err != nil {
		t.Fatal(err)
	}
	before := loadPol(t, creds)
	if before.Permission.Limits["command"] != "never" || before.Terminal != policy.TerminalDenied {
		t.Fatalf("setup: %+v", before)
	}

	// Re-enroll passing one option only.
	if err := runEnroll(enrollArgs(srv.URL, creds, "--limit", "web=ask")); err != nil {
		t.Fatal(err)
	}
	after := loadPol(t, creds)
	want := before
	want.Permission.Limits = map[string]string{}
	for k, v := range before.Permission.Limits {
		want.Permission.Limits[k] = v
	}
	want.Permission.Limits["web"] = "ask"
	if !reflect.DeepEqual(after, want) {
		t.Errorf("re-enroll changed more than the option passed:\n got %+v\nwant %+v", after, want)
	}
	for name, ok := range map[string]bool{
		"limits":         after.Permission.Limits["command"] == "never" && after.Permission.Limits["loop"] == "stop",
		"safe dirs":      after.Permission.SafeDirs != nil && len(*after.Permission.SafeDirs) == 1,
		"file deny":      len(after.FileDeny) == 1,
		"terminal":       after.Terminal == policy.TerminalDenied,
		"max terminals":  after.MaxTerminals == 3,
		"workspace root": len(after.WorkspaceRoots) == 1,
		"file editor":    !after.FileWriteAllowed(),
		"agent tools":    !after.AgentToolsAllowed(),
		"free models":    after.AllowFreeModels,
		"command shell":  !after.CommandShellAllowed(),
		"project config": after.ProjectConfigAllowed(),
	} {
		if !ok {
			t.Errorf("re-enroll did not keep %s", name)
		}
	}

	// An option passed wins, and only it: turn the terminal back on.
	if err := runEnroll(enrollArgs(srv.URL, creds, "--allow-terminal", "--limit", "command=ask")); err != nil {
		t.Fatal(err)
	}
	again := loadPol(t, creds)
	if !again.TerminalAllowed() || again.Permission.Limits["command"] != "ask" || again.Permission.Limits["web"] != "ask" || again.MaxTerminals != 3 || again.FileWriteAllowed() {
		t.Errorf("after the second re-enroll: %+v", again)
	}
}

// A machine enrolled before classes keeps its settings through a re-enroll too:
// the migrated limits are what is kept.
func TestReEnrollOfAnOldPolicyKeepsItsMigratedSettings(t *testing.T) {
	srv := fakeEnrollServer(t)
	creds := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(policyPathFor(creds), []byte(`{"permission":{"max":{"bash":"allow"},"rules":{"edit":"allow"}},"workspaceRoots":[],"allowFreeModels":false,"terminal":"denied","fileWrite":"denied"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := runEnroll(enrollArgs(srv.URL, creds)); err != nil {
		t.Fatal(err)
	}
	p := loadPol(t, creds)
	if p.Permission.Limits["command"] != "run" || p.Permission.Rules["edit"] != "allow" || p.TerminalAllowed() || p.FileWriteAllowed() {
		t.Errorf("an old machine's settings were not kept: %+v", p)
	}
	raw, _ := os.ReadFile(policyPathFor(creds))
	if strings.Contains(string(raw), `"max"`) {
		t.Errorf("the rewritten policy still carries the old ceiling:\n%s", raw)
	}
}

func TestEnrollTakesTheCereaAddressPositionally(t *testing.T) {
	srv := fakeEnrollServer(t)
	creds := filepath.Join(t.TempDir(), "credentials.json")
	// Before the flags, after them, and in the middle.
	for _, args := range [][]string{
		append([]string{"https://cerea.example.org"}, enrollArgs(srv.URL, creds)...),
		append(enrollArgs(srv.URL, creds), "https://cerea.example.org"),
		append(enrollArgs(srv.URL, creds, "--limit", "web=ask"), "https://cerea.example.org", "--no-terminal"),
	} {
		if err := runEnroll(args); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		c, err := loadCredentials(creds)
		if err != nil || c.CereaOrigin != "https://cerea.example.org" {
			t.Errorf("%v: cerea origin = %q, %v", args, c.CereaOrigin, err)
		}
	}
	// The flag still works, and a different address beside it is refused.
	if err := runEnroll(enrollArgs(srv.URL, creds, "--cerea", "https://other.example.org")); err != nil {
		t.Fatal(err)
	}
	if err := runEnroll(append(enrollArgs(srv.URL, creds, "--cerea", "https://a.example.org"), "https://b.example.org")); err == nil {
		t.Error("two different Cerea addresses were accepted")
	}
	if err := runEnroll(append(enrollArgs(srv.URL, creds), "https://a.example.org", "https://b.example.org")); err == nil {
		t.Error("two positional addresses were accepted")
	}
	// A bad --limit fails before any sign-in.
	if err := runEnroll(enrollArgs(srv.URL, creds, "--limit", "secrets=run")); err == nil || !strings.Contains(err.Error(), "never or ask") {
		t.Errorf("secrets=run: %v", err)
	}
}

func TestResetRestoresTheDefaultsAndKeepsTheCredentials(t *testing.T) {
	srv := fakeEnrollServer(t)
	dir := t.TempDir()
	creds := filepath.Join(dir, "credentials.json")
	if err := runEnroll(enrollArgs(srv.URL, creds, "--limit", "command=never", "--no-terminal", "--no-file-write", "--safe-dir", "/srv/safe", "https://cerea.example.org")); err != nil {
		t.Fatal(err)
	}
	credsBefore, _ := os.ReadFile(creds)
	machineBefore, _ := os.ReadFile(filepath.Join(dir, machineIDFileName))

	// Declined: nothing changes.
	if err := resetPolicy(policyPathFor(creds), false, func(string) (bool, error) { return false, nil }); err == nil {
		t.Error("a declined reset must say it did nothing")
	}
	if loadPol(t, creds).Permission.Limits["command"] != "never" {
		t.Fatal("a declined reset changed the policy")
	}
	// --yes skips the prompt entirely.
	if err := runReset([]string{"--yes", "--creds", creds}); err != nil {
		t.Fatal(err)
	}
	p := loadPol(t, creds)
	want := freshEnrollPolicy()
	if !reflect.DeepEqual(p, want) {
		t.Errorf("after reset:\n got %+v\nwant %+v", p, want)
	}
	if !p.TerminalAllowed() || !p.FileWriteAllowed() || p.Permission.SafeDirs != nil {
		t.Errorf("reset did not restore the defaults: %+v", p)
	}
	if after, _ := os.ReadFile(creds); string(after) != string(credsBefore) {
		t.Error("reset touched the credentials")
	}
	if after, _ := os.ReadFile(filepath.Join(dir, machineIDFileName)); string(after) != string(machineBefore) {
		t.Error("reset changed the machine id (the pairing)")
	}
	// A confirmed prompt works too.
	if err := resetPolicy(policyPathFor(creds), false, func(string) (bool, error) { return true, nil }); err != nil {
		t.Error(err)
	}
}
