package opencode

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/internal/permrules"
)

func envMap(env []string) map[string]string {
	m := map[string]string{}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		m[k] = v
	}
	return m
}

func TestLaunchEnvStripsProviderCredentialsAndSelectors(t *testing.T) {
	cfg := Config{Env: []string{
		"PATH=/usr/bin", "HOME=/h",
		"ANTHROPIC_API_KEY=a", "ANTHROPIC_AUTH_TOKEN=a", "OPENAI_API_KEY=o", "OPENROUTER_API_KEY=r",
		"OPENAI_BASE_URL=http://elsewhere", "OPENCODE_PERMISSION={}", "OPENCODE_SERVER_PASSWORD=p",
		"GROQ_API_KEY=g", "AWS_BEARER_TOKEN_BEDROCK=b",
	}, Permissions: func() permrules.Layers { return permrules.Layers{} }}
	env, err := LaunchEnv(cfg)
	if err != nil {
		t.Fatal(err)
	}
	m := envMap(env)
	for _, k := range LaunchStripped() {
		if _, ok := m[k]; ok {
			t.Errorf("%s survived", k)
		}
	}
	if m["PATH"] != "/usr/bin" || m["HOME"] != "/h" {
		t.Errorf("ordinary variables lost: %v", m)
	}
	if _, ok := m["OPENCODE_SERVER_PASSWORD"]; ok {
		t.Error("server password reached an interactive opencode")
	}
}

// The launched env is the supervised one's, not a copy of it: same
// OPENCODE_CONFIG and OPENCODE_CONFIG_CONTENT, TMPDIR, project switch.
func TestLaunchEnvIsTheSupervisedEnvMinusTheStripped(t *testing.T) {
	dir := t.TempDir()
	conf := filepath.Join(dir, "opencode.json")
	if err := os.WriteFile(conf, []byte(`{"provider":{"pystino":{"models":{"m":{}}}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, project := range []bool{false, true} {
		cfg := Config{
			Env: []string{"PATH=/bin", "ANTHROPIC_API_KEY=a"}, ConfigPath: conf, TmpDir: filepath.Join(dir, "tmp"),
			ProjectConfig: project, Permissions: func() permrules.Layers { return permrules.Layers{} },
		}
		sup, err := childEnv(cfg, nil)
		if err != nil {
			t.Fatal(err)
		}
		got, err := LaunchEnv(cfg)
		if err != nil {
			t.Fatal(err)
		}
		a, b := envMap(sup), envMap(got)
		delete(a, "ANTHROPIC_API_KEY")
		if len(a) != len(b) {
			t.Fatalf("project=%v: supervised %v vs launch %v", project, a, b)
		}
		for k, v := range a {
			if b[k] != v {
				t.Errorf("project=%v: %s differs: %q vs %q", project, k, v, b[k])
			}
		}
		if b["OPENCODE_CONFIG"] != conf || b["TMPDIR"] != filepath.Join(dir, "tmp") {
			t.Errorf("config/tmp not set: %v", b)
		}
		if _, off := b["OPENCODE_DISABLE_PROJECT_CONFIG"]; off == project {
			t.Errorf("project=%v but OPENCODE_DISABLE_PROJECT_CONFIG present=%v", project, off)
		}
		if !strings.Contains(b["OPENCODE_CONFIG_CONTENT"], `"permission"`) {
			t.Errorf("no permission floor: %q", b["OPENCODE_CONFIG_CONTENT"])
		}
		if project && !strings.Contains(b["OPENCODE_CONFIG_CONTENT"], `"model":"pystino/m"`) {
			t.Errorf("project config loaded but the gateway model is not pinned: %q", b["OPENCODE_CONFIG_CONTENT"])
		}
	}
}

func TestLaunchArgs(t *testing.T) {
	if got := strings.Join(LaunchArgs(Config{}, []string{"run", "hi"}), " "); got != "--pure run hi" {
		t.Errorf("got %q", got)
	}
	if got := strings.Join(LaunchArgs(Config{ProjectConfig: true}, []string{"-c"}), " "); got != "-c" {
		t.Errorf("got %q", got)
	}
}
