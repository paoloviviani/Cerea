package main

import (
	"os"
	"path/filepath"
	"testing"
)

// withConfigDir points os.UserConfigDir (via $XDG_CONFIG_HOME on Linux) at a
// fresh temp directory, so defaultStateDir/legacyStateDir resolve under it
// with no risk of touching a real machine's config.
func withConfigDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	return dir
}

func writeLegacyFile(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestMigrateLegacyState_FreshMachine: no legacy files and no new directory
// — the common case from here on — must do nothing and create nothing.
func TestMigrateLegacyState_FreshMachine(t *testing.T) {
	configDir := withConfigDir(t)
	if err := migrateLegacyState(); err != nil {
		t.Fatal(err)
	}
	newDir, err := defaultStateDir()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(newDir); !os.IsNotExist(err) {
		t.Fatalf("a fresh machine must get no galopin dir, stat err = %v", err)
	}
	if _, err := os.ReadDir(configDir); err != nil {
		t.Fatal(err)
	}
}

// TestMigrateLegacyState_MovesEverything: a pre-galopin install's files, all
// present, move into the new directory under their new names, at 0600, and
// are gone from the old one.
func TestMigrateLegacyState_MovesEverything(t *testing.T) {
	configDir := withConfigDir(t)
	oldDir := filepath.Join(configDir, "opencode")
	writeLegacyFile(t, oldDir, "pystino-credentials.json", `{"refresh_token":"secret"}`)
	writeLegacyFile(t, oldDir, "pystino-status.json", `{"state":"ok"}`)
	writeLegacyFile(t, oldDir, "policy.json", `{"autoAccept":"denied"}`)
	writeLegacyFile(t, oldDir, "machine-id", "abc123\n")
	writeLegacyFile(t, oldDir, "revoked", "abc123\n")
	writeLegacyFile(t, oldDir, "opencode-overlay.json", `{}`)
	writeLegacyFile(t, oldDir, "workspaces.json", `{"workspaces":[]}`)
	// opencode's own config lives in the same directory and must be left
	// alone — it is not one of this program's files.
	writeLegacyFile(t, oldDir, "opencode.json", `{"$schema":"https://opencode.ai/config.json"}`)

	if err := migrateLegacyState(); err != nil {
		t.Fatal(err)
	}

	newDir, err := defaultStateDir()
	if err != nil {
		t.Fatal(err)
	}
	for oldName, newName := range map[string]string{
		"pystino-credentials.json": credentialsFileName,
		"pystino-status.json":      statusFileName,
		"policy.json":              policyFileName,
		"machine-id":               machineIDFileName,
		"revoked":                  revokedMarkerFileName,
		"opencode-overlay.json":    "opencode-overlay.json",
		"workspaces.json":          "workspaces.json",
	} {
		newPath := filepath.Join(newDir, newName)
		info, err := os.Stat(newPath)
		if err != nil {
			t.Errorf("%s: not migrated to %s: %v", oldName, newPath, err)
			continue
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Errorf("%s: mode = %o, want 0600", newPath, perm)
		}
		if _, err := os.Stat(filepath.Join(oldDir, oldName)); !os.IsNotExist(err) {
			t.Errorf("%s: still present in the legacy directory after migration", oldName)
		}
	}
	if _, err := os.Stat(filepath.Join(oldDir, "opencode.json")); err != nil {
		t.Errorf("opencode's own config must survive untouched: %v", err)
	}
}

// TestMigrateLegacyState_AlreadyMigrated: the new directory already has its
// own credentials (a machine that migrated once already, or was enrolled
// fresh under galopin) — a second call must be a no-op, whether or not any
// legacy files still exist.
func TestMigrateLegacyState_AlreadyMigrated(t *testing.T) {
	configDir := withConfigDir(t)
	newDir := filepath.Join(configDir, "galopin")
	writeLegacyFile(t, newDir, credentialsFileName, `{"refresh_token":"already-here"}`)

	if err := migrateLegacyState(); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(newDir, credentialsFileName))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"refresh_token":"already-here"}` {
		t.Errorf("credentials were overwritten: %s", body)
	}
}

// TestMigrateLegacyState_BothPresent: both directories carry credentials —
// the new one wins outright, and the legacy directory is left completely
// alone, nothing overwritten.
func TestMigrateLegacyState_BothPresent(t *testing.T) {
	configDir := withConfigDir(t)
	oldDir := filepath.Join(configDir, "opencode")
	writeLegacyFile(t, oldDir, "pystino-credentials.json", `{"refresh_token":"legacy"}`)
	writeLegacyFile(t, oldDir, "machine-id", "legacy-id\n")

	newDir := filepath.Join(configDir, "galopin")
	writeLegacyFile(t, newDir, credentialsFileName, `{"refresh_token":"current"}`)

	if err := migrateLegacyState(); err != nil {
		t.Fatal(err)
	}

	body, err := os.ReadFile(filepath.Join(newDir, credentialsFileName))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"refresh_token":"current"}` {
		t.Errorf("the new directory's credentials must win: got %s", body)
	}
	if _, err := os.Stat(filepath.Join(oldDir, "pystino-credentials.json")); err != nil {
		t.Errorf("the legacy credentials must be left in place, not consumed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(oldDir, "machine-id")); err != nil {
		t.Errorf("the legacy machine-id must be left in place too: %v", err)
	}
	if _, err := os.Stat(filepath.Join(newDir, machineIDFileName)); !os.IsNotExist(err) {
		t.Errorf("no legacy file must be pulled in once the new directory already has credentials")
	}
}

// TestMigrationDisabled pins the explicit-flag contract: naming --creds or
// (for run) --state-dir turns the automatic migration off, regardless of
// what the other one is.
func TestMigrationDisabled(t *testing.T) {
	cases := []struct {
		name     string
		creds    string
		stateDir string
		wantOff  bool
	}{
		{"neither flag: migration runs", "", "", false},
		{"explicit --creds: disabled", "/custom/creds.json", "", true},
		{"explicit --state-dir: disabled", "", "/custom/state", true},
		{"both explicit: disabled", "/custom/creds.json", "/custom/state", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := migrationDisabled(c.creds, c.stateDir); got != c.wantOff {
				t.Errorf("migrationDisabled(%q, %q) = %v, want %v", c.creds, c.stateDir, got, c.wantOff)
			}
		})
	}
}
