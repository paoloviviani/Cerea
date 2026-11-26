//go:build unix

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A machine never enrolled has no state dir: enroll must still take the
// instance lock (creating the dir 0700), and run/serve must say "not paired".
func TestInstanceLockOnAFreshMachine(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "config", "galopin")
	creds := filepath.Join(dir, "credentials.json")
	unlock, err := lockInstance(creds)
	if err != nil {
		t.Fatalf("lock on a fresh machine: %v", err)
	}
	unlock()
	st, err := os.Stat(dir)
	if err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("state dir: %v, mode %v", err, st.Mode().Perm())
	}
}

func TestRequirePairedSaysNotPaired(t *testing.T) {
	creds := filepath.Join(t.TempDir(), "galopin", "credentials.json")
	err := requirePaired(creds)
	if err == nil || !strings.Contains(err.Error(), "not paired") || !strings.Contains(err.Error(), "galopin enroll") {
		t.Fatalf("requirePaired = %v", err)
	}
	if _, serr := os.Stat(filepath.Dir(creds)); !os.IsNotExist(serr) {
		t.Fatalf("requirePaired must not create the dir: %v", serr)
	}
	if err := os.MkdirAll(filepath.Dir(creds), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(creds, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := requirePaired(creds); err != nil {
		t.Fatalf("paired: %v", err)
	}
}
