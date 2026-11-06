package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnrollEngineIsRecordedKeptAndValidated(t *testing.T) {
	srv := fakeEnrollServer(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))
	creds := filepath.Join(t.TempDir(), "credentials.json")
	if err := runEnroll(enrollArgs(srv.URL, creds, "--engine", "goose")); err != nil {
		t.Fatal(err)
	}
	rec, err := loadCredentials(creds)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Engine != engineGoose || rec.OpencodeConfig != "" {
		t.Errorf("engine=%q opencode_config=%q, want goose and none", rec.Engine, rec.OpencodeConfig)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(creds), "opencode.json")); err == nil {
		t.Error("a goose enroll wrote opencode.json")
	}
	root := gooseRootFor(creds)
	for _, f := range []string{"config/config.yaml", "config/custom_providers/galopin.json"} {
		if _, err := os.Stat(filepath.Join(root, f)); err != nil {
			t.Errorf("%s: %v", f, err)
		}
	}
	// Re-enroll without the flag keeps goose; with --engine opencode it switches back.
	if err := runEnroll(enrollArgs(srv.URL, creds)); err != nil {
		t.Fatal(err)
	}
	if rec, _ = loadCredentials(creds); rec.Engine != engineGoose {
		t.Errorf("re-enroll lost the engine: %q", rec.Engine)
	}
	if err := runEnroll(enrollArgs(srv.URL, creds, "--engine", "opencode")); err != nil {
		t.Fatal(err)
	}
	if rec, _ = loadCredentials(creds); rec.Engine != "" || rec.OpencodeConfig == "" {
		t.Errorf("switch back: engine=%q opencode_config=%q", rec.Engine, rec.OpencodeConfig)
	}
	if err := runEnroll(enrollArgs(srv.URL, creds, "--engine", "pi")); err == nil || !strings.Contains(err.Error(), "--engine") {
		t.Errorf("--engine pi: %v", err)
	}
}

func TestResolveBackendKindFollowsTheEngine(t *testing.T) {
	if got := resolveBackendKind("", false, &credentials{Engine: engineGoose}); got != backendGoose {
		t.Errorf("goose machine = %q", got)
	}
	if got := resolveBackendKind("", false, &credentials{}); got != "" {
		t.Errorf("opencode machine = %q", got)
	}
	if got := resolveBackendKind("acp", false, &credentials{Engine: engineGoose}); got != "acp" {
		t.Errorf("explicit --backend acp = %q", got)
	}
	if got := resolveBackendKind("", true, &credentials{Engine: engineGoose}); got != backendNone {
		t.Errorf("connectors-only = %q", got)
	}
}

func TestGooseEngineConfigIsGaloppinsOwn(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	t.Setenv("GOOSE_PATH_ROOT", "")
	root := filepath.Join(t.TempDir(), "goose")
	creds := &credentials{ShimPort: 41871, ShimSecret: "s3cret"}
	err := writeGooseEngineConfig(root, creds, []gatewayModel{
		{ID: "zeta", ContextWindow: 1000}, {ID: "alpha"}, {ID: "embed", Kind: "embedding"},
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg, _ := os.ReadFile(filepath.Join(root, "config", "config.yaml"))
	for _, want := range []string{"GOOSE_PROVIDER: galopin", "GOOSE_MODEL: alpha", "GOOSE_MODE: approve", "GOOSE_DISABLE_KEYRING: true", "GOOSE_TELEMETRY_ENABLED: false"} {
		if !strings.Contains(string(cfg), want) {
			t.Errorf("config.yaml lacks %q:\n%s", want, cfg)
		}
	}
	var spec gooseProviderSpec
	body, _ := os.ReadFile(filepath.Join(root, "config", "custom_providers", "galopin.json"))
	if err := json.Unmarshal(body, &spec); err != nil {
		t.Fatal(err)
	}
	if spec.BaseURL != "http://127.0.0.1:41871/v1/chat/completions" || spec.Headers["Authorization"] != "Bearer s3cret" ||
		spec.Engine != "openai" || spec.SessionIDHeaderOverride != "x-session-id" {
		t.Errorf("provider = %+v", spec)
	}
	if len(spec.Models) != 2 || spec.Models[0].Name != "alpha" || spec.Models[1].ContextLimit != 1000 {
		t.Errorf("models = %+v (chat models only, sorted, limits from discovery)", spec.Models)
	}
	// The session store is the user's own.
	target, err := os.Readlink(filepath.Join(root, "data", "sessions"))
	if err != nil || target != filepath.Join(home, "data", "goose", "sessions") {
		t.Errorf("sessions link = %q, %v", target, err)
	}
	// Nothing was written to the user's goose config.
	if _, err := os.Stat(filepath.Join(home, "config", "goose")); err == nil {
		t.Error("the engine path touched the user's goose config directory")
	}
	// Idempotent.
	if err := writeGooseEngineConfig(root, creds, []gatewayModel{{ID: "alpha"}}); err != nil {
		t.Fatal(err)
	}
}

func TestGooseEnvStripsInheritedProviderCredentials(t *testing.T) {
	base := []string{
		"PATH=/bin", "HOME=/h", "OPENAI_API_KEY=k", "OPENAI_HOST=h", "ANTHROPIC_API_KEY=k", "GOOSE_MODE=auto",
		"GOOSE_PROVIDER=anthropic", "GOOSE_PATH_ROOT=/elsewhere", "GOOGLE_API_KEY=k", "AWS_PROFILE=keep",
	}
	env := strings.Join(gooseEnv("/r", base), "\n")
	for _, bad := range []string{"OPENAI_", "ANTHROPIC_", "GOOGLE_API_KEY", "GOOSE_MODE=auto", "GOOSE_PROVIDER=anthropic", "/elsewhere"} {
		if strings.Contains(env, bad) {
			t.Errorf("environment still carries %q:\n%s", bad, env)
		}
	}
	for _, want := range []string{"PATH=/bin", "HOME=/h", "AWS_PROFILE=keep", "GOOSE_PATH_ROOT=/r", "GOOSE_MODE=approve", "GOOSE_DISABLE_KEYRING=1", "GOOSE_TELEMETRY_OFF=1", "GOOSE_PROVIDER=galopin"} {
		if !strings.Contains(env, want) {
			t.Errorf("environment lacks %q", want)
		}
	}
}

func TestSetupWritesOnlyTheUsersProviderAndLeavesDefaultsAlone(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	t.Setenv("GOOSE_PATH_ROOT", "")
	stateDir := t.TempDir()
	credsPath := filepath.Join(stateDir, "credentials.json")
	cfgDir := filepath.Join(home, "config", "goose")
	if err := os.MkdirAll(cfgDir, 0o700); err != nil {
		t.Fatal(err)
	}
	orig := "GOOSE_PROVIDER: openai\nGOOSE_MODEL: gpt-x # mine\nextensions:\n  developer:\n    enabled: true\n    type: builtin\n    name: developer\n"
	cfgPath := filepath.Join(cfgDir, "config.yaml")
	if err := os.WriteFile(cfgPath, []byte(orig), 0o600); err != nil {
		t.Fatal(err)
	}
	// An engine config the setup falls back to for the model list (no gateway here).
	creds := &credentials{ShimPort: 41871, ShimSecret: "s3cret", Gateway: "http://127.0.0.1:1/v1"}
	if err := writeGooseEngineConfig(gooseRootFor(credsPath), creds, []gatewayModel{{ID: "m1"}, {ID: "m2"}}); err != nil {
		t.Fatal(err)
	}
	if err := gooseSetup(context.Background(), creds, credsPath, cfgDir, false, true); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(gooseProviderPath(cfgDir))
	if strings.Contains(string(body), "session_id_header_override") || !strings.Contains(string(body), "Bearer s3cret") {
		t.Errorf("provider file:\n%s", body)
	}
	got, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(got), "GOOSE_PROVIDER: openai\n") || !strings.Contains(string(got), "GOOSE_MODEL: gpt-x # mine\n") {
		t.Errorf("setup without --default touched the defaults:\n%s", got)
	}
	if !strings.Contains(string(got), "cerea_connectors:") || !strings.Contains(string(got), "  developer:") {
		t.Errorf("extension block missing or other extension lost:\n%s", got)
	}
	// Again, with --default: idempotent, and remove restores everything.
	for i := 0; i < 2; i++ {
		if err := gooseSetup(context.Background(), creds, credsPath, cfgDir, true, true); err != nil {
			t.Fatal(err)
		}
	}
	got, _ = os.ReadFile(cfgPath)
	if strings.Count(string(got), "cerea_connectors:") != 1 || !strings.Contains(string(got), "GOOSE_PROVIDER: galopin") {
		t.Errorf("after --default twice:\n%s", got)
	}
	if err := gooseSetupRemove(cfgDir); err != nil {
		t.Fatal(err)
	}
	got, _ = os.ReadFile(cfgPath)
	if string(got) != orig {
		t.Errorf("remove did not restore the file.\nwant:\n%s\ngot:\n%s", orig, got)
	}
	if _, err := os.Stat(gooseProviderPath(cfgDir)); err == nil {
		t.Error("remove left the provider file")
	}
}

func TestGooseYAMLEditsWithoutExtensionsOrFile(t *testing.T) {
	text := setGooseExtension("", "http://127.0.0.1:1/local-agents", "tok")
	if !strings.HasPrefix(text, "extensions:\n  # >>> ") {
		t.Errorf("fresh file:\n%s", text)
	}
	back, changed := removeGooseManaged(text)
	if !changed || strings.TrimSpace(back) != "" {
		t.Errorf("remove from a file setup created = %q (changed %v)", back, changed)
	}
	flow := setGooseExtension("extensions: {}\nGOOSE_MODE: approve\n", "u", "t")
	if !strings.HasPrefix(flow, "extensions:\n") || !strings.Contains(flow, "GOOSE_MODE: approve") {
		t.Errorf("flow-style extensions:\n%s", flow)
	}
}

func TestToolNamesAreModelSafe(t *testing.T) {
	if got := toolName("My Server", "do.thing"); got != "My_Server-do_thing" {
		t.Errorf("toolName = %q", got)
	}
	long := toolName(strings.Repeat("a", 50), strings.Repeat("b", 50))
	if len(long) > 64 {
		t.Errorf("long name %d chars", len(long))
	}
}
