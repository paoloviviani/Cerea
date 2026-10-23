package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func envOf(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func writeFile(t *testing.T, path, body string) string {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestResolveMcpConfigPrecedence(t *testing.T) {
	state, other := t.TempDir(), t.TempDir()
	flagFile := writeFile(t, filepath.Join(other, "flag.json"), "{}")
	envFile := writeFile(t, filepath.Join(other, "env.json"), "{}")
	env := envOf(map[string]string{mcpConfigEnv: envFile})

	got, explicit, err := resolveMcpConfig(flagFile, env, state)
	if err != nil || !explicit || got != flagFile {
		t.Errorf("flag over env: %q %v %v", got, explicit, err)
	}
	got, explicit, err = resolveMcpConfig("", env, state)
	if err != nil || !explicit || got != envFile {
		t.Errorf("env over default: %q %v %v", got, explicit, err)
	}
	got, explicit, err = resolveMcpConfig("", envOf(nil), state)
	if err != nil || explicit || got != filepath.Join(state, mcpConfigFileName) {
		t.Errorf("default (absent is fine): %q %v %v", got, explicit, err)
	}
}

func TestResolveMcpConfigRelativeAndTilde(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "rel.json"), "{}")
	t.Chdir(dir)
	got, _, err := resolveMcpConfig("rel.json", envOf(nil), t.TempDir())
	want, _ := filepath.EvalSymlinks(filepath.Join(dir, "rel.json"))
	if g, _ := filepath.EvalSymlinks(got); err != nil || g != want {
		t.Errorf("relative: %q %v", got, err)
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	writeFile(t, filepath.Join(home, "c.json"), "{}")
	got, _, err = resolveMcpConfig("~/c.json", envOf(nil), t.TempDir())
	if err != nil || got != filepath.Join(home, "c.json") {
		t.Errorf("tilde: %q %v", got, err)
	}
	got, _, err = resolveMcpConfig("", envOf(map[string]string{mcpConfigEnv: "~/c.json"}), t.TempDir())
	if err != nil || got != filepath.Join(home, "c.json") {
		t.Errorf("tilde via env: %q %v", got, err)
	}
}

func TestResolveMcpConfigMissingExplicitFails(t *testing.T) {
	dir := t.TempDir()
	_, _, err := resolveMcpConfig(filepath.Join(dir, "nope.json"), envOf(nil), dir)
	if err == nil || !strings.Contains(err.Error(), "--mcp-config") || !strings.Contains(err.Error(), "no such file") {
		t.Errorf("flag: %v", err)
	}
	_, _, err = resolveMcpConfig("", envOf(map[string]string{mcpConfigEnv: filepath.Join(dir, "nope.json")}), dir)
	if err == nil || !strings.Contains(err.Error(), mcpConfigEnv) {
		t.Errorf("env: %v", err)
	}
	if _, _, err = resolveMcpConfig(dir, envOf(nil), dir); err == nil {
		t.Error("a directory was accepted")
	}
}

// Claude Code's ~/.claude.json carries much besides mcpServers; the rest is ignored.
const claudeCodeStyle = `{"numStartups":12,"theme":"dark","projects":{"/x":{"mcpServers":{"p":{"command":"y"}}}},
 "oauthAccount":{"emailAddress":"a@b"},
 "mcpServers":{"fs":{"type":"stdio","command":"x","args":["a"],"env":{}},"web":{"type":"http","url":"https://x.example/mcp"}}}`

func TestConnectorsListReadsMcpConfigFlagAndEnv(t *testing.T) {
	state := t.TempDir()
	file := writeFile(t, filepath.Join(t.TempDir(), ".claude.json"), claudeCodeStyle)
	for name, args := range map[string][]string{
		"flag": {"list", "--state-dir", state, "--mcp-config", file},
	} {
		out, err := captureStdout(t, func() error { return runConnectors(args) })
		if err != nil || !strings.Contains(out, "fs") || !strings.Contains(out, "web") || strings.Contains(out, "\np ") {
			t.Errorf("%s: %q %v", name, out, err)
		}
	}
	t.Setenv(mcpConfigEnv, file)
	out, err := captureStdout(t, func() error { return runConnectors([]string{"list", "--state-dir", state}) })
	if err != nil || !strings.Contains(out, "fs") {
		t.Errorf("env: %q %v", out, err)
	}
}

func TestConnectorsMissingMcpConfigIsAnError(t *testing.T) {
	_, err := captureStdout(t, func() error {
		return runConnectors([]string{"list", "--state-dir", t.TempDir(), "--mcp-config", "/nonexistent/x.json"})
	})
	if err == nil || !strings.Contains(err.Error(), "no such file") {
		t.Errorf("err = %v", err)
	}
}

func TestExplicitMcpConfigIsConfiguredAndReloads(t *testing.T) {
	state := t.TempDir() // holds no mcp.json
	file := writeFile(t, filepath.Join(t.TempDir(), "claude_desktop_config.json"), claudeCodeStyle)
	mc := &machine{}
	hub := mc.startConnectors(state, file)
	t.Cleanup(hub.Shutdown)
	if !hub.Configured() {
		t.Error("not configured: an agent machine would not say mcp in its hello")
	}
	hub.Reload()
	if n := len(hub.List()); n != 2 {
		t.Fatalf("servers = %d", n)
	}
	writeFile(t, file, `{"mcpServers":{"only":{"command":"z"}}}`)
	hub.Reload()
	if l := hub.List(); len(l) != 1 || l[0].Name != "only" {
		t.Errorf("after edit: %+v", l)
	}
}
