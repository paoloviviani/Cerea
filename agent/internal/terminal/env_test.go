//go:build unix

package terminal

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// itTmpDir is a per-test TMPDIR on disk (mirrors opencode_it_test.go's
// helper of the same purpose in package main, which this package cannot
// import): a spawned shell must never write into /tmp, which is tmpfs on
// this box, so every real-terminal test in this file sets TMPDIR to this
// before calling Open.
func itTmpDir(t *testing.T) string {
	t.Helper()
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	if err := os.MkdirAll(filepath.Join(base, "galopin-it"), 0o700); err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(filepath.Join(base, "galopin-it"), "run-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func TestScrubEnvRemovesInjectedKeys(t *testing.T) {
	in := []string{
		"HOME=/home/user",
		"OPENCODE_SERVER_PASSWORD=topsecret",
		"OPENCODE_CONFIG=/tmp/opencode.json",
		`OPENCODE_CONFIG_CONTENT={"provider":{"x":{"options":{"apiKey":"sk-1"}}}}`,
		"GALOPIN_SHIM_SECRET=abc123",
		"PATH=/usr/bin",
		"MY_APP_API_TOKEN=xyz",
		"AWS_SECRET_ACCESS_KEY=xyz",
		"SOME_CREDENTIAL_FILE=/etc/passwd",
	}
	out := ScrubEnv(in)
	for _, kept := range []string{"HOME=/home/user", "PATH=/usr/bin"} {
		found := false
		for _, kv := range out {
			if kv == kept {
				found = true
			}
		}
		if !found {
			t.Errorf("expected %q to survive the scrub; got %v", kept, out)
		}
	}
	for _, dropped := range []string{
		"OPENCODE_SERVER_PASSWORD", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "GALOPIN_SHIM_SECRET",
		"MY_APP_API_TOKEN", "AWS_SECRET_ACCESS_KEY", "SOME_CREDENTIAL_FILE",
	} {
		for _, kv := range out {
			if strings.HasPrefix(kv, dropped+"=") {
				t.Errorf("expected %s to be scrubbed; got %v", dropped, out)
			}
		}
	}
}

// TestSpawnedShellEnvironmentIsScrubbed is the brief's required test: spawn
// a real PTY running `env` and assert none of galopin's secrets are
// present, however they got into this process's own environment.
func TestSpawnedShellEnvironmentIsScrubbed(t *testing.T) {
	if !Supported {
		t.Skip("terminals are not supported on this OS")
	}
	t.Setenv("OPENCODE_SERVER_PASSWORD", "should-never-leak")
	t.Setenv("GALOPIN_SHIM_SECRET", "should-never-leak-either")
	t.Setenv("SOME_OTHER_TOKEN", "also-should-not-leak")
	t.Setenv("HARMLESS_MARKER", "this-should-survive")
	t.Setenv("SHELL", "/bin/sh") // keep the test hermetic regardless of the invoking shell
	t.Setenv("TMPDIR", itTmpDir(t))

	root := t.TempDir()
	var out outputCollector
	term, err := Open(OpenConfig{
		ID: "t1", WorkspaceID: "w1", WorkspaceRoot: root, Cols: 80, Rows: 24,
		OnOutput: out.collect,
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer term.Close(true)

	if _, err := term.Write([]byte("env; exit\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	waitForExit(t, term)
	output := out.String()
	for _, secret := range []string{"should-never-leak", "should-never-leak-either", "also-should-not-leak"} {
		if strings.Contains(output, secret) {
			t.Errorf("terminal output contains a secret that should have been scrubbed: %q\nfull output:\n%s", secret, output)
		}
	}
	if !strings.Contains(output, "HARMLESS_MARKER=this-should-survive") {
		t.Errorf("expected an ordinary env var to survive the scrub; output:\n%s", output)
	}
}
