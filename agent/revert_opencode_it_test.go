package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"galopin/internal/backend"
	backendopencode "galopin/internal/backend/opencode"
	"galopin/internal/policy"
	"galopin/internal/sessions"
)

// userMessageIDs lists a transcript's user message ids, in order.
func userMessageIDs(tr backend.Transcript) []string {
	var ids []string
	for _, e := range tr.Messages {
		if e.Message.Role == "user" {
			ids = append(ids, e.Message.ID)
		}
	}
	return ids
}

// TestRevertIntegration proves session.revert against a real, pinned
// opencode: rolling back to the second prompt drops that turn from the
// transcript and restores the file it wrote; unrevert brings the turn back.
// Gated behind GALOPIN_OPENCODE_IT=1 like TestOpencodeIntegration.
func TestRevertIntegration(t *testing.T) {
	if !itEnabled("GALOPIN_OPENCODE_IT", "PYSTINO_AGENT_OPENCODE_IT") {
		t.Skip("set GALOPIN_OPENCODE_IT=1 to run (spawns real opencode + a mock LLM)")
	}
	if _, err := exec.LookPath("opencode"); err != nil {
		t.Skipf("opencode not on PATH: %v", err)
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not on PATH: %v", err)
	}

	mockPort := itFreePort(t)
	mockOrigin := startMockLLM(t, mockPort)

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
		"permission":        map[string]any{"bash": "allow"},
	}
	configBody, err := json.MarshalIndent(opencodeConfig, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(root, "opencode.json")
	if err := os.WriteFile(configPath, configBody, 0o644); err != nil {
		t.Fatal(err)
	}

	isolatedEnv := []string{
		"HOME=" + homeDir,
		"XDG_CONFIG_HOME=" + configDir,
		"XDG_DATA_HOME=" + dataDir,
		"XDG_CACHE_HOME=" + cacheDir,
		"TMPDIR=" + itTmpDir(t),
		"PATH=" + os.Getenv("PATH"),
	}

	ocBackend := backendopencode.New(backendopencode.Config{
		ConfigPath:     configPath,
		Env:            isolatedEnv,
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

	mat := sessions.New(ocBackend, policy.Policy{Permission: policy.Permission{Responders: policy.TerminalAllowed}})
	if err := mat.Start(ctx); err != nil {
		t.Fatalf("subscribing to opencode: %v", err)
	}

	_ = json.Marshal
	waitIdle := func(sessionID string) {
		drainEnvelopes(t, mat, sessionID, 60*time.Second, func(env sessions.Envelope) bool {
			return env.Event.Kind == backend.EventStatus && env.Event.Status == backend.StatusIdle
		})
	}

	// opencode snapshots a workspace's files through git: a revert restores
	// them in a repository (every real workspace is one, in practice).
	for _, args := range [][]string{{"init", "-q"}, {"-c", "user.email=it@example.org", "-c", "user.name=it", "commit", "-q", "--allow-empty", "-m", "init"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = workDir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v (%s)", args, err, out)
		}
	}

	sess, err := ocBackend.CreateSession(ctx, workDir, backend.CreateSessionOptions{Title: "it-revert"})
	if err != nil {
		t.Fatalf("creating session: %v", err)
	}
	mat.Track(workDir, sess)

	setMockScenario(t, mockOrigin, map[string]any{"content": []string{"One."}, "chunkDelayMs": 5, "finishReason": "stop"})
	if err := ocBackend.Prompt(ctx, workDir, sess.ID, backend.Prompt{Text: "first"}); err != nil {
		t.Fatalf("prompt 1: %v", err)
	}
	waitIdle(sess.ID)

	outFile := filepath.Join(workDir, "two.txt")
	setMockScenario(t, mockOrigin, map[string]any{
		"toolCalls": []map[string]any{{
			"id": "call_two", "name": "bash",
			"arguments": `{"command":` + mustJSON("echo two > "+outFile) + `,"description":"write two"}`,
		}},
		"content": []string{"Two."}, "chunkDelayMs": 5, "finishReason": "stop",
	})
	if err := ocBackend.Prompt(ctx, workDir, sess.ID, backend.Prompt{Text: "second"}); err != nil {
		t.Fatalf("prompt 2: %v", err)
	}
	// Poll for the effect rather than trusting the first idle status seen:
	// turn one's own trailing status events can still be queued.
	deadline := time.Now().Add(90 * time.Second)
	for {
		tr, err := ocBackend.Transcript(ctx, workDir, sess.ID)
		_, statErr := os.Stat(outFile)
		if err == nil && statErr == nil && len(userMessageIDs(tr)) == 2 && tr.Status != backend.StatusBusy {
			if st, ok := mat.Status(sess.ID); !ok || st == backend.StatusIdle {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("turn two never finished writing %s (stat err %v)", outFile, statErr)
		}
		time.Sleep(500 * time.Millisecond)
	}

	before, err := ocBackend.Transcript(ctx, workDir, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	users := userMessageIDs(before)
	if len(users) != 2 {
		t.Fatalf("user messages before revert = %d, want 2", len(users))
	}

	if err := ocBackend.Revert(ctx, workDir, sess.ID, users[1]); err != nil {
		t.Fatalf("revert: %v", err)
	}
	after, err := ocBackend.Transcript(ctx, workDir, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := userMessageIDs(after); len(got) != 1 || got[0] != users[0] {
		t.Fatalf("user messages after revert = %v, want only %s", got, users[0])
	}
	if len(after.Messages) >= len(before.Messages) {
		t.Errorf("transcript kept %d of %d messages after the revert", len(after.Messages), len(before.Messages))
	}
	if _, err := os.Stat(outFile); !os.IsNotExist(err) {
		t.Errorf("revertFiles: %s still exists after rolling back the turn that wrote it (stat err %v)", outFile, err)
	}

	if err := ocBackend.Unrevert(ctx, workDir, sess.ID); err != nil {
		t.Fatalf("unrevert: %v", err)
	}
	restored, err := ocBackend.Transcript(ctx, workDir, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := userMessageIDs(restored); len(got) != 2 {
		t.Errorf("user messages after unrevert = %v, want both back", got)
	}
}
