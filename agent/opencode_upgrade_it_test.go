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
	"galopin/internal/permrules"
	"galopin/internal/policy"
	"galopin/internal/sessions"
)

// An upgrade WITHIN opencode 2 keeps history, and galopin's own per-session
// state (mode, model, selector, exceptions) keeps applying to it. The session is
// made under an earlier 2.x binary (GALOPIN_OPENCODE_PREV_BIN), then the same
// data directory and overlay file are opened by the installed opencode. galopin
// keys its state on session ids and its own files, never on anything opencode
// versions (paths, the binary's version).
func TestOpencodeUpgradeWithin2KeepsHistoryAndGalopinState(t *testing.T) {
	if !itEnabled("GALOPIN_OPENCODE_IT", "PYSTINO_AGENT_OPENCODE_IT") {
		t.Skip("set GALOPIN_OPENCODE_IT=1 to run (spawns real opencode + a mock LLM)")
	}
	prev := os.Getenv("GALOPIN_OPENCODE_PREV_BIN")
	if prev == "" {
		t.Skip("set GALOPIN_OPENCODE_PREV_BIN to an earlier opencode 2.x binary to run the upgrade test")
	}
	newBin, err := exec.LookPath("opencode")
	if err != nil {
		t.Skipf("opencode not on PATH: %v", err)
	}
	for _, bin := range []string{prev, newBin} {
		if out, err := exec.Command(bin, "--version").CombinedOutput(); err == nil {
			t.Logf("%s: %s", bin, out)
		}
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
	cfg, _ := json.Marshal(map[string]any{
		"$schema": "https://opencode.ai/config.json",
		"provider": map[string]any{"pystino": map[string]any{
			"npm": "@ai-sdk/openai-compatible", "name": "Pystino Mock",
			"options": map[string]any{"baseURL": mockOrigin + "/v1", "apiKey": "test-secret"},
			"models":  map[string]any{"mock-model": map[string]any{"name": "Mock Model", "limit": map[string]any{"context": 100000, "output": 8000}}},
		}},
		"enabled_providers": []string{"pystino"},
	})
	configPath := filepath.Join(root, "opencode.json")
	if err := os.WriteFile(configPath, cfg, 0o600); err != nil {
		t.Fatal(err)
	}
	env := []string{
		"HOME=" + dirs["home"], "XDG_CONFIG_HOME=" + dirs["config"], "XDG_DATA_HOME=" + dirs["data"],
		"XDG_CACHE_HOME=" + dirs["cache"], "TMPDIR=" + itTmpDir(t), "PATH=" + os.Getenv("PATH"),
	}
	overlay := filepath.Join(dirs["state"], "opencode-overlay.json")
	start := func(bin string) (*backendopencode.Backend, context.Context, func()) {
		b := backendopencode.New(backendopencode.Config{
			Bin: bin, ConfigPath: configPath, Env: env, OverlayPath: overlay, BackgroundSubagents: true,
			Permissions: func() permrules.Layers { return permrules.Layers{} }, StartupTimeout: 90 * time.Second, Logf: t.Logf,
		})
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		if err := b.Start(ctx); err != nil {
			cancel()
			t.Fatalf("starting %s: %v", bin, err)
		}
		return b, ctx, func() { _ = b.Stop(); cancel() }
	}

	// --- the earlier release makes a session with history and galopin state
	b1, ctx1, stop1 := start(prev)
	mat := sessions.New(b1, policy.Default())
	if err := mat.Start(ctx1); err != nil {
		t.Fatal(err)
	}
	sess, err := b1.CreateSession(ctx1, dirs["work"], backend.CreateSessionOptions{Title: "it-upgrade", ModeID: "plan", ModelID: "pystino/mock-model"})
	if err != nil {
		t.Fatal(err)
	}
	mat.Track(dirs["work"], sess)
	if err := b1.SetPermissionMode(ctx1, dirs["work"], sess.ID, permrules.Allow); err != nil {
		t.Fatal(err)
	}
	ex, err := b1.AddException(ctx1, dirs["work"], sess.ID, permrules.Exception{Permission: "bash", Patterns: []string{"make test"}})
	if err != nil {
		t.Fatal(err)
	}
	setMockScenario(t, mockOrigin, map[string]any{"content": []string{"Before", " upgrade."}, "chunkDelayMs": 5, "finishReason": "stop"})
	if err := b1.Prompt(ctx1, dirs["work"], sess.ID, backend.Prompt{Text: "remember this"}); err != nil {
		t.Fatal(err)
	}
	drainEvents(t, mat, sess.ID, 60*time.Second, isIdle)
	stop1()

	// --- the installed release opens the same data directory
	b2, ctx2, stop2 := start(newBin)
	defer stop2()
	listed, err := b2.ListSessions(ctx2, dirs["work"])
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, s := range listed {
		found = found || s.ID == sess.ID
	}
	if !found {
		t.Fatalf("session %s is not listed after the upgrade: %+v", sess.ID, listed)
	}
	tr, err := b2.Transcript(ctx2, dirs["work"], sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	var user, assistant string
	for _, e := range tr.Messages {
		for _, p := range e.Parts {
			if p.Type == backend.PartText && !p.Synthetic && e.Message.Role == "user" {
				user += p.Text
			}
			if p.Type == backend.PartText && e.Message.Role == "assistant" {
				assistant += p.Text
			}
		}
	}
	if user != "remember this" || !strings.Contains(assistant, "Before upgrade.") {
		t.Errorf("history after the upgrade: user %q assistant %q", user, assistant)
	}
	got, err := b2.GetSession(ctx2, dirs["work"], sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ModeID != "plan" || got.ModelID != "pystino/mock-model" {
		t.Errorf("galopin's mode/model after the upgrade: %q / %q", got.ModeID, got.ModelID)
	}
	if mode := b2.PermissionMode(sess.ID); mode != permrules.Allow {
		t.Errorf("selector after the upgrade = %s, want allow", mode)
	}
	exs := b2.Exceptions(sess.ID)
	if len(exs) != 1 || exs[0].ID != ex.ID {
		t.Errorf("exceptions after the upgrade = %+v, want the one granted before", exs)
	}
	// and the session still runs on the new release
	mat2 := sessions.New(b2, policy.Default())
	if err := mat2.Start(ctx2); err != nil {
		t.Fatal(err)
	}
	mat2.Track(dirs["work"], got)
	setMockScenario(t, mockOrigin, map[string]any{"content": []string{"After."}, "chunkDelayMs": 5, "finishReason": "stop"})
	if err := b2.Prompt(ctx2, dirs["work"], sess.ID, backend.Prompt{Text: "and now?"}); err != nil {
		t.Fatalf("prompting the upgraded session: %v", err)
	}
	drainEvents(t, mat2, sess.ID, 60*time.Second, isIdle)
}
