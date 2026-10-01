package opencode

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A bare binary name that is neither on PATH nor in $HOME/.opencode/bin
// must fail fast in Start: a missing binary is permanent, and the supervise
// loop would otherwise burn its whole backoff ladder (1s→16s, a 30s
// startup timeout) retrying a condition that can never come healthy. Found
// live on a fresh machine: galopin enrolled fine, then spent 30s reporting
// "exec: opencode: executable file not found in $PATH" with no hint that
// installing opencode was the fix.
func TestStartFailsFastOnMissingBinary(t *testing.T) {
	// A name guaranteed absent from PATH and free of '/', so Start takes
	// the resolution branch this test pins.
	b := New(Config{Bin: "opencode-not-installed-xyz"})
	err := b.Start(context.Background())
	if err == nil {
		t.Fatal("Start with a missing binary should fail, not hang into health waits")
	}
	if !strings.Contains(err.Error(), "not found on PATH") {
		t.Errorf("the error should name the PATH miss, got: %v", err)
	}
	if !strings.Contains(err.Error(), "opencode.ai/install") {
		t.Errorf("the error should point at the installer, got: %v", err)
	}
}

// The opencode installer puts the binary in $HOME/.opencode/bin and only
// joins it to PATH via the rc files — so the shell that just ran the
// install (galopin's printed one-liner chains exactly that) cannot see it
// until the next login. Start must fall back to that directory, which is
// what makes the fresh-machine one-liner work in one shot.
func TestStartFallsBackToOpencodeInstallDir(t *testing.T) {
	dir := t.TempDir()
	binDir := filepath.Join(dir, ".opencode", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	fake := filepath.Join(binDir, "opencode")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", dir)
	// Force PATH resolution to miss so only the fallback can succeed.
	t.Setenv("PATH", filepath.Join(dir, "nowhere"))

	b := New(Config{Bin: "opencode", Hostname: "127.0.0.1", Port: 1})
	// Start would go on to launch the fake and wait for health — stop at
	// the resolution check by calling the piece we pin through Start's
	// first step: resolve happens before any port work, so a fake that
	// exits 0 keeps Start from hanging (it fails fast on the health wait
	// only after resolution succeeded; here we assert the resolution
	// itself).
	err := b.Start(context.Background())
	if err == nil {
		t.Fatal("the fake binary never serves health; Start must fail — but only after resolving")
	}
	if !strings.Contains(b.cfg.Bin, fake) {
		t.Errorf("the fallback should have resolved to %s, got %q", fake, b.cfg.Bin)
	}
	// And the miss case keeps its actionable message even with HOME set.
	os.Remove(fake)
	b2 := New(Config{Bin: "opencode-not-installed-xyz"})
	t.Setenv("HOME", dir)
	err = b2.Start(context.Background())
	if err == nil || !strings.Contains(err.Error(), "opencode.ai/install") {
		t.Errorf("missing binary with HOME set should still name the fix, got: %v", err)
	}
}

// The background-subagent flag is galopin's alone: an inherited value never
// decides it (fail-closed), and Config.BackgroundSubagents is the only thing
// that sets it.
func TestStripChildSwitchesDropsInheritedBackgroundFlag(t *testing.T) {
	env := []string{
		"PATH=/usr/bin",
		"OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1",
		"OPENCODE_DISABLE_PROJECT_CONFIG=1",
		"OPENCODE_CONFIG_CONTENT={}",
		"HOME=/root",
	}
	got := stripChildSwitches(append([]string{}, env...))
	for _, kv := range got {
		if strings.HasPrefix(kv, "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=") ||
			strings.HasPrefix(kv, "OPENCODE_DISABLE_PROJECT_CONFIG=") ||
			strings.HasPrefix(kv, "OPENCODE_CONFIG_CONTENT=") {
			t.Errorf("inherited switch survived stripping: %q", kv)
		}
	}
	found := false
	for _, kv := range got {
		if kv == "PATH=/usr/bin" || kv == "HOME=/root" {
			found = true
		}
	}
	if !found {
		t.Errorf("unrelated env was dropped: %v", got)
	}
}
