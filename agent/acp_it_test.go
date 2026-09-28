package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	backendacp "galopin/internal/backend/acp"
	"galopin/internal/policy"
	"galopin/internal/sessions"
)

// TestACPIntegration proves the generic ACP adapter (internal/backend/acp)
// against a real `opencode acp` (opencode 1.18.31 on PATH) the same way
// opencode_it_test.go proves the opencode backend against `opencode
// serve`: a prompt streams text to idle, and a tool call's permission ask,
// replied "once", lets the tool run. It is the load-bearing evidence for
// PROTOCOL.md §2's claim that the backend interface is generic — the same
// mock LLM and the same opencode binary, spoken to over a different wire
// protocol, driving the identical internal/backend.Backend contract.
//
// Gated behind GALOPIN_ACP_IT=1 (alias: PYSTINO_AGENT_ACP_IT; needs opencode
// and node on PATH, plus the sibling thin-cerea checkout for the mock's
// script — see startMockLLM in opencode_it_test.go, the in-process
// internal/mockllm).
func TestACPIntegration(t *testing.T) {
	if !itEnabled("GALOPIN_ACP_IT", "PYSTINO_AGENT_ACP_IT") {
		t.Skip("set GALOPIN_ACP_IT=1 to run (spawns real `opencode acp` + a mock LLM)")
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
		"OPENCODE_CONFIG=" + configPath,
		"PATH=" + os.Getenv("PATH"),
	}

	acpBackend := backendacp.New(backendacp.Config{
		Command:        []string{"opencode", "acp"},
		Env:            isolatedEnv,
		StartupTimeout: 90 * time.Second,
		Logf:           t.Logf,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := acpBackend.Start(ctx); err != nil {
		t.Fatalf("starting acp backend: %v", err)
	}
	t.Cleanup(func() {
		if err := acpBackend.Stop(); err != nil {
			t.Logf("stopping acp backend: %v", err)
		}
	})

	if id := acpBackend.ID(); id != "acp:OpenCode" {
		t.Errorf("ID() = %q, want %q", id, "acp:OpenCode")
	}

	mat := sessions.New(acpBackend, policy.Default())
	if err := mat.Start(ctx); err != nil {
		t.Fatalf("subscribing to acp backend: %v", err)
	}

	sess, err := acpBackend.CreateSession(ctx, workDir, backend.CreateSessionOptions{Title: "it"})
	if err != nil {
		t.Fatalf("creating session: %v", err)
	}
	mat.Track(workDir, sess)

	t.Run("prompt streams text to idle", func(t *testing.T) {
		setMockScenario(t, mockOrigin, "plainText")
		if err := acpBackend.Prompt(ctx, workDir, sess.ID, backend.Prompt{Text: "say hello"}); err != nil {
			t.Fatalf("prompt: %v", err)
		}
		events := drainEvents(t, mat, sess.ID, 30*time.Second, isIdle)

		var sawPart bool
		var assembled string
		for _, ev := range events {
			switch ev.Kind {
			case backend.EventPart:
				if ev.Part != nil && ev.Part.Type == backend.PartText && ev.Part.Role == "assistant" {
					sawPart = true
					assembled = ev.Part.Text
				}
			case backend.EventDelta:
				assembled += ev.Delta
			}
		}
		if !sawPart {
			t.Error("never saw an assistant text part upsert")
		}
		if !strings.Contains(assembled, "Hello") {
			t.Errorf("assembled text = %q, want it to contain the mock's content", assembled)
		}
	})

	t.Run("tool call asks permission, reply once runs it", func(t *testing.T) {
		outFile := filepath.Join(workDir, "out.txt")
		_ = os.Remove(outFile)
		setMockScenario(t, mockOrigin, map[string]any{
			"toolCalls": []map[string]any{{
				"id": "call_1", "name": "bash",
				"arguments": `{"command":"echo hi > out.txt","description":"w"}`,
			}},
			"content":      []string{"Done"},
			"finishReason": "stop",
		})
		if err := acpBackend.Prompt(ctx, workDir, sess.ID, backend.Prompt{Text: "run the command"}); err != nil {
			t.Fatalf("prompt: %v", err)
		}

		var requestID string
		drainEvents(t, mat, sess.ID, 30*time.Second, func(ev backend.Event) bool {
			if ev.Kind == backend.EventPermissionAsked && ev.Request != nil {
				requestID = ev.Request.ID
				return true
			}
			return false
		})
		if requestID == "" {
			t.Fatal("never saw permission.asked for the bash tool call")
		}

		if err := acpBackend.ReplyPermission(ctx, workDir, sess.ID, requestID, backend.DecisionOnce, ""); err != nil {
			t.Fatalf("replying to permission: %v", err)
		}

		events := drainEvents(t, mat, sess.ID, 30*time.Second, isIdle)
		var sawCompletedTool bool
		for _, ev := range events {
			if ev.Kind == backend.EventPart && ev.Part != nil && ev.Part.Type == backend.PartTool && ev.Part.ToolStatus == backend.ToolCompleted {
				sawCompletedTool = true
			}
		}
		if !sawCompletedTool {
			t.Error("never saw the tool part reach status completed")
		}
		body, err := os.ReadFile(outFile)
		if err != nil {
			t.Fatalf("the tool never actually ran: reading %s: %v", outFile, err)
		}
		if strings.TrimSpace(string(body)) != "hi" {
			t.Errorf("out.txt = %q, want %q", body, "hi\n")
		}
	})
}

// itFreePort, startMockLLM, setMockScenario, drainEvents and isIdle are
// shared with opencode_it_test.go (same package, same file's helpers) —
// this test intentionally drives the identical mock LLM setup through a
// different backend to prove the interface is generic, not to duplicate
// test infrastructure.

// TestAcpCommandsIntegration is the commands capability's ACP variant
// (PROTOCOL.md §6 backend.commands / session.command) against real
// `opencode acp`: the agent's available_commands_update lists the
// session's commands, a run is the invocation as an ordinary prompt, the
// marker rides on the message galopin synthesizes, and a busy session
// refuses. What the LLM actually receives — the literal "/name args" or
// opencode's own expansion — is recorded, because the two ACP paths are
// the open question the 2026-09-26 plan left. Gated like the ACP IT.
func TestAcpCommandsIntegration(t *testing.T) {
	if !itEnabled("GALOPIN_ACP_IT", "PYSTINO_AGENT_ACP_IT") {
		t.Skip("set GALOPIN_ACP_IT=1 to run (spawns real `opencode acp` + a mock LLM)")
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
	commandDir := filepath.Join(workDir, ".opencode", "command")
	if err := os.MkdirAll(commandDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(commandDir, "greet.md"),
		[]byte("---\ndescription: greet someone\n---\nSay hi to $ARGUMENTS, briefly."), 0o644); err != nil {
		t.Fatal(err)
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
		"OPENCODE_CONFIG=" + configPath,
		"PATH=" + os.Getenv("PATH"),
	}

	acpBackend := backendacp.New(backendacp.Config{
		Command:        []string{"opencode", "acp"},
		Env:            isolatedEnv,
		StartupTimeout: 90 * time.Second,
		Logf:           t.Logf,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := acpBackend.Start(ctx); err != nil {
		t.Fatalf("starting acp backend: %v", err)
	}
	t.Cleanup(func() {
		if err := acpBackend.Stop(); err != nil {
			t.Logf("stopping acp backend: %v", err)
		}
	})

	mat := sessions.New(acpBackend, policy.Default())
	if err := mat.Start(ctx); err != nil {
		t.Fatalf("subscribing to acp backend: %v", err)
	}

	sess, err := acpBackend.CreateSession(ctx, workDir, backend.CreateSessionOptions{Title: "it-commands"})
	if err != nil {
		t.Fatalf("creating session: %v", err)
	}
	mat.Track(workDir, sess)

	// The agent announces its commands when the session comes up; the list
	// is the capability's whole answer on this backend.
	var listed []backend.Command
	deadline := time.Now().Add(30 * time.Second)
	for {
		listed, err = acpBackend.ListCommands(ctx, workDir, sess.ID)
		if err != nil {
			t.Fatalf("listing: %v", err)
		}
		if len(listed) > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Logf("available_commands_update listed %d commands (greet among them: %v)", len(listed), containsCommand(listed, "greet"))
	if !containsCommand(listed, "greet") {
		t.Fatalf("the session's command list never named the project command greet; got %d commands", len(listed))
	}

	// The run: an ordinary prompt whose text is the invocation.
	setMockScenario(t, mockOrigin, map[string]any{"content": []string{"Hi."}, "chunkDelayMs": 5, "finishReason": "stop"})
	if _, err := http.Post(mockOrigin+"/__control/reset-requests", "application/json", nil); err != nil {
		t.Fatal(err)
	}
	if err := acpBackend.RunCommand(ctx, workDir, sess.ID, backend.CommandRun{
		Name: "greet", Arguments: "gamma", ClientMessageID: "cm-acp-1",
	}); err != nil {
		t.Fatalf("RunCommand: %v", err)
	}
	events := drainEvents(t, mat, sess.ID, 60*time.Second, isIdle)
	var marker *backend.MessageCommand
	var clientID string
	for _, ev := range events {
		if ev.Kind == backend.EventMessage && ev.Message != nil && ev.Message.Role == "user" && ev.Message.Command != nil {
			marker = ev.Message.Command
			clientID = ev.Message.ClientMessageID
		}
	}
	if marker == nil || marker.Name != "greet" || marker.Arguments != "gamma" {
		t.Fatalf("the user message's command marker = %+v, want greet gamma", marker)
	}
	if clientID != "cm-acp-1" {
		t.Errorf("ClientMessageID = %q, want cm-acp-1 carried through the prompt path", clientID)
	}

	// What reached the LLM: opencode's ACP may expand the command itself or
	// pass the invocation through as text — either is recorded, neither is
	// assumed.
	body, err := http.Get(mockOrigin + "/__control/requests")
	if err != nil {
		t.Fatal(err)
	}
	defer body.Body.Close()
	raw, err := io.ReadAll(body.Body)
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Requests [][]string `json:"requests"`
	}
	_ = json.Unmarshal(raw, &parsed)
	joined := ""
	for _, req := range parsed.Requests {
		joined += strings.Join(req, "\n") + "\n"
	}
	switch {
	case strings.Contains(joined, "Say hi to gamma"):
		t.Log("RECORDED: opencode acp expands the command itself; the mock received the expanded template")
	case strings.Contains(joined, "/greet gamma"):
		t.Log("RECORDED: opencode acp passes the invocation through as text; the mock received \"/greet gamma\" verbatim")
	default:
		t.Errorf("the mock's prompts never named the command, expanded or literal; saw:\n%s", truncate(joined, 1200))
	}

	// A busy session refuses rather than clobbering the turn ids.
	setMockScenario(t, mockOrigin, map[string]any{"content": []string{"slow"}, "chunkDelayMs": 300, "finishReason": "stop"})
	if err := acpBackend.Prompt(ctx, workDir, sess.ID, backend.Prompt{Text: "hold the turn"}); err != nil {
		t.Fatal(err)
	}
	if err := acpBackend.RunCommand(ctx, workDir, sess.ID, backend.CommandRun{Name: "greet"}); !errors.Is(err, backend.ErrSessionBusy) {
		t.Fatalf("RunCommand while busy = %v, want ErrSessionBusy", err)
	}
	// Let the held turn finish so the supervisor's shutdown is clean.
	setMockScenario(t, mockOrigin, map[string]any{"content": []string{"done"}, "chunkDelayMs": 5, "finishReason": "stop"})
	drainEvents(t, mat, sess.ID, 30*time.Second, isIdle)
}

func containsCommand(commands []backend.Command, name string) bool {
	for _, cmd := range commands {
		if cmd.Name == name {
			return true
		}
	}
	return false
}
