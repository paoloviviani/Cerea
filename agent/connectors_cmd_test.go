package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// captureStdout runs fn and returns what it printed to stdout.
func captureStdout(t *testing.T, fn func() error) (string, error) {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	done := make(chan string)
	go func() { b, _ := io.ReadAll(r); done <- string(b) }()
	runErr := fn()
	w.Close()
	os.Stdout = old
	return <-done, runErr
}

func writeConnectorsDir(t *testing.T, config string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, mcpConfigFileName), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestConnectorsListPrintsNamesTransportsAndStates(t *testing.T) {
	dir := writeConnectorsDir(t, `{"mcpServers":{
	  "a-stdio":{"command":"x","allowedTools":["t"]},
	  "b-http":{"type":"http","url":"https://x.example/mcp"},
	  "c-sse":{"type":"sse","url":"https://x.example/sse","disabled":true},
	  "d-broken":{"command":"x","args":["${GALOPIN_TEST_UNSET_VAR}"]}}}`)
	out, err := captureStdout(t, func() error { return runConnectors([]string{"list", "--state-dir", dir}) })
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"a-stdio", "stdio", "ready", "allowedTools: 1", "b-http", "http", "c-sse", "sse", "disabled",
		"d-broken", "invalid", "${GALOPIN_TEST_UNSET_VAR} is not set"} {
		if !strings.Contains(out, want) {
			t.Errorf("list output lacks %q:\n%s", want, out)
		}
	}
}

func TestConnectorsListWithNoFile(t *testing.T) {
	out, err := captureStdout(t, func() error { return runConnectors([]string{"list", "--state-dir", t.TempDir()}) })
	if err != nil || !strings.Contains(out, "no servers") {
		t.Fatalf("%q %v", out, err)
	}
}

func TestConnectorsTestStartsInitializesListsAndStops(t *testing.T) {
	dir := writeConnectorsDir(t, connectorsConfig(t))
	out, err := captureStdout(t, func() error { return runConnectors([]string{"test", "notes", "--state-dir", dir}) })
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if !strings.Contains(out, "fake 1") || !strings.Contains(out, "2 tool(s) offered: read_file, boom") {
		t.Errorf("output:\n%s", out)
	}
	// The ceiling applies: write_file is not offered.
	if strings.Contains(out, "write_file") {
		t.Errorf("test lists a tool the ceiling hides:\n%s", out)
	}
	// An unknown name, a missing name and a server that cannot start are errors.
	if err := runConnectors([]string{"test", "nope", "--state-dir", dir}); err == nil {
		t.Error("an unknown server tested fine")
	}
	if err := runConnectors([]string{"test", "--state-dir", dir}); err == nil {
		t.Error("test without a name")
	}
}

func TestConnectorsLoginRefusesStdioAndUnknown(t *testing.T) {
	dir := writeConnectorsDir(t, connectorsConfig(t))
	if err := runConnectors([]string{"login", "notes", "--state-dir", dir}); err == nil || !strings.Contains(err.Error(), "stdio") {
		t.Errorf("login to a stdio server: %v", err)
	}
	if err := runConnectors([]string{"login", "nope", "--state-dir", dir}); err == nil || !strings.Contains(err.Error(), "no server named") {
		t.Errorf("login to nothing: %v", err)
	}
}

func TestConnectorsStateDirFollowsCreds(t *testing.T) {
	d, err := connectorsStateDir(&connectorsOptions{creds: "/x/y/credentials.json"})
	if err != nil || d != "/x/y" {
		t.Fatalf("%q %v", d, err)
	}
	d, _ = connectorsStateDir(&connectorsOptions{creds: "/x/y/credentials.json", stateDir: "/z"})
	if d != "/z" {
		t.Fatalf("%q", d)
	}
}
