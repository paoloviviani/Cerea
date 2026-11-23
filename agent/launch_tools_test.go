package main

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/packaging"
)

// fakeLaunchTool writes an executable that answers --version and otherwise
// records its arguments, the listed environment variables and the contents of
// the listed files (read while the tool runs, since launch removes its temp
// dir), then exits with code.
func fakeLaunchTool(t *testing.T, r *launchRig, name, version string, code int, envVars []string, files []string) string {
	t.Helper()
	path := filepath.Join(filepath.Dir(r.fakeBin), name)
	var b strings.Builder
	b.WriteString("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo '" + version + "'; exit 0; fi\n{\n")
	b.WriteString("  echo \"ARGS:$*\"\n  echo \"CWD:$(pwd)\"\n")
	for _, v := range envVars {
		b.WriteString("  echo \"" + v + "=${" + v + "-<unset>}\"\n")
	}
	for _, f := range files {
		b.WriteString("  echo \"--- " + f + "\"\n  cat \"" + f + "\" 2>/dev/null\n")
	}
	b.WriteString("} > " + r.record + "\nexit " + string(rune('0'+code)) + "\n")
	if err := os.WriteFile(path, []byte(b.String()), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func portFree(t *testing.T, port int) {
	t.Helper()
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", itPortStr(port)))
	if err != nil {
		t.Fatalf("proxy still holds the port after exit: %v", err)
	}
	ln.Close()
}

func TestLaunchGoose(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	// the user's own goose config: must stay byte for byte
	userCfg := filepath.Join(home, "config", "goose")
	if err := os.MkdirAll(userCfg, 0o755); err != nil {
		t.Fatal(err)
	}
	userYAML := filepath.Join(userCfg, "config.yaml")
	if err := os.WriteFile(userYAML, []byte("GOOSE_PROVIDER: mine\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bin := fakeLaunchTool(t, r, "goose", "goose "+packaging.GooseVersion(), 5,
		[]string{"GOOSE_PATH_ROOT", "GOOSE_MODE", "GOOSE_PROVIDER", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOSE_MODEL", "GOOSE_DISABLE_KEYRING"},
		[]string{"$GOOSE_PATH_ROOT/config/config.yaml", "$GOOSE_PATH_ROOT/config/custom_providers/galopin.json"})
	o := r.opts("session", "--resume")
	o.gooseBin = bin
	err := launchGoose(context.Background(), o)
	var ee exitError
	if !errors.As(err, &ee) || ee.code != 5 {
		t.Fatalf("err = %v, want exit code 5", err)
	}
	rec := r.recorded(t)
	for _, want := range []string{
		"ARGS:session --resume", "GOOSE_MODE=approve", "GOOSE_PROVIDER=galopin",
		"OPENAI_API_KEY=<unset>", "ANTHROPIC_API_KEY=<unset>", "GOOSE_DISABLE_KEYRING=1",
		"GOOSE_MODEL: gw-model", `"base_url": "http://127.0.0.1:` + itPortStr(r.port) + `/v1/chat/completions"`,
		"Bearer " + r.creds_.ShimSecret,
	} {
		if !strings.Contains(rec, want) {
			t.Errorf("record lacks %q:\n%s", want, rec)
		}
	}
	if strings.Contains(rec, "GOOSE_PATH_ROOT=<unset>") || strings.Contains(rec, "x-session-id") {
		t.Errorf("bad root or a Cerea session header:\n%s", rec)
	}
	if b, _ := os.ReadFile(userYAML); string(b) != "GOOSE_PROVIDER: mine\n" {
		t.Errorf("the user's goose config changed: %q", b)
	}
	if _, err := os.Stat(filepath.Join(userCfg, "custom_providers")); err == nil {
		t.Error("a provider file was written into the user's goose config")
	}
	for _, line := range strings.Split(rec, "\n") {
		if root, ok := strings.CutPrefix(line, "GOOSE_PATH_ROOT="); ok {
			if _, err := os.Stat(root); err == nil {
				t.Errorf("temp goose root %s was not removed", root)
			}
		}
	}
	if !strings.Contains(r.stderrBuf.String(), "local goose (gw-model), billed to team; not supervised by Cerea") {
		t.Errorf("startup line missing:\n%s", r.stderrBuf.String())
	}
	if strings.Contains(r.stderrBuf.String(), "warning") {
		t.Errorf("unexpected warning:\n%s", r.stderrBuf.String())
	}
	portFree(t, r.port)
}

func TestLaunchGooseDefaultsToSessionAndWarnsOnVersion(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	bin := fakeLaunchTool(t, r, "goose", "goose 0.0.1", 0, nil, nil)
	o := r.opts()
	o.gooseBin, o.model = bin, "other-model"
	if err := launchGoose(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	if rec := r.recorded(t); !strings.Contains(rec, "ARGS:session\n") {
		t.Errorf("no default 'session' argument:\n%s", rec)
	}
	s := r.stderrBuf.String()
	if !strings.Contains(s, "is goose 0.0.1") || !strings.Contains(s, "--model other-model is not in the gateway") {
		t.Errorf("warnings missing:\n%s", s)
	}
}

func TestLaunchGooseNotEnrolled(t *testing.T) {
	err := launchGoose(context.Background(), launchOptions{credsPath: filepath.Join(t.TempDir(), "c.json"), gooseBin: "/bin/true"})
	if err == nil || !strings.Contains(err.Error(), "galopin enroll") {
		t.Fatalf("err = %v", err)
	}
}

func TestLaunchVibe(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	home := t.TempDir()
	t.Setenv("HOME", home)
	userVibe := filepath.Join(home, ".vibe")
	if err := os.MkdirAll(userVibe, 0o755); err != nil {
		t.Fatal(err)
	}
	userTOML := filepath.Join(userVibe, "config.toml")
	if err := os.WriteFile(userTOML, []byte("active_model = \"mine\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bin := fakeLaunchTool(t, r, "vibe", "vibe "+packaging.VibeVersion(), 3,
		[]string{"VIBE_HOME", "MISTRAL_API_KEY", "OPENAI_API_KEY", "VIBE_ACTIVE_MODEL"},
		[]string{"$VIBE_HOME/config.toml", "$VIBE_HOME/trusted_folders.toml"})
	r.baseEnv = append(r.baseEnv, "MISTRAL_API_KEY=leak", "VIBE_ACTIVE_MODEL=evil")
	o := r.opts("--agent", "ask")
	o.vibeBin = bin
	err := launchVibe(context.Background(), o)
	var ee exitError
	if !errors.As(err, &ee) || ee.code != 3 {
		t.Fatalf("err = %v, want exit code 3", err)
	}
	rec := r.recorded(t)
	for _, want := range []string{
		"ARGS:--agent ask", "MISTRAL_API_KEY=<unset>", "OPENAI_API_KEY=<unset>", "VIBE_ACTIVE_MODEL=<unset>",
		`active_model = "gw-model"`, `api_base = "http://127.0.0.1:` + itPortStr(r.port) + `/v1"`,
		"Bearer " + r.creds_.ShimSecret, "enable_auto_approve = false", "trusted = []",
	} {
		if !strings.Contains(rec, want) {
			t.Errorf("record lacks %q:\n%s", want, rec)
		}
	}
	if strings.Contains(rec, "VIBE_HOME=<unset>") || strings.Contains(rec, "VIBE_HOME="+userVibe) {
		t.Errorf("VIBE_HOME not a temp dir:\n%s", rec)
	}
	if b, _ := os.ReadFile(userTOML); string(b) != "active_model = \"mine\"\n" {
		t.Errorf("the user's Vibe config changed: %q", b)
	}
	if ents, _ := os.ReadDir(userVibe); len(ents) != 1 {
		t.Errorf("files were added to ~/.vibe: %v", ents)
	}
	for _, line := range strings.Split(rec, "\n") {
		if h, ok := strings.CutPrefix(line, "VIBE_HOME="); ok {
			if _, err := os.Stat(h); err == nil {
				t.Errorf("temp Vibe home %s was not removed", h)
			}
		}
	}
	if !strings.Contains(r.stderrBuf.String(), "local Mistral Vibe (gw-model), billed to team; not supervised by Cerea") {
		t.Errorf("startup line missing:\n%s", r.stderrBuf.String())
	}
	portFree(t, r.port)
}

func TestLaunchVibeUnknownModelAndVersionWarning(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	bin := fakeLaunchTool(t, r, "vibe", "vibe 0.0.1", 0, nil, nil)
	o := r.opts()
	o.vibeBin, o.model = bin, "nope"
	if err := launchVibe(context.Background(), o); err == nil || !strings.Contains(err.Error(), "not in the gateway's model list") {
		t.Fatalf("err = %v, want an unknown-model refusal", err)
	}
	portFree(t, r.port) // refused before the proxy started
	o.model = ""
	if err := launchVibe(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	if s := r.stderrBuf.String(); !strings.Contains(s, "is Mistral Vibe 0.0.1") {
		t.Errorf("no version warning:\n%s", s)
	}
}

func TestLaunchClaude(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	home := t.TempDir()
	t.Setenv("HOME", home)
	userSettings := filepath.Join(home, ".claude", "settings.json")
	userJSON := filepath.Join(home, ".claude.json")
	if err := os.MkdirAll(filepath.Dir(userSettings), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{userSettings, userJSON} {
		if err := os.WriteFile(f, []byte("{\"mine\":true}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	bin := fakeLaunchTool(t, r, "claude", "2.1.317 (Claude Code)", 4,
		[]string{"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
			"ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_USE_BEDROCK", "OPENAI_API_KEY", "NO_PROXY"},
		[]string{"$2"})
	r.baseEnv = append(r.baseEnv, "CLAUDE_CODE_USE_BEDROCK=1", "ANTHROPIC_BASE_URL=https://api.anthropic.com", "NO_PROXY=corp.example")
	o := r.opts("-p", "hello world")
	o.claudeBin, o.model, o.smallModel = bin, "gw-model", "gw-small"
	err := launchClaude(context.Background(), o)
	var ee exitError
	if !errors.As(err, &ee) || ee.code != 4 {
		t.Fatalf("err = %v, want exit code 4", err)
	}
	rec := r.recorded(t)
	for _, want := range []string{
		"ARGS:--settings ", "--model gw-model -p hello world",
		"ANTHROPIC_BASE_URL=http://127.0.0.1:" + itPortStr(r.port) + "\n",
		"ANTHROPIC_AUTH_TOKEN=" + r.creds_.ShimSecret,
		"ANTHROPIC_API_KEY=<unset>", "CLAUDE_CODE_USE_BEDROCK=<unset>", "OPENAI_API_KEY=<unset>",
		"ANTHROPIC_MODEL=gw-model", "ANTHROPIC_DEFAULT_HAIKU_MODEL=gw-small", "ANTHROPIC_SMALL_FAST_MODEL=gw-small",
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "NO_PROXY=corp.example,127.0.0.1,localhost",
		`"ANTHROPIC_BASE_URL":"http://127.0.0.1:` + itPortStr(r.port) + `"`,
	} {
		if !strings.Contains(rec, want) {
			t.Errorf("record lacks %q:\n%s", want, rec)
		}
	}
	if strings.Contains(rec, "api.anthropic.com") || strings.Contains(rec, "sk-ant-leak") {
		t.Errorf("an inherited Anthropic setting reached claude:\n%s", rec)
	}
	for _, f := range []string{userSettings, userJSON} {
		if b, _ := os.ReadFile(f); string(b) != "{\"mine\":true}\n" {
			t.Errorf("%s changed: %q", f, b)
		}
	}
	if ents, _ := os.ReadDir(home); len(ents) != 2 {
		t.Errorf("unexpected files in HOME: %v", ents)
	}
	s := r.stderrBuf.String()
	if !strings.Contains(s, "Claude Code 2.1.317 (Claude Code) (galopin pins no Claude Code version") ||
		!strings.Contains(s, "local Claude Code (gw-model, small model gw-small), billed to team; not supervised by Cerea") {
		t.Errorf("stderr lines missing:\n%s", s)
	}
	portFree(t, r.port)
}

func TestLaunchClaudeDefaultModelFromGateway(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	bin := fakeLaunchTool(t, r, "claude", "2.1.317 (Claude Code)", 0, []string{"ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"}, nil)
	o := r.opts()
	o.claudeBin = bin
	if err := launchClaude(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	rec := r.recorded(t)
	if !strings.Contains(rec, "ANTHROPIC_MODEL=gw-model") || !strings.Contains(rec, "ANTHROPIC_DEFAULT_HAIKU_MODEL=gw-model") {
		t.Errorf("defaults not the gateway's first model:\n%s", rec)
	}
}

func TestLaunchClaudeNotEnrolledAndMissingBinary(t *testing.T) {
	err := launchClaude(context.Background(), launchOptions{credsPath: filepath.Join(t.TempDir(), "c.json"), claudeBin: "/bin/true"})
	if err == nil || !strings.Contains(err.Error(), "galopin enroll") {
		t.Fatalf("err = %v", err)
	}
	r := newLaunchRig(t, 0, "x")
	o := r.opts()
	o.claudeBin = filepath.Join(t.TempDir(), "nope")
	if err := launchClaude(context.Background(), o); err == nil || !strings.Contains(err.Error(), "not an executable") {
		t.Fatalf("err = %v", err)
	}
}
