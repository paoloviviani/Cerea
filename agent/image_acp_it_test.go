package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"galopin/internal/attach"
	"galopin/internal/backend"
	backendacp "galopin/internal/backend/acp"
	"galopin/internal/policy"
	"galopin/internal/sessions"
)

// TestACPToolImagesIntegration proves the ACP half of I2 against a real
// `opencode acp`: a tool call whose result carries an image lists it by sha on
// the tool part, the bytes are served from memory, and after a galopin
// restart (a fresh Backend and store) the same request answers "no longer on
// the machine" — ACP cannot be asked for an image again. Gated behind
// GALOPIN_ACP_IT=1.
func TestACPToolImagesIntegration(t *testing.T) {
	if !itEnabled("GALOPIN_ACP_IT", "PYSTINO_AGENT_ACP_IT") {
		t.Skip("set GALOPIN_ACP_IT=1 to run (spawns real `opencode acp` + a mock LLM)")
	}
	if _, err := exec.LookPath("opencode"); err != nil {
		t.Skipf("opencode not on PATH: %v", err)
	}

	mockOrigin := startMockLLM(t, itFreePort(t))
	root := t.TempDir()
	dirs := map[string]string{}
	for _, d := range []string{"home", "config", "data", "cache", "workdir"} {
		dirs[d] = filepath.Join(root, d)
		if err := os.MkdirAll(dirs[d], 0o755); err != nil {
			t.Fatal(err)
		}
	}
	workDir := dirs["workdir"]
	shot := testPNG(t, 40, 30, 10)
	if err := os.WriteFile(filepath.Join(workDir, "a.png"), shot, 0o644); err != nil {
		t.Fatal(err)
	}
	configBody, _ := json.Marshal(map[string]any{
		"$schema": "https://opencode.ai/config.json",
		"provider": map[string]any{"pystino": map[string]any{
			"npm": "@ai-sdk/openai-compatible", "name": "Pystino Mock",
			"options": map[string]any{"baseURL": mockOrigin + "/v1", "apiKey": "test-secret"},
			"models": map[string]any{"mock-model": map[string]any{
				"name": "Mock Model", "limit": map[string]any{"context": 100000, "output": 8000},
			}},
		}},
		"enabled_providers": []string{"pystino"},
	})
	configPath := filepath.Join(root, "opencode.json")
	if err := os.WriteFile(configPath, configBody, 0o644); err != nil {
		t.Fatal(err)
	}
	env := []string{
		"HOME=" + dirs["home"], "XDG_CONFIG_HOME=" + dirs["config"], "XDG_DATA_HOME=" + dirs["data"],
		"XDG_CACHE_HOME=" + dirs["cache"], "TMPDIR=" + itTmpDir(t), "OPENCODE_CONFIG=" + configPath,
		"PATH=" + os.Getenv("PATH"),
	}
	newBackend := func() *backendacp.Backend {
		return backendacp.New(backendacp.Config{
			Command: []string{"opencode", "acp"}, Env: env, StartupTimeout: 90 * time.Second, Logf: t.Logf,
		})
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	acpBackend := newBackend()
	if err := acpBackend.Start(ctx); err != nil {
		t.Fatalf("starting acp backend: %v", err)
	}
	stopped := false
	t.Cleanup(func() {
		if !stopped {
			_ = acpBackend.Stop()
		}
	})
	if !acpBackend.Capabilities().ToolImages {
		t.Fatal("toolImages not advertised")
	}
	mat := sessions.New(acpBackend, policy.Default())
	if err := mat.Start(ctx); err != nil {
		t.Fatal(err)
	}
	sess, err := acpBackend.CreateSession(ctx, workDir, backend.CreateSessionOptions{Title: "it-images"})
	if err != nil {
		t.Fatal(err)
	}
	mat.Track(workDir, sess)

	setMockScenario(t, mockOrigin, map[string]any{
		"toolCalls": []map[string]any{{
			"id": "call_a", "name": "read", "arguments": `{"filePath":"` + filepath.Join(workDir, "a.png") + `"}`,
		}},
		"content": []string{"Looked."}, "finishReason": "stop",
	})
	if err := acpBackend.Prompt(ctx, workDir, sess.ID, backend.Prompt{Text: "look at a.png"}); err != nil {
		t.Fatal(err)
	}
	var atts []backend.ToolAttachment
	var wire []byte
	drainEvents(t, mat, sess.ID, 60*time.Second, func(ev backend.Event) bool {
		if ev.Kind == backend.EventPart && ev.Part != nil && ev.Part.Type == backend.PartTool && len(ev.Part.Attachments) > 0 {
			atts = ev.Part.Attachments
			wire, _ = json.Marshal(ev.Part)
		}
		return atts != nil && isIdle(ev)
	})
	if len(atts) != 1 || atts[0].Mime != "image/png" && atts[0].Mime != "image/jpeg" {
		t.Fatalf("attachments = %+v", atts)
	}
	if bytes.Contains(wire, []byte("data:")) || bytes.Contains(wire, []byte(`"data"`)) {
		t.Fatalf("image bytes rode the stream: %.300s", wire)
	}

	mime, data, err := acpBackend.Attachment(ctx, workDir, sess.ID, atts[0].SHA256)
	if err != nil || mime != atts[0].Mime || attach.Sum(data) != atts[0].SHA256 {
		t.Fatalf("Attachment: mime=%q err=%v", mime, err)
	}
	if atts[0].Mime == "image/png" && !bytes.Equal(data, shot) {
		t.Fatal("served PNG differs from the file")
	}

	// A galopin restart: a fresh Backend (and store) over the same agent state.
	if err := acpBackend.Stop(); err != nil {
		t.Logf("stop: %v", err)
	}
	stopped = true
	restarted := newBackend()
	if err := restarted.Start(ctx); err != nil {
		t.Fatalf("restart: %v", err)
	}
	t.Cleanup(func() { _ = restarted.Stop() })
	if _, _, err := restarted.Attachment(ctx, workDir, sess.ID, atts[0].SHA256); !errors.Is(err, backend.ErrAttachmentGone) {
		t.Fatalf("after a restart the image must be gone, got %v", err)
	}
}
