package main

import (
	"context"
	"encoding/json"
	"io"
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
	"galopin/internal/workspaces"
)

// A machine whose policy denies agent tools installs none: no tool files,
// agentTools:false, and a model that calls session_spawn anyway gets an
// error, never a session. Steering (a person's own mid-turn prompt) is the
// backend's and stays advertised. Gated behind GALOPIN_OPENCODE_IT=1.
func TestAgentToolsDeniedIntegration(t *testing.T) {
	if !itEnabled("GALOPIN_OPENCODE_IT", "PYSTINO_AGENT_OPENCODE_IT") {
		t.Skip("set GALOPIN_OPENCODE_IT=1 to run (spawns real opencode + a mock LLM)")
	}
	if _, err := exec.LookPath("opencode"); err != nil {
		t.Skipf("opencode not on PATH: %v", err)
	}
	mockOrigin := startMockLLM(t, itFreePort(t))
	root := t.TempDir()
	dirs := map[string]string{}
	for _, n := range []string{"home", "config", "data", "cache", "work", "state"} {
		dirs[n] = filepath.Join(root, n)
		if err := os.MkdirAll(dirs[n], 0o755); err != nil {
			t.Fatal(err)
		}
	}
	cfg := map[string]any{
		"$schema": "https://opencode.ai/config.json",
		"provider": map[string]any{"pystino": map[string]any{
			"npm": "@ai-sdk/openai-compatible", "name": "Pystino Mock",
			"options": map[string]any{"baseURL": mockOrigin + "/v1", "apiKey": "test-secret"},
			"models":  map[string]any{"mock-model": map[string]any{"name": "Mock Model", "limit": map[string]any{"context": 100000, "output": 8000}}},
		}},
		"enabled_providers": []string{"pystino"},
	}
	body, _ := json.MarshalIndent(cfg, "", "  ")
	configPath := filepath.Join(root, "opencode.json")
	if err := os.WriteFile(configPath, body, 0o644); err != nil {
		t.Fatal(err)
	}
	env := []string{
		"HOME=" + dirs["home"], "XDG_CONFIG_HOME=" + dirs["config"], "XDG_DATA_HOME=" + dirs["data"],
		"XDG_CACHE_HOME=" + dirs["cache"], "TMPDIR=" + itTmpDir(t), "PATH=" + os.Getenv("PATH"),
	}
	pol := policy.Default()
	pol.Permission.Responders = policy.TerminalAllowed
	pol.AgentTools = policy.TerminalDenied
	oc := backendopencode.New(backendopencode.Config{
		ConfigPath: configPath, Env: env, StateDir: dirs["state"],
		OverlayPath:    filepath.Join(dirs["state"], "opencode-overlay.json"),
		ToolsDir:       agentToolsDir(pol, dirs["state"]), // what run.go passes
		StartupTimeout: 90 * time.Second, Logf: t.Logf,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := oc.Start(ctx); err != nil {
		t.Fatalf("starting opencode: %v", err)
	}
	t.Cleanup(func() { _ = oc.Stop() })
	mat := sessions.New(oc, pol)
	if err := mat.Start(ctx); err != nil {
		t.Fatal(err)
	}
	reg, err := workspaces.Load(filepath.Join(dirs["state"], "workspaces.json"))
	if err != nil {
		t.Fatal(err)
	}
	ws, err := reg.Create("ws", dirs["work"], nil)
	if err != nil {
		t.Fatal(err)
	}
	mc := newMachine(reg, oc, mat, pol)
	hub := &itHub{t: t, mc: mc}
	go hub.run(mat)

	caps := oc.Capabilities()
	if caps.AgentTools {
		t.Errorf("a denied machine advertises agentTools: %+v", caps)
	}
	if !caps.Steer {
		t.Errorf("steer belongs to the backend, not the tools policy: %+v", caps)
	}
	if mc.agentTools != nil {
		t.Error("the machine installed the tools handler on a denied machine")
	}
	if _, err := os.Stat(filepath.Join(dirs["state"], "opencode-tools")); !os.IsNotExist(err) {
		t.Errorf("galopin wrote a tools directory on a denied machine: %v", err)
	}

	caller, err := oc.CreateSession(ctx, ws.Path, backend.CreateSessionOptions{Title: "denied-caller"})
	if err != nil {
		t.Fatal(err)
	}
	mc.trackSession(ws, caller)
	setMockScenario(t, mockOrigin, map[string]any{
		"content": []string{"ok"}, "chunkDelayMs": 5, "finishReason": "stop",
		"routes": []map[string]any{{"contains": "trigger-denied", "scenario": map[string]any{
			"toolCalls": []map[string]any{{"id": "call_denied", "name": "session_spawn",
				"arguments": mustJSON2(map[string]any{"title": "denied-child", "prompt": "x", "mode": "inherit"})}},
			"content": []string{"done"}, "chunkDelayMs": 5, "finishReason": "stop",
		}}},
	})
	mark := hub.mark()
	if err := oc.Prompt(ctx, ws.Path, caller.ID, backend.Prompt{Text: "trigger-denied"}); err != nil {
		t.Fatal(err)
	}
	hub.waitIdle(t, mark, caller.ID)
	for _, env := range hub.since(mark) {
		p := env.Event.Part
		if env.Event.Kind == backend.EventPart && p != nil && p.Tool == "session_spawn" && p.ToolStatus == backend.ToolCompleted {
			t.Errorf("session_spawn completed on a denied machine: %q", p.Output)
		}
		if env.Event.Kind == backend.EventPermissionAsked {
			t.Errorf("a denied machine raised an ask: %+v", env.Event.Request)
		}
	}
	list, err := oc.ListSessions(ctx, ws.Path)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range list {
		if strings.Contains(s.Title, "denied-child") {
			t.Errorf("a denied machine spawned a session: %+v", s)
		}
	}

	// Steering still works: a person's second prompt to a busy session folds.
	setMockScenario(t, mockOrigin, map[string]any{
		"content": []string{"a", "b", "c", "d", "e", "f", "g", "h"}, "chunkDelayMs": 300, "finishReason": "stop",
	})
	mark = hub.mark()
	if err := oc.Prompt(ctx, ws.Path, caller.ID, backend.Prompt{Text: "slow work"}); err != nil {
		t.Fatal(err)
	}
	hub.wait(t, mark, 30*time.Second, "busy", func(e sessions.Envelope) bool {
		return e.SessionID == caller.ID && e.Event.Kind == backend.EventStatus && e.Event.Status == backend.StatusBusy
	})
	if err := oc.Prompt(ctx, ws.Path, caller.ID, backend.Prompt{Text: "a mid-turn word from the person"}); err != nil {
		t.Fatalf("a prompt to a busy session was refused: %v", err)
	}
	hub.waitIdle(t, mark, caller.ID)
	if !strings.Contains(mockPromptsAt(t, mockOrigin), "a mid-turn word from the person") {
		t.Error("the mid-turn prompt never reached the model")
	}
}

func mockPromptsAt(t *testing.T, origin string) string {
	t.Helper()
	resp, err := http.Get(origin + "/__control/requests")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var parsed struct {
		Requests [][]string `json:"requests"`
	}
	_ = json.Unmarshal(raw, &parsed)
	return strings.Join(flatten(parsed.Requests), "\n")
}
