package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	backendopencode "galopin/internal/backend/opencode"
)

// TestModelImagesIntegration proves the capability mapping against a real,
// pinned opencode: the resolved /config/providers entry carries a config
// model's image claim under `capabilities` (the boolean `attachment` beside
// the input modality `input.image`), and Models() maps it onto the wire's
// Model.images — true for a model the config claims, false for one it does
// not. The machine this ships on serves exactly this shape, which the
// pre-fix reader never looked at. Gated behind GALOPIN_OPENCODE_IT=1.
func TestModelImagesIntegration(t *testing.T) {
	if !itEnabled("GALOPIN_OPENCODE_IT", "PYSTINO_AGENT_OPENCODE_IT") {
		t.Skip("set GALOPIN_OPENCODE_IT=1 to run (spawns real opencode + a mock LLM)")
	}
	if _, err := exec.LookPath("opencode"); err != nil {
		t.Skipf("opencode not on PATH: %v", err)
	}

	mockOrigin := startMockLLM(t, itFreePort(t))
	root := t.TempDir()
	dirs := map[string]string{}
	for _, d := range []string{"home", "config", "data", "cache", "workdir", "state"} {
		dirs[d] = filepath.Join(root, d)
		if err := os.MkdirAll(dirs[d], 0o755); err != nil {
			t.Fatal(err)
		}
	}

	// The two shapes the gateway catalogue produces: a model the catalogue
	// says takes images (the same fields galopin's generator writes from
	// input_modalities) and one it says nothing about.
	configBody, _ := json.Marshal(map[string]any{
		"$schema": "https://opencode.ai/config.json",
		"provider": map[string]any{"pystino": map[string]any{
			"npm": "@ai-sdk/openai-compatible", "name": "Pystino Mock",
			"options": map[string]any{"baseURL": mockOrigin + "/v1", "apiKey": "test-secret"},
			"models": map[string]any{
				"mock-vision": map[string]any{
					"name": "Mock Vision", "limit": map[string]any{"context": 100000, "output": 8000},
					"attachment": true,
					"modalities": map[string]any{"input": []string{"image", "text"}},
				},
				"mock-text": map[string]any{
					"name": "Mock Text", "limit": map[string]any{"context": 100000, "output": 8000},
				},
			},
		}},
		"enabled_providers": []string{"pystino"},
	})
	configPath := filepath.Join(root, "opencode.json")
	if err := os.WriteFile(configPath, configBody, 0o644); err != nil {
		t.Fatal(err)
	}

	ocBackend := backendopencode.New(backendopencode.Config{
		ConfigPath: configPath,
		Env: []string{
			"HOME=" + dirs["home"], "XDG_CONFIG_HOME=" + dirs["config"], "XDG_DATA_HOME=" + dirs["data"],
			"XDG_CACHE_HOME=" + dirs["cache"], "TMPDIR=" + itTmpDir(t), "PATH=" + os.Getenv("PATH"),
		},
		TmpDir:         filepath.Join(itTmpDir(t), "opencode-tmp"),
		StateDir:       dirs["state"],
		StartupTimeout: 90 * time.Second,
		Logf:           t.Logf,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := ocBackend.Start(ctx); err != nil {
		t.Fatalf("starting opencode: %v", err)
	}
	t.Cleanup(func() { _ = ocBackend.Stop() })

	models, err := ocBackend.Models(ctx, "")
	if err != nil {
		t.Fatalf("Models: %v", err)
	}
	byID := map[string]bool{}
	for _, m := range models {
		byID[m.ID] = m.Images
	}
	if !byID["pystino/mock-vision"] {
		t.Errorf("mock-vision images = false, want true; models: %+v", byID)
	}
	if byID["pystino/mock-text"] {
		t.Errorf("mock-text images = true, want false; models: %+v", byID)
	}
}
