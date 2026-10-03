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

// drainEnvelopes collects live envelopes for sessionID until stop returns
// true for one of them, or timeout elapses. drainEvents (in
// opencode_it_test.go) drops the envelope, but this test asserts on
// RootSessionID, which only the envelope carries.
func drainEnvelopes(t *testing.T, mat *sessions.Materializer, sessionID string, timeout time.Duration, stop func(sessions.Envelope) bool) []sessions.Envelope {
	t.Helper()
	var out []sessions.Envelope
	deadline := time.After(timeout)
	for {
		select {
		case env := <-mat.Events():
			if env.SessionID != sessionID {
				continue
			}
			out = append(out, env)
			if stop(env) {
				return out
			}
		case <-deadline:
			t.Fatalf("timed out after %s waiting for the expected envelope; saw %d: %+v", timeout, len(out), out)
		}
	}
}

// waitForChild polls session.children until the parent reports at least
// one subagent, returning the first child's id.
func waitForChild(t *testing.T, ctx context.Context, ocBackend *backendopencode.Backend, workDir, parentID string, timeout time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		children, err := ocBackend.Children(ctx, workDir, parentID)
		if err == nil && len(children) > 0 {
			return children[0].ID
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for %s to spawn a child (last err: %v)", timeout, parentID, err)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// taskScenario scripts the mock so the parent's prompt gets a task tool
// call while the child's own prompt — which echoes the task text — gets a
// bash call needing a permission.
func taskScenario(childCommand string) map[string]any {
	return map[string]any{
		"toolCalls": []map[string]any{{
			"id": "call_task", "name": "task",
			"arguments": `{"description":"Inspect the repo","prompt":"List what is in the repo.","subagent_type":"general"}`,
		}},
		"content":      []string{"Parent done."},
		"chunkDelayMs": 10,
		"finishReason": "stop",
		"routes": []map[string]any{{
			"contains": "List what is in the repo.",
			"scenario": map[string]any{
				"toolCalls": []map[string]any{{
					"id": "call_child_bash", "name": "bash",
					"arguments": `{"command":` + mustJSON(childCommand) + `,"description":"write child file"}`,
				}},
				"content":      []string{"Child done."},
				"chunkDelayMs": 10,
				"finishReason": "stop",
			},
		}},
	}
}

func mustJSON(s string) string {
	body, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(body)
}

// TestSubagentPermissionIntegration proves the subagent contract against a
// real, pinned opencode: the parent spawns a task whose child needs a bash
// permission. Without auto-accept the child's ask is forwarded tagged with
// the parent as root, and answering it lets the child finish; with
// auto-accept on the parent the child is auto-replied with no ask at all.
// Gated behind GALOPIN_OPENCODE_IT=1 like TestOpencodeIntegration.
func TestSubagentPermissionIntegration(t *testing.T) {
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

	mat := sessions.New(ocBackend, policy.Default())
	if err := mat.Start(ctx); err != nil {
		t.Fatalf("subscribing to opencode: %v", err)
	}

	t.Run("child permission is forwarded rooted at the parent, and replying lets it finish", func(t *testing.T) {
		outFile := filepath.Join(workDir, "child-a.txt")
		_ = os.Remove(outFile)
		sess, err := ocBackend.CreateSession(ctx, workDir, backend.CreateSessionOptions{Title: "it-parent-a"})
		if err != nil {
			t.Fatalf("creating session: %v", err)
		}
		mat.Track(workDir, sess)

		setMockScenario(t, mockOrigin, taskScenario("echo hi-a > child-a.txt"))
		if err := ocBackend.Prompt(ctx, workDir, sess.ID, backend.Prompt{Text: "delegate this"}); err != nil {
			t.Fatalf("prompt: %v", err)
		}

		childID := waitForChild(t, ctx, ocBackend, workDir, sess.ID, 60*time.Second)
		var requestID string
		envs := drainEnvelopes(t, mat, childID, 60*time.Second, func(env sessions.Envelope) bool {
			if env.Event.Kind == backend.EventPermissionAsked && env.Event.Request != nil {
				requestID = env.Event.Request.ID
				return true
			}
			return false
		})
		if requestID == "" {
			t.Fatal("never saw permission.asked for the child's bash tool call")
		}
		for _, env := range envs {
			if env.Event.Kind == backend.EventPermissionAsked && env.RootSessionID != sess.ID {
				t.Errorf("ask envelope rootSessionId = %q, want the parent %q", env.RootSessionID, sess.ID)
			}
		}

		if err := ocBackend.ReplyPermission(ctx, workDir, childID, requestID, backend.DecisionOnce, ""); err != nil {
			t.Fatalf("replying to the child's permission: %v", err)
		}
		drainEnvelopes(t, mat, childID, 60*time.Second, func(env sessions.Envelope) bool {
			return env.Event.Kind == backend.EventStatus && env.Event.Status == backend.StatusIdle
		})
		body, err := os.ReadFile(outFile)
		if err != nil {
			t.Fatalf("the child's tool never actually ran: reading %s: %v", outFile, err)
		}
		if string(body) != "hi-a\n" {
			t.Errorf("child-a.txt = %q, want %q", body, "hi-a\n")
		}
	})
}
