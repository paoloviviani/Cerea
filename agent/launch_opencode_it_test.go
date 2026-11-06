package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	backendopencode "galopin/internal/backend/opencode"
	"galopin/internal/permrules"
)

// TestLaunchEnvDrivesRealOpencodeIT runs one prompt through a real opencode
// started with exactly the environment and arguments `galopin launch opencode`
// builds (LaunchEnv/LaunchArgs), against the mock LLM, with a provider key in
// the inherited environment that must not matter. Gated like the other
// real-opencode ITs (GALOPIN_OPENCODE_IT=1).
func TestLaunchEnvDrivesRealOpencodeIT(t *testing.T) {
	if !itEnabled("GALOPIN_OPENCODE_IT", "PYSTINO_AGENT_OPENCODE_IT") {
		t.Skip("set GALOPIN_OPENCODE_IT=1 to run (spawns real opencode + a mock LLM)")
	}
	bin, err := backendopencode.ResolveBin("opencode")
	if err != nil {
		t.Skipf("opencode not available: %v", err)
	}
	mockOrigin := startMockLLM(t, itFreePort(t))
	setMockScenario(t, mockOrigin, "plainText")

	root := t.TempDir()
	for _, d := range []string{"home", "config", "data", "cache", "work"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	conf := map[string]any{
		"provider": map[string]any{"pystino": map[string]any{
			"npm": "@ai-sdk/openai-compatible", "name": "Mock",
			"options": map[string]any{"baseURL": mockOrigin + "/v1", "apiKey": "test-secret"},
			"models":  map[string]any{"mock-model": map[string]any{"name": "Mock", "limit": map[string]any{"context": 100000, "output": 8000}}},
		}},
		"enabled_providers": []string{"pystino"},
	}
	body, _ := json.Marshal(conf)
	confPath := filepath.Join(root, "opencode.json")
	if err := os.WriteFile(confPath, body, 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := backendopencode.Config{
		Bin: bin, ConfigPath: confPath, TmpDir: filepath.Join(itTmpDir(t), "launch-tmp"),
		Env: []string{
			"HOME=" + filepath.Join(root, "home"), "XDG_CONFIG_HOME=" + filepath.Join(root, "config"),
			"XDG_DATA_HOME=" + filepath.Join(root, "data"), "XDG_CACHE_HOME=" + filepath.Join(root, "cache"),
			"PATH=" + os.Getenv("PATH"), "ANTHROPIC_API_KEY=sk-ant-must-not-matter",
		},
		Permissions: func() permrules.Layers { return permrules.Layers{} },
	}
	env, err := backendopencode.LaunchEnv(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, backendopencode.LaunchArgs(cfg, []string{"run", "-m", "pystino/mock-model", "say hello"})...)
	cmd.Env = env
	cmd.Dir = filepath.Join(root, "work")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("opencode run: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "Hello") {
		t.Fatalf("output lacks the mock's reply:\n%s", out)
	}
}
