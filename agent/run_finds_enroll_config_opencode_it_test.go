package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"galopin/internal/policy"
)

// TestRunFindsTheConfigEnrollWroteIT is the regression for the "daemon lists
// no models" bug: enroll (no --output) writes its opencode.json beside the
// credentials; `run` is then started with no --opencode-config from an
// unrelated directory, and the supervised, real opencode must still know the
// pystino provider. A machine enrolled before the fix (no recorded path) is
// the control: there opencode lists nothing from the gateway. Gated like the
// other real-opencode ITs (GALOPIN_OPENCODE_IT=1).
func TestRunFindsTheConfigEnrollWroteIT(t *testing.T) {
	if !itEnabled("GALOPIN_OPENCODE_IT", "PYSTINO_AGENT_OPENCODE_IT") {
		t.Skip("set GALOPIN_OPENCODE_IT=1 to run (spawns real opencode)")
	}
	if _, err := exec.LookPath("opencode"); err != nil {
		t.Skipf("opencode not on PATH: %v", err)
	}

	root := t.TempDir()
	// A machine with no global opencode config at all: the accident that used
	// to hide the bug is absent.
	home := filepath.Join(root, "home")
	cfg := filepath.Join(root, "xdg-config")
	for _, d := range []string{home, cfg, filepath.Join(root, "data"), filepath.Join(root, "cache"), filepath.Join(root, "cwd")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", cfg)
	t.Setenv("XDG_DATA_HOME", filepath.Join(root, "data"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(root, "cache"))
	t.Setenv("TMPDIR", itTmpDir(t))
	t.Chdir(filepath.Join(root, "cwd")) // not the galopin dir, not where enroll ran

	srv := fakeEnrollServer(t)
	credsPath, err := defaultCredsPath()
	if err != nil {
		t.Fatal(err)
	}
	creds := enrollIntoDiscover(t, srv, credsPath, "", true)

	modelsFor := func(t *testing.T, opencodeConfig string) []string {
		t.Helper()
		pol := policy.Default()
		stateDir := t.TempDir()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		back, err := startBackend(ctx, &runOptions{backendKind: "opencode", opencodeConfig: opencodeConfig}, stateDir, pol, policy.NewLive(pol.Permission), t.Logf)
		if err != nil {
			t.Fatalf("startBackend: %v", err)
		}
		defer back.Stop()
		models, err := back.Models(ctx, "")
		if err != nil {
			t.Fatalf("Models: %v", err)
		}
		var ids []string
		for _, m := range models {
			if m.ProviderID == policy.GatewayProviderID {
				ids = append(ids, m.ID)
			}
		}
		return ids
	}

	// Control: what run did before the fix (nothing handed to opencode).
	if got := modelsFor(t, ""); len(got) != 0 {
		t.Fatalf("control: with no config opencode listed gateway models %v; the IT no longer shows the bug", got)
	}

	// The fix: run's own resolution, from the recorded path.
	resolved, warn := resolveOpencodeConfig("", creds)
	if warn != "" || resolved == "" {
		t.Fatalf("run did not find the enrolled config: %q, %q", resolved, warn)
	}
	got := modelsFor(t, resolved)
	if len(got) != 1 || got[0] != "pystino/gw-model" {
		t.Fatalf("backend.models after the fix = %v, want [pystino/gw-model]", got)
	}
}
