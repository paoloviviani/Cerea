package main

import (
	"context"
	"encoding/json"
	"errors"
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

// A machine whose policy lets no session auto-accept (permission.responders
// denied) refuses to switch one on, and — with no rule for the two
// coordination tools — every send and every spawn raises a card and nothing is
// audited "allow". Gated behind GALOPIN_OPENCODE_IT=1.
func TestAgentToolsAutoAcceptDeniedIntegration(t *testing.T) {
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
	pol := policy.Default() // responders: denied
	oc := backendopencode.New(backendopencode.Config{
		ConfigPath: configPath, Env: env, StateDir: dirs["state"],
		OverlayPath:    filepath.Join(dirs["state"], "opencode-overlay.json"),
		ToolsDir:       filepath.Join(dirs["state"], "opencode-tools"),
		StartupTimeout: 90 * time.Second, Logf: t.Logf,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
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
	audit, err := newAuditLogger(dirs["state"])
	if err != nil {
		t.Fatal(err)
	}
	mc.AttachAudit(audit)
	if mc.agentTools == nil {
		t.Fatal("the agent tools were not installed")
	}
	hub := &itHub{t: t, mc: mc}
	go hub.run(mat)
	hub.setApprove(func(*backend.PermissionRequest) string { return "once" })

	newSession := func(title string) backend.Session {
		s, err := oc.CreateSession(ctx, ws.Path, backend.CreateSessionOptions{Title: title, ModeID: "build"})
		if err != nil {
			t.Fatal(err)
		}
		mc.trackSession(ws, s)
		return s
	}
	a, b, c := newSession("it-deny-a"), newSession("it-deny-b"), newSession("it-deny-c")
	if err := mat.SetAutoAccept(a.ID, true); !errors.Is(err, sessions.ErrAutoAcceptForbidden) {
		t.Fatalf("SetAutoAccept on a denying machine = %v, want ErrAutoAcceptForbidden", err)
	}
	if mat.AutoAccept(a.ID) {
		t.Fatal("auto-accept is in effect on a machine that denies it")
	}
	setMockScenario(t, mockOrigin, map[string]any{"content": []string{"ok"}, "chunkDelayMs": 5, "finishReason": "stop", "routes": []map[string]any{
		{"contains": "trigger-deny-send", "scenario": map[string]any{
			"toolCalls": []map[string]any{{"id": "call_deny_send", "name": "session_send", "arguments": mustJSON2(map[string]any{"target": b.ID, "text": "deny hello"})}},
			"content":   []string{"done"}, "chunkDelayMs": 5, "finishReason": "stop",
		}},
		{"contains": "trigger-deny-spawn", "scenario": map[string]any{
			"toolCalls": []map[string]any{{"id": "call_deny_spawn", "name": "session_spawn", "arguments": mustJSON2(map[string]any{"title": "it-deny-child", "prompt": "hi", "mode": "inherit"})}},
			"content":   []string{"done"}, "chunkDelayMs": 5, "finishReason": "stop",
		}},
	}})
	// One session per call: the mock takes the first route matching anywhere
	// in a session's history, so a reused session would replay its first trigger.
	for _, k := range []struct {
		from             backend.Session
		trig, tool, want string
	}{
		{a, "trigger-deny-send", "session_send", "{}"},
		{c, "trigger-deny-spawn", "session_spawn", ""},
	} {
		mark := hub.mark()
		if err := oc.Prompt(ctx, ws.Path, k.from.ID, backend.Prompt{Text: k.trig}); err != nil {
			t.Fatal(err)
		}
		part := hub.toolDone(t, mark, k.from.ID, k.tool)
		if part.ToolStatus != backend.ToolCompleted {
			t.Fatalf("%s = %s / %q / %q", k.tool, part.ToolStatus, part.Output, part.ToolError)
		}
		if asks := hub.asks(mark, k.from.ID); len(asks) != 1 || asks[0].Tool != k.tool {
			t.Errorf("%s on a denying machine: want exactly one card, got %+v", k.tool, asks)
		}
		if k.want != "" && part.Output != k.want {
			t.Errorf("%s result = %q, want %q", k.tool, part.Output, k.want)
		}
		hub.waitIdle(t, mark, k.from.ID)
	}
	raw, _ := os.ReadFile(filepath.Join(dirs["state"], "audit.log"))
	if len(raw) == 0 {
		t.Fatal("audit log is empty")
	}
	if strings.Contains(string(raw), `"decision":"allow"`) {
		t.Errorf("an auto decision was audited on a machine that denies auto-accept:\n%s", raw)
	}
}
