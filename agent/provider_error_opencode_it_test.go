package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	backendopencode "galopin/internal/backend/opencode"
	"galopin/internal/policy"
	"galopin/internal/sessions"
)

// TestProviderErrorReachesTheEventIT drives a real opencode against a mock
// upstream that refuses the completion with 401, the way Cortecs answers an
// empty account ("AuthenticationError: Insufficient Balance.", HTTP 401):
// opencode must turn that into a session.error whose error object carries the
// provider's own message and the HTTP status (PROTOCOL.md §7), and galopin
// must forward both — on the live event and on the transcript's stored
// message — so Cerea can say why a turn died instead of a bare error name.
// Never the response body or headers: they can hold account details. Gated
// like the other real-opencode ITs (GALOPIN_OPENCODE_IT=1).
func TestProviderErrorReachesTheEventIT(t *testing.T) {
	if !itEnabled("GALOPIN_OPENCODE_IT", "PYSTINO_AGENT_OPENCODE_IT") {
		t.Skip("set GALOPIN_OPENCODE_IT=1 to run (spawns real opencode + a mock LLM)")
	}
	if _, err := exec.LookPath("opencode"); err != nil {
		t.Skipf("opencode not on PATH: %v", err)
	}

	mockOrigin := startMockLLM(t, itFreePort(t))
	setMockScenario(t, mockOrigin, map[string]any{
		"status": http.StatusUnauthorized,
		"body":   `{"error":{"message":"Insufficient Balance."}}`,
	})

	root := t.TempDir()
	homeDir := filepath.Join(root, "home")
	configDir := filepath.Join(root, "config")
	dataDir := filepath.Join(root, "data")
	cacheDir := filepath.Join(root, "cache")
	workDir := filepath.Join(root, "workdir")
	for _, d := range []string{homeDir, configDir, dataDir, cacheDir, workDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	opencodeConfig := map[string]any{
		"$schema": "https://opencode.ai/config.json",
		"provider": map[string]any{
			"pystino": map[string]any{
				"npm":  "@ai-sdk/openai-compatible",
				"name": "Pystino Mock",
				"options": map[string]any{
					"baseURL": mockOrigin + "/v1",
					"apiKey":  "test-secret",
				},
				"models": map[string]any{
					"mock-model": map[string]any{
						"name":  "Mock Model",
						"limit": map[string]any{"context": 100000, "output": 8000},
					},
				},
			},
		},
		"enabled_providers": []string{"pystino"},
		"permission":        map[string]any{"bash": "ask"},
	}
	configBody, err := json.MarshalIndent(opencodeConfig, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(root, "opencode.json")
	if err := os.WriteFile(configPath, configBody, 0o644); err != nil {
		t.Fatal(err)
	}

	ocBackend := backendopencode.New(backendopencode.Config{
		ConfigPath: configPath,
		Env: []string{
			"HOME=" + homeDir, "XDG_CONFIG_HOME=" + configDir, "XDG_DATA_HOME=" + dataDir,
			"XDG_CACHE_HOME=" + cacheDir, "TMPDIR=" + itTmpDir(t), "PATH=" + os.Getenv("PATH"),
		},
		TmpDir:         filepath.Join(itTmpDir(t), "opencode-tmp"),
		StartupTimeout: 90 * time.Second,
		Logf:           t.Logf,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := ocBackend.Start(ctx); err != nil {
		t.Fatalf("starting opencode: %v", err)
	}
	t.Cleanup(func() {
		if err := ocBackend.Stop(); err != nil {
			t.Logf("stopping opencode: %v", err)
		}
	})

	mat := sessions.New(ocBackend, policy.Default())
	if err := mat.Start(ctx); err != nil {
		t.Fatalf("subscribing to opencode: %v", err)
	}

	sess, err := ocBackend.CreateSession(ctx, workDir, backend.CreateSessionOptions{Title: "it"})
	if err != nil {
		t.Fatalf("creating session: %v", err)
	}
	mat.Track(workDir, sess)

	if err := ocBackend.Prompt(ctx, workDir, sess.ID, backend.Prompt{Text: "say hello"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	// Everything until idle, in order: the error event, the message that
	// stores it and the turn's end may arrive in any order, and which one
	// carries the provider's text is exactly what this test pins.
	var liveError *backend.Event
	events := drainEvents(t, mat, sess.ID, 60*time.Second, func(ev backend.Event) bool {
		if ev.Kind == backend.EventError && liveError == nil {
			liveError = &ev
			t.Logf("event order: %s message=%q code=%q", "error", ev.ErrorMessage, ev.ErrorCode)
			return false
		}
		if ev.Kind == backend.EventMessage {
			t.Logf("event order: message role=%s error=%q", ev.Message.Role, ev.Message.Error)
		}
		return isIdle(ev)
	})
	if liveError == nil {
		t.Fatalf("no error event in %d events: %+v", len(events), events)
	}
	if !strings.Contains(liveError.ErrorMessage, "Insufficient Balance") {
		t.Errorf("live error message = %q, want the provider's own text", liveError.ErrorMessage)
	}
	if liveError.ErrorCode != "401" {
		t.Errorf("live error code = %q, want 401", liveError.ErrorCode)
	}

	snapshot, err := ocBackend.Transcript(ctx, workDir, sess.ID)
	if err != nil {
		t.Fatalf("transcript: %v", err)
	}
	var lastAssistantError string
	for _, entry := range snapshot.Messages {
		if entry.Message.Role == "assistant" {
			lastAssistantError = entry.Message.Error
		}
	}
	if !strings.Contains(lastAssistantError, "Insufficient Balance") {
		t.Errorf("transcript error = %q, want the provider's own text", lastAssistantError)
	}
}
