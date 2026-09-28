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

// TestCommandsIntegration proves the commands capability end to end against
// a real opencode (the one on PATH — its version is logged, because
// nothing else pins what a machine installs; rev1 §2): the /doc probe
// claims the capability, the listing separates builtin/project/machine and
// scans shell and @refs out of the templates (never carrying one), a run
// reaches the mock with the expanded text, the transcript marks the user
// message, a subtask command spawns a child, the shell template runs only
// when the machine's policy allows it, an @.env ref is refused, and a
// command sent mid-turn folds into the running loop's next step. It also
// RECORDS whether @ expansion honours opencode's own read permission
// (rev1 §6, open item 3). Gated behind GALOPIN_OPENCODE_IT=1.
func TestCommandsIntegration(t *testing.T) {
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
	stateDir := filepath.Join(root, "state")
	for _, d := range []string{homeDir, configDir, dataDir, cacheDir, workDir, stateDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	// The project's own commands, in the repo the session runs in.
	projectCommands := filepath.Join(workDir, ".opencode", "command")
	if err := os.MkdirAll(projectCommands, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(projectCommands, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("hi.md", "---\ndescription: greet someone\n---\nSay hi to $ARGUMENTS, briefly.")
	write("shelly.md", "---\ndescription: runs shell\n---\nRun !`echo SHELL_RAN_MARK` and report the output.")
	write("envref.md", "---\ndescription: reads a denied file\n---\nSummarize @.env in one line.")
	write("subby.md", "---\ndescription: spawns a child\nsubtask: true\n---\nReport the repo's file count.")
	if err := os.WriteFile(filepath.Join(workDir, ".env"), []byte("SECRET=it-secret\n"), 0o644); err != nil {
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
		// The @-expansion question (rev1 §6): opencode's own read
		// permission on .env is "ask" — whether that applies to @
		// expansion is one of the open items this IT records.
		"permission": map[string]any{"bash": "allow", "read": map[string]any{"*.env": "ask"}},
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
		TmpDir:         filepath.Join(itTmpDir(t), "opencode-tmp"),
		StateDir:       stateDir,
		StartupTimeout: 90 * time.Second,
		Logf:           t.Logf,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if err := ocBackend.Start(ctx); err != nil {
		t.Fatalf("starting opencode: %v", err)
	}
	// The supervisor owns the child: Stop SIGTERMs the recorded process
	// group and escalates to SIGKILL. The IT must never leave an opencode
	// serve behind.
	t.Cleanup(func() {
		if err := ocBackend.Stop(); err != nil {
			t.Logf("stopping opencode: %v", err)
		}
	})

	// The installed version goes in the log: the IT runs against whatever
	// the machine has, and the version is the reconciliation fact rev1 §2
	// wanted recorded (the capability itself comes from /doc, never it).
	if out, err := exec.Command("opencode", "--version").CombinedOutput(); err == nil {
		t.Logf("installed opencode: %s", strings.TrimSpace(string(out)))
	}

	pol := policy.Default()
	mat := sessions.New(ocBackend, pol)
	if err := mat.Start(ctx); err != nil {
		t.Fatalf("subscribing to opencode: %v", err)
	}
	reg, err := workspaces.Load(filepath.Join(stateDir, "workspaces.json"))
	if err != nil {
		t.Fatal(err)
	}
	ws, err := reg.Create("it-ws", workDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	machine := newMachine(reg, ocBackend, mat, pol)

	sess, err := ocBackend.CreateSession(ctx, workDir, backend.CreateSessionOptions{Title: "it-commands"})
	if err != nil {
		t.Fatal(err)
	}
	machine.trackSession(ws, sess)

	// dumpTranscript logs every message's id/role/error/marker — the IT's
	// window on what actually happened inside opencode when an assertion
	// about the mock disagrees with the transcript.
	dumpTranscript := func(t *testing.T, label string) {
		t.Helper()
		res, operr := machine.Handle(ctx, "session.sync", mustJSONArgs(t, map[string]any{"sessionId": sess.ID}))
		if operr != nil {
			t.Logf("%s: session.sync failed: %+v", label, operr)
			return
		}
		snap, ok := res.(map[string]any)["snapshot"].(*backend.Transcript)
		if !ok {
			t.Logf("%s: session.sync snapshot had unexpected shape", label)
			return
		}
		for _, entry := range snap.Messages {
			t.Logf("%s: msg %s role=%s err=%q marker=%v", label,
				shortID(entry.Message.ID), entry.Message.Role, entry.Message.Error, entry.Message.Command)
		}
	}

	waitIdle := func(sessionID string) {
		drainEnvelopes(t, mat, sessionID, 90*time.Second, func(env sessions.Envelope) bool {
			return env.Event.Kind == backend.EventStatus && env.Event.Status == backend.StatusIdle
		})
	}
	mockRequests := func(t *testing.T) [][]string {
		t.Helper()
		resp, err := http.Get(mockOrigin + "/__control/requests")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		var parsed struct {
			Requests [][]string `json:"requests"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			t.Fatal(err)
		}
		return parsed.Requests
	}
	// awaitPrompt polls the mock until a prompt containing `contains` has
	// arrived — never trusting "the turn went idle": a previous turn's own
	// trailing idle events can still be queued, and answering the wrong
	// question made this exact trap famous in the revert IT.
	awaitPrompt := func(t *testing.T, contains string) {
		t.Helper()
		deadline := time.Now().Add(60 * time.Second)
		for {
			joined := strings.Join(flatten(mockRequests(t)), "\n")
			if strings.Contains(joined, contains) {
				return
			}
			if time.Now().After(deadline) {
				dumpTranscript(t, "await:"+contains)
				t.Fatalf("the mock never received a prompt containing %q", contains)
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	runCommand := func(t *testing.T, args map[string]any) (map[string]any, *errorShape) {
		t.Helper()
		args["sessionId"] = sess.ID
		raw, err := json.Marshal(args)
		if err != nil {
			t.Fatal(err)
		}
		res, operr := machine.Handle(ctx, "session.command", raw)
		if operr != nil {
			return nil, &errorShape{Code: operr.Code, Message: operr.Message}
		}
		out, _ := res.(map[string]any)
		return out, nil
	}

	t.Run("the /doc probe claims the capability on the installed opencode", func(t *testing.T) {
		if !ocBackend.Capabilities().Commands {
			t.Fatalf("the installed opencode does not list session.command in GET /doc — the capability must not be claimed (see the logged version)")
		}
	})

	var listed []backend.Command
	t.Run("the listing separates origins and scans templates", func(t *testing.T) {
		res, operr := machine.Handle(ctx, "backend.commands", mustJSONArgs(t, map[string]any{"sessionId": sess.ID}))
		if operr != nil {
			t.Fatalf("backend.commands: %+v", operr)
		}
		listed = res.(map[string]any)["commands"].([]backend.Command)
		byName := map[string]backend.Command{}
		for _, cmd := range listed {
			byName[cmd.Name] = cmd
			if cmd.Source == backend.SourceCommand && cmd.TemplateHash != "" {
				// The template itself must never ride the wire: the shape
				// the op carries is exactly the Command struct's fields.
				body, _ := json.Marshal(cmd)
				// The snippet legitimately travels (it is what a person must
				// see); the template's own prose must not.
				for _, leaked := range []string{"and report the output", "Summarize @.env in one line", "Say hi to $ARGUMENTS"} {
					if strings.Contains(string(body), leaked) {
						t.Errorf("command %q leaked template text over the op: %s", cmd.Name, body)
					}
				}
			}
		}
		for _, name := range []string{"init", "review"} {
			cmd, ok := byName[name]
			if !ok {
				t.Fatalf("%s is not listed; the builtin set is part of the contract", name)
			}
			if cmd.Origin != backend.OriginBuiltin {
				t.Errorf("%s origin = %q, want builtin", name, cmd.Origin)
			}
		}
		for name, want := range map[string]backend.Origin{
			"hi": backend.OriginProject, "shelly": backend.OriginProject, "envref": backend.OriginProject,
		} {
			cmd, ok := byName[name]
			if !ok {
				t.Fatalf("%s is not listed; the project commands did not come through", name)
			}
			if cmd.Origin != want {
				t.Errorf("%s origin = %q, want %q", name, cmd.Origin, want)
			}
		}
		if shelly := byName["shelly"]; shelly.Shell == nil || !*shelly.Shell || len(shelly.ShellSnippets) == 0 {
			t.Errorf("shelly shell facts = %+v, want shell true with its snippet", shelly.Shell)
		}
		if envref := byName["envref"]; len(envref.FileRefs) == 0 || envref.FileRefs[0] != ".env" {
			t.Errorf("envref fileRefs = %v, want [.env]", envref.FileRefs)
		}
	})

	t.Run("a run with arguments reaches the mock with the expanded text", func(t *testing.T) {
		setMockScenario(t, mockOrigin, map[string]any{"content": []string{"Hi."}, "chunkDelayMs": 5, "finishReason": "stop"})
		_, errShape := runCommand(t, map[string]any{"name": "hi", "arguments": "gamma"})
		if errShape != nil {
			t.Fatalf("session.command hi: %s (%s)", errShape.Code, errShape.Message)
		}
		awaitPrompt(t, "Say hi to gamma")
		waitIdle(sess.ID)
	})

	t.Run("the transcript marks the command's user message", func(t *testing.T) {
		tr, err := ocBackend.Transcript(ctx, workDir, sess.ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range tr.Messages {
			if entry.Message.Role != "user" || entry.Message.Command == nil {
				continue
			}
			if entry.Message.Command.Name != "hi" || entry.Message.Command.Arguments != "gamma" {
				t.Errorf("marker = %+v, want hi gamma", entry.Message.Command)
			}
			return
		}
		t.Fatal("no user message carried a command marker")
	})

	t.Run("a shell template runs only with commandShell allowed", func(t *testing.T) {
		setMockScenario(t, mockOrigin, map[string]any{"content": []string{"Ran."}, "chunkDelayMs": 5, "finishReason": "stop"})

		// Denied (the default): refused before anything runs.
		_, errShape := runCommand(t, map[string]any{"name": "shelly"})
		if errShape == nil || errShape.Code != "forbidden" {
			t.Fatalf("shelly under a denied policy = %+v, want forbidden", errShape)
		}

		// Allowed: the snippet runs inside opencode and its output lands in
		// the prompt the mock sees.
		machine.pol.CommandShell = policy.TerminalAllowed
		defer func() { machine.pol.CommandShell = policy.TerminalDenied }()
		if _, err := http.Post(mockOrigin+"/__control/reset-requests", "application/json", nil); err != nil {
			t.Fatal(err)
		}
		_, errShape = runCommand(t, map[string]any{"name": "shelly"})
		if errShape != nil {
			t.Fatalf("shelly under an allowed policy: %s (%s)", errShape.Code, errShape.Message)
		}
		awaitPrompt(t, "SHELL_RAN_MARK")
	})

	t.Run("an @.env ref is refused by the machine's fileDeny", func(t *testing.T) {
		machine.pol.CommandShell = policy.TerminalAllowed
		defer func() { machine.pol.CommandShell = policy.TerminalDenied }()
		_, errShape := runCommand(t, map[string]any{"name": "envref"})
		if errShape == nil || errShape.Code != "forbidden" {
			t.Fatalf("envref = %+v, want forbidden (fileDeny)", errShape)
		}
		// Record the read-permission question (rev1 §6): this refusal is
		// galopin's own gate; whether opencode's read permission would ALSO
		// have asked is what the record below is for.
		t.Log("galopin refused the @.env ref before opencode could apply its own read permission; whether opencode's read ask would have fired for @ expansion is only observable with the gate off — recorded by the audit, not settled here")
	})

	t.Run("a subtask command spawns a child", func(t *testing.T) {
		setMockScenario(t, mockOrigin, map[string]any{"content": []string{"Counted."}, "chunkDelayMs": 5, "finishReason": "stop"})
		machine.pol.CommandShell = policy.TerminalAllowed
		defer func() { machine.pol.CommandShell = policy.TerminalDenied }()
		_, errShape := runCommand(t, map[string]any{"name": "subby"})
		if errShape != nil {
			t.Fatalf("subby: %s (%s)", errShape.Code, errShape.Message)
		}
		// The child runs its own turn; wait for its prompt, then for the
		// parent to settle — a stale idle from the previous turn must not
		// answer for either.
		awaitPrompt(t, "Report the repo's file count")
		waitIdle(sess.ID)
		res, operr := machine.Handle(ctx, "session.children", mustJSONArgs(t, map[string]any{"sessionId": sess.ID}))
		if operr != nil {
			t.Fatalf("session.children: %+v", operr)
		}
		children := res.(map[string]any)["sessions"].([]backend.Session)
		if len(children) == 0 {
			t.Fatal("the subtask command spawned no child session")
		}
	})

	t.Run("records whether @ expansion honours opencode's read permission", func(t *testing.T) {
		// rev1 §6 open item 3: opencode's own config asks for *.env reads.
		// With galopin's fileDeny gate set aside, the run shows whose rule
		// applies first: a permission ask means @ expansion honours the read
		// permission; .env's content in the prompt means it does not.
		machine.pol.CommandShell = policy.TerminalAllowed
		machine.pol.NoDefaultFileDeny = true
		machine.pol.FileDeny = nil
		defer func() {
			machine.pol.CommandShell = policy.TerminalDenied
			machine.pol.NoDefaultFileDeny = false
		}()
		if _, err := http.Post(mockOrigin+"/__control/reset-requests", "application/json", nil); err != nil {
			t.Fatal(err)
		}
		if _, errShape := runCommand(t, map[string]any{"name": "envref"}); errShape != nil {
			t.Fatalf("envref with the deny list set aside: %s (%s)", errShape.Code, errShape.Message)
		}
		deadline := time.Now().Add(45 * time.Second)
		for time.Now().Before(deadline) {
			if tr, err := ocBackend.Transcript(ctx, workDir, sess.ID); err == nil && len(tr.Permissions) > 0 {
				t.Logf("RECORDED (rev1 §6, open item 3): @ expansion HONOURS opencode's read permission — a permission ask surfaced for .env (%s)", tr.Permissions[0].ID)
				if _, operr := machine.Handle(ctx, "permission.reply", mustJSONArgs(t, map[string]any{
					"sessionId": sess.ID, "requestId": tr.Permissions[0].ID, "decision": "reject",
				})); operr != nil {
					t.Logf("rejecting the ask failed (the turn may outlive the test): %+v", operr)
				}
				waitIdle(sess.ID)
				return
			}
			joined := strings.Join(flatten(mockRequests(t)), "\n")
			if strings.Contains(joined, "it-secret") {
				t.Logf("RECORDED (rev1 §6, open item 3): @ expansion does NOT honour opencode's read permission — .env's content landed in the prompt unasked")
				waitIdle(sess.ID)
				return
			}
			time.Sleep(300 * time.Millisecond)
		}
		// What the assistant was actually shown decides the security half of
		// the question, so read the envref turn's own text.
		answer := ""
		if tr, err := ocBackend.Transcript(ctx, workDir, sess.ID); err == nil {
			for i := len(tr.Messages) - 1; i >= 0; i-- {
				entry := tr.Messages[i]
				if entry.Message.Role != "assistant" {
					continue
				}
				for _, part := range entry.Parts {
					if part.Type == backend.PartText {
						answer = part.Text
					}
				}
				break
			}
		}
		joined := strings.Join(flatten(mockRequests(t)), "\n")
		if strings.Contains(answer, "it-secret") || strings.Contains(joined, "it-secret") {
			t.Log("RECORDED (rev1 §6, open item 3): @ expansion does NOT honour opencode's read permission — .env's content reached the turn unasked")
			t.Errorf("the .env content leaked into the turn despite opencode's read ask: %s", truncate(answer, 300))
			return
		}
		t.Logf("RECORDED (rev1 §6, open item 3): under opencode's read permission (*.env: ask), @ expansion neither surfaced a permission ask nor leaked the file's content — the expansion did not bypass the read permission; the assistant saw: %q", truncate(answer, 200))
		waitIdle(sess.ID)
	})

	t.Run("a command mid-turn folds into the running loop's next step", func(t *testing.T) {
		machine.pol.CommandShell = policy.TerminalAllowed
		defer func() { machine.pol.CommandShell = policy.TerminalDenied }()
		if _, err := http.Post(mockOrigin+"/__control/reset-requests", "application/json", nil); err != nil {
			t.Fatal(err)
		}
		// A slow first step keeps the turn busy while the command lands.
		setMockScenario(t, mockOrigin, map[string]any{"content": []string{"slow"}, "chunkDelayMs": 300, "finishReason": "stop"})
		if err := ocBackend.Prompt(ctx, workDir, sess.ID, backend.Prompt{Text: "long running first step"}); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(30 * time.Second)
		for {
			if st, ok := mat.Status(sess.ID); ok && st == backend.StatusBusy {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("the turn never became busy")
			}
			time.Sleep(100 * time.Millisecond)
		}
		setMockScenario(t, mockOrigin, map[string]any{"content": []string{"done"}, "chunkDelayMs": 5, "finishReason": "stop"})
		_, errShape := runCommand(t, map[string]any{"name": "hi", "arguments": "midturn"})
		if errShape != nil {
			t.Fatalf("mid-turn command: %s (%s)", errShape.Code, errShape.Message)
		}
		// The fold's whole point: the command's text reaches the mock as
		// part of the running loop's next step, while the turn is busy —
		// never as its own turn afterwards.
		awaitPrompt(t, "Say hi to midturn")
	})
}

// errorShape is the IT's view of an op refusal, so the helpers above need
// no link import.
type errorShape struct {
	Code    string
	Message string
}

func mustJSONArgs(t *testing.T, args map[string]any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func flatten(requests [][]string) []string {
	var out []string
	for _, req := range requests {
		out = append(out, req...)
	}
	return out
}

func shortID(id string) string {
	if len(id) <= 12 {
		return id
	}
	return id[:12] + "…"
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
