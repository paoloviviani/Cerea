package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/internal/decide"
	"galopin/packaging"
)

func TestVibeModelsAreChatModelsSortedWithAFloorOnTheWindow(t *testing.T) {
	got := vibeModels([]gatewayModel{
		{ID: "z-chat", ContextWindow: 200000, InputModalities: []string{"text", "image"}},
		{ID: "embed", Kind: "embedding"},
		{ID: "", Kind: "chat"},
		{ID: "a-chat", DisplayName: "A Chat"},
		{ID: "tiny", ContextWindow: 4000},
		{ID: "a-chat"},
	})
	var ids []string
	for _, m := range got {
		ids = append(ids, m.ID)
	}
	if strings.Join(ids, ",") != "a-chat,tiny,z-chat" {
		t.Fatalf("models = %v", ids)
	}
	if got[0].Context != defaultContextWindow || got[0].Display != "A Chat" {
		t.Errorf("a-chat = %+v", got[0])
	}
	if got[1].Context != vibeMinContext {
		t.Errorf("a window under Vibe's minimum is %d, want %d", got[1].Context, vibeMinContext)
	}
	if !got[2].Images || got[0].Images {
		t.Errorf("image support: %+v", got)
	}
}

func TestVibeConfigPointsAtTheShimOnlyAndSaysTheFloor(t *testing.T) {
	cfg := vibeConfigTOML("127.0.0.1:41871", `s3cret"x`, []vibeModel{{ID: "m/1", Display: "M \"one\"", Context: 50000, Images: true}, {ID: "m2", Context: 20000}})
	for _, want := range []string{
		`active_model = "m/1"`,
		// only the gateway's models: Vibe's own Mistral defaults must not be selectable
		`allowed_models = ["m/1", "m2"]`,
		`enable_telemetry = false`,
		`enable_update_checks = false`,
		`enable_auto_update = false`,
		`enable_auto_approve = false`,
		`enable_connectors = false`,
		`experimental_enable_model_catalog = false`,
		`outside_workdir = "ask"`,
		`default_agent = "ask"`,
		`applied_migrations = ["bash_read_only_defaults_v1"]`,
		"[tools.bash]\npermission = \"ask\"\nallowlist = []",
		"[tools.read_file]\npermission = \"ask\"",
		`api_base = "http://127.0.0.1:41871/v1"`,
		`api_style = "openai"`,
		`extra_headers = { Authorization = "Bearer s3cret\"x" }`,
		`display_name = "M \"one\""`,
		"max_context_length = 50000",
		"supports_images = true",
	} {
		if !strings.Contains(cfg, want) {
			t.Errorf("config lacks %s:\n%s", want, cfg)
		}
	}
	// no key variable (the secret is not in the environment), no Mistral provider
	for _, bad := range []string{"api_key_env_var", "api.mistral.ai", "MISTRAL"} {
		if strings.Contains(cfg, bad) {
			t.Errorf("config mentions %s", bad)
		}
	}
	// every top-level key comes before the first table: a TOML key after a table
	// header belongs to the table
	first := strings.Index(cfg, "\n[")
	for _, key := range []string{"active_model", "allowed_models", "enable_auto_approve", "outside_workdir", "default_agent", "applied_migrations"} {
		if i := strings.Index(cfg, "\n"+key+" ="); i < 0 || i > first {
			t.Errorf("%s is not before the first table", key)
		}
	}
	// an empty catalogue still writes a valid file, with the placeholder
	if c := vibeConfigTOML("127.0.0.1:1", "s", nil); !strings.Contains(c, placeholderModelID) {
		t.Errorf("no placeholder model:\n%s", c)
	}
}

func TestTomlStringEscapes(t *testing.T) {
	for in, want := range map[string]string{
		`plain`:   `"plain"`,
		"a\"b":    `"a\"b"`,
		`a\b`:     `"a\\b"`,
		"l1\nl2":  `"l1\nl2"`,
		"tab\t":   `"tab\t"`,
		"\x01":    `"\u0001"`,
		"héllo ✓": `"héllo ✓"`,
	} {
		if got := tomlString(in); got != want {
			t.Errorf("tomlString(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestWriteVibeEngineConfigAndReadItBack(t *testing.T) {
	home := filepath.Join(t.TempDir(), "vibe")
	creds := &credentials{ShimPort: 41871, ShimSecret: "sec"}
	models := []gatewayModel{{ID: "m1", ContextWindow: 64000}, {ID: "m2", ContextWindow: 30000}}
	if err := writeVibeEngineConfig(home, creds, models); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, "config.toml")
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("config.toml: %v %v (it holds the proxy secret: owner only)", fi, err)
	}
	got, err := readVibeModels(path)
	if err != nil || got["m1"] != 64000 || got["m2"] != 30000 || len(got) != 2 {
		t.Errorf("read back %v, %v", got, err)
	}
	// the trust list is empty, and put back if something filled it
	trust := filepath.Join(home, "trusted_folders.toml")
	if err := os.WriteFile(trust, []byte("trusted = [\"/repo\"]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeVibeEngineConfig(home, creds, models); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(trust); strings.Contains(string(b), "/repo") {
		t.Errorf("a trusted folder survived the rewrite: %s", b)
	}
	// no proxy recorded: refused with the way out
	if err := writeVibeEngineConfig(home, &credentials{}, models); err == nil || !strings.Contains(err.Error(), "re-run") {
		t.Errorf("err = %v", err)
	}
}

func TestVibeEnvDropsOtherProvidersAndSetsGalopinsHome(t *testing.T) {
	env := vibeEnv("/state/vibe", []string{
		"PATH=/bin", "HOME=/home/u", "MISTRAL_API_KEY=k", "VIBE_HOME=/home/u/.vibe", "VIBE_ACTIVE_MODEL=x",
		"OPENAI_API_KEY=k", "ANTHROPIC_API_KEY=k", "NO_PROXY=corp.example",
	})
	m := map[string]string{}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		m[k] = v
	}
	for _, gone := range []string{"MISTRAL_API_KEY", "VIBE_ACTIVE_MODEL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"} {
		if _, ok := m[gone]; ok {
			t.Errorf("%s was passed on", gone)
		}
	}
	if m["VIBE_HOME"] != "/state/vibe" {
		t.Errorf("VIBE_HOME = %q", m["VIBE_HOME"])
	}
	if m["PATH"] != "/bin" || m["HOME"] != "/home/u" {
		t.Errorf("ordinary variables lost: %v", m)
	}
	if !strings.Contains(m["NO_PROXY"], "corp.example") || !strings.Contains(m["NO_PROXY"], "127.0.0.1") {
		t.Errorf("NO_PROXY = %q: the loopback shim must be exempt and the user's entries kept", m["NO_PROXY"])
	}
	for _, kv := range env {
		if strings.Contains(kv, "sec") && strings.HasPrefix(kv, "GALOPIN") {
			t.Errorf("a secret in the environment: %s", kv)
		}
	}
}

func TestVibeEngineSelection(t *testing.T) {
	if !validEngine("vibe") || !validEngine("goose") || validEngine("vim") {
		t.Error("validEngine")
	}
	if got := resolveBackendKind("", false, &credentials{Engine: engineVibe}); got != backendVibe {
		t.Errorf("a vibe machine runs backend %q", got)
	}
	if got := resolveBackendKind("opencode", false, &credentials{Engine: engineVibe}); got != "opencode" {
		t.Errorf("an explicit --backend loses to the engine: %q", got)
	}
	if got := resolveBackendKind("", true, &credentials{Engine: engineVibe}); got != backendNone {
		t.Errorf("connectors-only: %q", got)
	}
	if !strings.HasSuffix(vibeHomeFor("/c/galopin/credentials.json"), "/galopin/vibe") {
		t.Errorf("vibe home = %s, want beside the credentials", vibeHomeFor("/c/galopin/credentials.json"))
	}
}

func TestVibeHiddenModesAreTheOnesThatSkipAsks(t *testing.T) {
	want := map[string]bool{"accept-edits": true, "auto-approve": true, "smart-approve": true}
	for _, m := range vibeHiddenModes {
		delete(want, m)
	}
	if len(want) != 0 {
		t.Errorf("not hidden: %v", want)
	}
	for _, m := range vibeHiddenModes {
		if m == vibeModeAsk {
			t.Errorf("the forced mode %q is hidden", m)
		}
	}
}

func TestVibeCommandNeedsTheInstalledCopy(t *testing.T) {
	t.Setenv(vibeEnvOverride, "")
	if _, err := vibeCommand(); err == nil || !strings.Contains(err.Error(), "--engine vibe") || !strings.Contains(err.Error(), packaging.VibeVersion()) {
		t.Errorf("err = %v", err)
	}
	t.Setenv(vibeEnvOverride, "/opt/vibe-acp")
	cmd, err := vibeCommand()
	if err != nil || len(cmd) != 1 || cmd[0] != "/opt/vibe-acp" {
		t.Errorf("override: %v %v", cmd, err)
	}
	if !strings.Contains(vibeOverrideWarning(), "not the verified pinned copy") {
		t.Error("the override is not announced")
	}
}

// The user's own ~/.vibe holds its API key and could trust a repository's config;
// like galopin's own Vibe home (under its state directory) it is protected.
func TestProtectedCoversTheUsersVibeAndGalopinsVibeHome(t *testing.T) {
	t.Setenv("VIBE_HOME", "/custom/vibe")
	pr := decide.NewProtected("/home/u", "/state/galopin", vibeHomeFor("/elsewhere/galopin/credentials.json"))
	for _, p := range []string{
		"/home/u/.vibe/.env", "/home/u/.vibe/config.toml", "/custom/vibe/trusted_folders.toml",
		"/elsewhere/galopin/vibe/config.toml",
	} {
		for _, key := range []string{"read", "edit"} {
			r := decide.Request{Key: key, Patterns: []string{p}, Workspace: "/work"}
			if _, ok := pr.OwnHit(r); !ok {
				t.Errorf("%s %s: not an own-file hit", key, p)
			}
		}
	}
	if _, ok := pr.SecretHit(decide.Request{Key: "read", Patterns: []string{"/home/u/.vibe/.env"}, Workspace: "/work"}); !ok {
		t.Error("~/.vibe/.env is not a secrets hit")
	}
	if _, ok := pr.SecretHit(decide.Request{Key: "bash", Patterns: []string{"cat ~/.vibe/.env"}, Workspace: "/work"}); !ok {
		t.Error("a command naming ~/.vibe/.env is not a secrets hit")
	}
}

// The pinned release and its lock agree: the lock pins the release by hash.
func TestVibePinFiles(t *testing.T) {
	v := packaging.VibeVersion()
	if v == "" || strings.Count(v, ".") != 2 {
		t.Fatalf("version %q", v)
	}
	lock, err := os.ReadFile("packaging/vibe-requirements.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(lock), "\nmistral-vibe=="+v+" ") && !strings.HasPrefix(string(lock), "mistral-vibe=="+v+" ") {
		t.Errorf("the lock does not pin mistral-vibe==%s", v)
	}
	// every requirement is hashed: nothing installs unchecked
	for _, block := range strings.Split(strings.TrimSpace(string(lock)), "\n") {
		if strings.Contains(block, "==") && !strings.HasSuffix(strings.TrimSpace(block), "\\") {
			t.Errorf("a requirement without hashes: %q", block)
		}
	}
	if strings.Contains(string(lock), "--index-url") || strings.Contains(string(lock), "git+") {
		t.Error("the lock names an index or a VCS source")
	}
}

func TestEnrollEngineVibeIsRecordedKeptAndWritesGalopinsOwnHome(t *testing.T) {
	srv := fakeEnrollServer(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("VIBE_HOME", "")
	creds := filepath.Join(t.TempDir(), "credentials.json")
	if err := runEnroll(enrollArgs(srv.URL, creds, "--engine", "vibe")); err != nil {
		t.Fatal(err)
	}
	rec, err := loadCredentials(creds)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Engine != engineVibe || rec.OpencodeConfig != "" {
		t.Errorf("engine=%q opencode_config=%q, want vibe and none", rec.Engine, rec.OpencodeConfig)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(creds), "opencode.json")); err == nil {
		t.Error("a vibe enroll wrote opencode.json")
	}
	vh := vibeHomeFor(creds)
	body, err := os.ReadFile(filepath.Join(vh, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "127.0.0.1:") || !strings.Contains(string(body), "enable_telemetry = false") {
		t.Errorf("config.toml:\n%s", body)
	}
	if _, err := os.Stat(filepath.Join(home, ".vibe")); err == nil {
		t.Error("the user's ~/.vibe was created")
	}
	// re-enroll keeps the engine; --engine goose switches
	if err := runEnroll(enrollArgs(srv.URL, creds)); err != nil {
		t.Fatal(err)
	}
	if rec, _ = loadCredentials(creds); rec.Engine != engineVibe {
		t.Errorf("re-enroll lost the engine: %q", rec.Engine)
	}
	if err := runEnroll(enrollArgs(srv.URL, creds, "--engine", "opencode")); err != nil {
		t.Fatal(err)
	}
	if rec, _ = loadCredentials(creds); rec.Engine != "" || rec.OpencodeConfig == "" {
		t.Errorf("switch back: engine=%q opencode_config=%q", rec.Engine, rec.OpencodeConfig)
	}
}

// Which models offer thinking efforts is galopin's record beside the config; the config
// itself lists no thinking levels (a listed "off" would send reasoning_effort "none").
func TestVibeReasoningModelsGetAnEffortsRecordNotConfigLevels(t *testing.T) {
	models := vibeModels([]gatewayModel{
		{ID: "think", SupportedFeatures: []string{"reasoning"}},
		{ID: "plain"},
	})
	if cfg := vibeConfigTOML("127.0.0.1:1", "s", models); strings.Contains(cfg, "thinking") {
		t.Errorf("config sets thinking:\n%s", cfg)
	}

	dir := t.TempDir()
	creds := &credentials{ShimPort: 1, ShimSecret: "s"}
	if err := writeVibeEngineConfig(dir, creds, []gatewayModel{{ID: "think", SupportedFeatures: []string{"reasoning"}}, {ID: "plain"}}); err != nil {
		t.Fatal(err)
	}
	got := readVibeEfforts(dir)
	if strings.Join(got["think"], ",") != "low,medium,high" || len(got["plain"]) != 0 {
		t.Errorf("efforts record = %v", got)
	}
	if len(readVibeEfforts(t.TempDir())) != 0 {
		t.Error("an absent record reads as efforts")
	}
}
