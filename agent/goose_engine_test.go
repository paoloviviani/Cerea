package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
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
	setup := func(makeDefault bool) {
		t.Helper()
		if err := gooseSetup(context.Background(), creds, credsPath, stateDir, cfgDir, makeDefault, true); err != nil {
			t.Fatal(err)
		}
	}
	read := func() map[string]any {
		t.Helper()
		body, err := os.ReadFile(cfgPath)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := yaml.Unmarshal(body, &m); err != nil {
			t.Fatalf("config.yaml is not valid YAML: %v\n%s", err, body)
		}
		return m
	}
	// goose Desktop and the CLI rewrite config.yaml with serde, which drops comments.
	serde := func() {
		t.Helper()
		body, _ := os.ReadFile(cfgPath)
		var m map[string]any
		if err := yaml.Unmarshal(body, &m); err != nil {
			t.Fatal(err)
		}
		out, _ := yaml.Marshal(m)
		if err := os.WriteFile(cfgPath, out, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	exts := func(m map[string]any) map[string]any {
		e, _ := m["extensions"].(map[string]any)
		return e
	}

	setup(false)
	body, _ := os.ReadFile(gooseProviderPath(cfgDir))
	if strings.Contains(string(body), "session_id_header_override") || !strings.Contains(string(body), "Bearer s3cret") {
		t.Errorf("provider file:\n%s", body)
	}
	m := read()
	if m["GOOSE_PROVIDER"] != "openai" || m["GOOSE_MODEL"] != "gpt-x" {
		t.Errorf("setup without --default touched the defaults: %v", m)
	}
	if exts(m)["cerea_connectors"] == nil || exts(m)["developer"] == nil {
		t.Errorf("extension missing or other extension lost: %v", m)
	}
	// With --default, then goose rewrites the file (comments gone), then setup again:
	// still one extension, and the originals recorded by the first run survive.
	setup(true)
	serde()
	setup(true)
	serde()
	setup(true)
	m = read()
	if m["GOOSE_PROVIDER"] != "galopin" || len(exts(m)) != 2 {
		t.Errorf("after setup, a serde rewrite and setup again: %v", m)
	}
	// A second pass of serde-then-remove restores the user's own values, with no secret left.
	serde()
	if err := gooseSetupRemove(cfgDir, stateDir); err != nil {
		t.Fatal(err)
	}
	m = read()
	if m["GOOSE_PROVIDER"] != "openai" || m["GOOSE_MODEL"] != "gpt-x" || len(exts(m)) != 1 || exts(m)["developer"] == nil {
		t.Errorf("remove did not restore the originals: %v", m)
	}
	got, _ := os.ReadFile(cfgPath)
	if strings.Contains(string(got), "Bearer") || strings.Contains(string(got), "galopin") {
		t.Errorf("remove left setup's traces:\n%s", got)
	}
	for _, p := range []string{gooseProviderPath(cfgDir), filepath.Join(stateDir, gooseSidecarName), filepath.Join(stateDir, localAgentsFileName)} {
		if _, err := os.Stat(p); err == nil {
			t.Errorf("remove left %s", p)
		}
	}
}

func TestGooseYAMLMergesInlineExtensionsAndHandlesEmptyFiles(t *testing.T) {
	sc := &gooseSidecar{Was: map[string]*string{}, Set: map[string]string{}}
	ext := newGooseExt("http://127.0.0.1:1/local-agents", "tok")
	out, err := applyGooseConfig("extensions: {developer: {enabled: true, type: builtin, name: developer}}\nGOOSE_MODE: approve\n", sc, false, "", "", &ext)
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Extensions map[string]any `yaml:"extensions"`
		Mode       string         `yaml:"GOOSE_MODE"`
	}
	if err := yaml.Unmarshal([]byte(out), &m); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if m.Extensions["developer"] == nil || m.Extensions["cerea_connectors"] == nil || m.Mode != "approve" {
		t.Errorf("an inline extensions map was overwritten instead of merged:\n%s", out)
	}
	// An empty file and a null extensions key.
	for _, in := range []string{"", "extensions:\nGOOSE_MODE: approve\n", "extensions: {}\n"} {
		sc := &gooseSidecar{Was: map[string]*string{}, Set: map[string]string{}}
		out, err := applyGooseConfig(in, sc, false, "", "", &ext)
		if err != nil || !strings.Contains(out, "cerea_connectors:") {
			t.Fatalf("%q: %v\n%s", in, err, out)
		}
		back, changed, err := removeGooseConfig(out, sc)
		if err != nil || !changed || strings.Contains(back, "cerea") || strings.Contains(back, "tok") {
			t.Errorf("%q: remove = %q (changed %v, %v)", in, back, changed, err)
		}
	}
	// Not YAML, or not a map: refused, nothing rewritten.
	for _, in := range []string{"a: [", "- a\n- b\n"} {
		if _, err := applyGooseConfig(in, &gooseSidecar{Was: map[string]*string{}, Set: map[string]string{}}, false, "", "", &ext); err == nil {
			t.Errorf("%q was accepted", in)
		}
	}
}

func TestGooseRemoveWithoutARecordDropsADanglingDefault(t *testing.T) {
	sc := &gooseSidecar{Was: map[string]*string{}, Set: map[string]string{}}
	out, changed, err := removeGooseConfig("GOOSE_PROVIDER: galopin\nGOOSE_MODEL: m1\nother: 1\n", sc)
	if err != nil || !changed || strings.Contains(out, "galopin") || strings.Contains(out, "GOOSE_MODEL") || !strings.Contains(out, "other: 1") {
		t.Errorf("out=%q changed=%v err=%v", out, changed, err)
	}
	// A default the user has since changed is theirs.
	sc = &gooseSidecar{Was: map[string]*string{"GOOSE_PROVIDER": nil}, Set: map[string]string{"GOOSE_PROVIDER": "galopin"}}
	out, changed, _ = removeGooseConfig("GOOSE_PROVIDER: anthropic\n", sc)
	if changed || !strings.Contains(out, "anthropic") {
		t.Errorf("a changed default was touched: %q", out)
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

func TestGooseBinaryIsTheVerifiedCopyNotPATH(t *testing.T) {
	bin := t.TempDir()
	fake := filepath.Join(bin, "goose")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\necho 'goose 9'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv(gooseEnvOverride, "")
	if got, err := gooseBinary(); err == nil {
		t.Errorf("a goose on PATH was used: %s", got)
	}
	if gooseOverrideWarning() != "" {
		t.Error("a warning without an override")
	}
	t.Setenv(gooseEnvOverride, fake)
	if got, err := gooseBinary(); err != nil || got != fake {
		t.Errorf("override: %q, %v", got, err)
	}
	if w := gooseOverrideWarning(); !strings.Contains(w, "WARNING") || !strings.Contains(w, fake) {
		t.Errorf("override warning = %q", w)
	}
}

func TestGooseYAMLRestoresNonScalarOriginalsAndRefusesMultiDocs(t *testing.T) {
	ext := newGooseExt("http://127.0.0.1:1/local-agents", "tok")
	for _, orig := range []string{
		"GOOSE_PROVIDER:\nGOOSE_MODEL: {a: 1}\n",                // null and a map
		"base: &p openai\nGOOSE_PROVIDER: *p\nGOOSE_MODEL: m\n", // an alias
	} {
		sc := &gooseSidecar{Was: map[string]*string{}, Set: map[string]string{}}
		out, err := applyGooseConfig(orig, sc, true, gooseProviderID, "m1", &ext)
		if err != nil {
			t.Fatal(err)
		}
		back, changed, err := removeGooseConfig(out, sc)
		if err != nil || !changed {
			t.Fatalf("%q: %v changed=%v", orig, err, changed)
		}
		var want, got map[string]any
		if err := yaml.Unmarshal([]byte(orig), &want); err != nil {
			t.Fatal(err)
		}
		if err := yaml.Unmarshal([]byte(back), &got); err != nil {
			t.Fatalf("%v\n%s", err, back)
		}
		delete(got, "extensions")
		if !reflect.DeepEqual(want, got) {
			t.Errorf("original %q came back as %q (%v != %v)", orig, back, want, got)
		}
	}
	for _, in := range []string{"a: 1\n---\nb: 2\n"} {
		sc := &gooseSidecar{Was: map[string]*string{}, Set: map[string]string{}}
		if _, err := applyGooseConfig(in, sc, false, "", "", &ext); err == nil {
			t.Errorf("a two-document file was accepted: %q", in)
		}
		if _, _, err := removeGooseConfig(in, sc); err == nil {
			t.Errorf("remove accepted a two-document file")
		}
	}
}

func TestGooseSetupNoConnectorsWithdrawsAnEarlierOptIn(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	stateDir := t.TempDir()
	credsPath := filepath.Join(stateDir, "credentials.json")
	cfgDir := filepath.Join(home, "config", "goose")
	if err := os.MkdirAll(cfgDir, 0o700); err != nil {
		t.Fatal(err)
	}
	cfgPath := filepath.Join(cfgDir, "config.yaml")
	if err := os.WriteFile(cfgPath, []byte("extensions:\n  developer:\n    enabled: true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	creds := &credentials{ShimPort: 41871, ShimSecret: "s3cret", Gateway: "http://127.0.0.1:1/v1"}
	if err := writeGooseEngineConfig(gooseRootFor(credsPath), creds, []gatewayModel{{ID: "m1"}}); err != nil {
		t.Fatal(err)
	}
	if err := gooseSetup(context.Background(), creds, credsPath, stateDir, cfgDir, false, true); err != nil {
		t.Fatal(err)
	}
	if lc, ok := readLocalAgentsConfig(stateDir); !ok || !lc.LocalConnectors {
		t.Fatalf("setup did not opt in: %+v %v", lc, ok)
	}
	if err := gooseSetup(context.Background(), creds, credsPath, stateDir, cfgDir, false, false); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(cfgPath)
	if strings.Contains(string(got), "cerea_connectors") || strings.Contains(string(got), "Bearer") || !strings.Contains(string(got), "developer") {
		t.Errorf("the extension was not withdrawn, or another was lost:\n%s", got)
	}
	if lc, ok := readLocalAgentsConfig(stateDir); !ok || lc.LocalConnectors {
		t.Errorf("local connectors still offered: %+v", lc)
	}
}
