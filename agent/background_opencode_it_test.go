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

	"galopin/internal/backend"
	backendopencode "galopin/internal/backend/opencode"
	"galopin/internal/policy"
	"galopin/internal/sessions"
)

// backgroundScenario scripts the mock so the parent's prompt gets a task
// tool call with background:true; the child itself just answers, so it
// finishes quickly and opencode injects the synthetic completion back into
// the parent.
func backgroundScenario() map[string]any {
	return map[string]any{
		"toolCalls": []map[string]any{{
			"id":        "call_task_bg",
			"name":      "task",
			"arguments": `{"description":"Survey the repo","prompt":"List what is in the repo.","subagent_type":"general","background":true}`,
		}},
		"content":      []string{"Parent launched background work."},
		"chunkDelayMs": 10,
		"finishReason": "stop",
		"routes": []map[string]any{{
			"contains": "List what is in the repo.",
			"scenario": map[string]any{
				"content":      []string{"Child done."},
				"chunkDelayMs": 10,
				"finishReason": "stop",
			},
		}},
	}
}

// backgroundHarness starts a real, pinned opencode against the mock LLM,
// returning the backend, materializer, work dir and a cancelable context.
// backgroundAllowed decides whether the child gets
// OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1 (the enrolled policy).
func backgroundHarness(t *testing.T, backgroundAllowed bool) (context.Context, *backendopencode.Backend, *sessions.Materializer, string) {
	t.Helper()
	if out, err := exec.Command("opencode", "--version").CombinedOutput(); err != nil {
		t.Fatalf("opencode --version: %v", err)
	} else if !strings.Contains(string(out), "1.18.32") {
		t.Fatalf("live background IT is pinned to opencode 1.18.32, got %q", strings.TrimSpace(string(out)))
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
		// An inherited flag must never decide: the backend strips it and
		// sets it only from BackgroundSubagents (fail-closed).
		"OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1",
	}

	ocBackend := backendopencode.New(backendopencode.Config{
		ConfigPath:          configPath,
		Env:                 isolatedEnv,
		BackgroundSubagents: backgroundAllowed,
		StartupTimeout:      90 * time.Second,
		Logf:                t.Logf,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	t.Cleanup(cancel)
	if err := ocBackend.Start(ctx); err != nil {
		t.Fatalf("starting opencode: %v", err)
	}
	t.Cleanup(func() {
		if err := ocBackend.Stop(); err != nil {
			t.Logf("stopping opencode: %v", err)
		}
	})

	mat := sessions.New(ocBackend, policy.Policy{AutoAccept: policy.AutoAcceptAllowed})
	if err := mat.Start(ctx); err != nil {
		t.Fatalf("subscribing to opencode: %v", err)
	}
	setMockScenario(t, mockOrigin, backgroundScenario())
	return ctx, ocBackend, mat, workDir
}

// TestBackgroundSubagentsIntegration proves the background contract against
// a real, pinned opencode (1.18.32): with the enrolled policy the task tool
// accepts background:true, the child lands in the same exposed tree, and
// the synthetic completion arrives on the parent. Without it the same call
// fails closed inside opencode. Gated behind GALOPIN_OPENCODE_IT=1 like
// TestSubagentPermissionIntegration.
func TestBackgroundSubagentsIntegration(t *testing.T) {
	if !itEnabled("GALOPIN_OPENCODE_IT", "PYSTINO_AGENT_OPENCODE_IT") {
		t.Skip("set GALOPIN_OPENCODE_IT=1 to run (spawns real opencode + a mock LLM)")
	}
	if _, err := exec.LookPath("opencode"); err != nil {
		t.Skipf("opencode not on PATH: %v", err)
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not on PATH: %v", err)
	}

	t.Run("allowed: running output, same-tree child, synthetic completion", func(t *testing.T) {
		ctx, ocBackend, mat, workDir := backgroundHarness(t, true)
		sess, err := ocBackend.CreateSession(ctx, workDir, backend.CreateSessionOptions{Title: "it-bg-parent"})
		if err != nil {
			t.Fatalf("creating session: %v", err)
		}
		mat.Track(workDir, sess)
		if err := ocBackend.Prompt(ctx, workDir, sess.ID, backend.Prompt{Text: "delegate this in the background"}); err != nil {
			t.Fatalf("prompt: %v", err)
		}

		// The running half: the task tool completes immediately with the
		// <task state="running"> output while the child keeps working.
		var childID string
		drainEvents(t, mat, sess.ID, 60*time.Second, func(ev backend.Event) bool {
			if ev.Kind != backend.EventPart || ev.Part == nil {
				return false
			}
			p := ev.Part
			if p.Type != backend.PartTool || p.Tool != "task" || p.ToolStatus != backend.ToolCompleted {
				return false
			}
			if !strings.Contains(p.Output, `state="running"`) || !strings.Contains(p.Output, "Background task started") {
				return false
			}
			childID = p.SubtaskSessionID
			return true
		})
		if childID == "" {
			t.Fatal("task tool output named no child session")
		}

		// Same exposed tree: the child is listed under its parent.
		childID2 := waitForChild(t, ctx, ocBackend, workDir, sess.ID, 60*time.Second)
		if childID2 != childID {
			t.Errorf("session.children child = %q, want the task's child %q", childID2, childID)
		}

		// The completion half: opencode injects the synthetic result back
		// into the parent once the child finishes.
		drainEvents(t, mat, sess.ID, 90*time.Second, func(ev backend.Event) bool {
			if ev.Kind != backend.EventPart || ev.Part == nil {
				return false
			}
			p := ev.Part
			return p.Type == backend.PartText && p.Synthetic &&
				strings.Contains(p.Text, "Background task completed") &&
				strings.Contains(p.Text, childID)
		})
	})

	t.Run("denied: background:true fails closed", func(t *testing.T) {
		ctx, ocBackend, mat, workDir := backgroundHarness(t, false)
		sess, err := ocBackend.CreateSession(ctx, workDir, backend.CreateSessionOptions{Title: "it-bg-denied"})
		if err != nil {
			t.Fatalf("creating session: %v", err)
		}
		mat.Track(workDir, sess)
		if err := ocBackend.Prompt(ctx, workDir, sess.ID, backend.Prompt{Text: "delegate this in the background"}); err != nil {
			t.Fatalf("prompt: %v", err)
		}

		drainEvents(t, mat, sess.ID, 60*time.Second, func(ev backend.Event) bool {
			if ev.Kind != backend.EventPart || ev.Part == nil {
				return false
			}
			p := ev.Part
			if p.Type != backend.PartTool || p.Tool != "task" || p.ToolStatus != backend.ToolFailed {
				return false
			}
			return strings.Contains(p.ToolError, "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS")
		})
	})
}
