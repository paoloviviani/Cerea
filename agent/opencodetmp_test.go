package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpencodeTmpDirIsNeverInsideTheStateDirectory(t *testing.T) {
	state := t.TempDir()
	runtime := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", runtime)

	got := opencodeTmpDir(state)
	if want := filepath.Join(runtime, "galopin", "opencode-tmp"); got != want {
		t.Fatalf("opencodeTmpDir = %q, want %q", got, want)
	}
	if strings.HasPrefix(got, state) {
		t.Fatalf("opencodeTmpDir %q is inside the state directory %q", got, state)
	}
}

func TestOpencodeTmpDirFallsBackToTheCacheDirectory(t *testing.T) {
	state := t.TempDir()
	cache := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", "")
	t.Setenv("XDG_CACHE_HOME", cache)

	got := opencodeTmpDir(state)
	if want := filepath.Join(cache, "galopin", "opencode-tmp"); got != want {
		t.Fatalf("opencodeTmpDir = %q, want %q", got, want)
	}
}

func TestOpencodeTmpDirIgnoresAMissingRuntimeDirectory(t *testing.T) {
	state := t.TempDir()
	cache := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(t.TempDir(), "gone"))
	t.Setenv("XDG_CACHE_HOME", cache)

	if got, want := opencodeTmpDir(state), filepath.Join(cache, "galopin", "opencode-tmp"); got != want {
		t.Fatalf("opencodeTmpDir = %q, want %q", got, want)
	}
}

func TestOpencodeTmpDirRemovesTheOldOneBesideTheCredentials(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	legacy := filepath.Join(state, "opencode-tmp")
	if err := os.MkdirAll(filepath.Join(legacy, "left-by-a-test"), 0o700); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(state, "credentials.json")
	if err := os.WriteFile(keep, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}

	opencodeTmpDir(state)

	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("the old opencode-tmp in the state directory is still there (err=%v)", err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("a sibling of the old directory was touched: %v", err)
	}
}
