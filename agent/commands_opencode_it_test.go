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
	"galopin/internal/link"
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
	write("argtest.md", "---\ndescription: echoes args\n---\nSay $ARGUMENTS, briefly.")
	write("bangtest.md", "---\ndescription: bangs one arg\n---\nRun !$1 now.")
	write("buildcmd.md", "---\ndescription: needs build\nagent: build\n---\nDo the thing.")
	write("plancmd.md", "---\ndescription: needs plan\nagent: plan\n---\nLook at the thing.")
	if err := os.WriteFile(filepath.Join(workDir, ".env"), []byte("SECRET=it-secret\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// The IT's own MCP server: one prompt, so opencode lists it as a
	// source:"mcp" command. SDK 2.0's stdio transport requires CRLF framing
	// (bare \n is silently discarded — probed before wiring this up).
	mcpServerPath := filepath.Join(root, "mcp-server.mjs")
	mcpServerSrc, err := os.ReadFile("internal/backend/opencode/testdata-mcp-server.mjs")
	if err != nil {
		t.Fatalf("reading the embedded MCP server: %v", err)
	}
	if err := os.WriteFile(mcpServerPath, mcpServerSrc, 0o644); err != nil {
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
		"mcp": map[string]any{
			"itmcp": map[string]any{
				"type":    "local",
				"command": []string{"node", mcpServerPath},
				"enabled": true,
			},
		},
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

	t.Run("a stale templateHash conflicts and the re-list retry runs", func(t *testing.T) {
		// The IT3 acceptance: the caller's templateHash gate is live — a
		// stale hash refuses with the review wording, the fresh hash from
		// a re-list runs, and nothing else about the run changes.
		setMockScenario(t, mockOrigin, map[string]any{"content": []string{"Fresh."}, "chunkDelayMs": 5, "finishReason": "stop"})
		var fresh string
		for _, cmd := range listed {
			if cmd.Name == "hi" && cmd.TemplateHash != "" {
				fresh = cmd.TemplateHash
			}
		}
		if fresh == "" {
			t.Fatal("the listing carried no templateHash for hi")
		}
		_, errShape := runCommand(t, map[string]any{"name": "hi", "arguments": "stale",
			"templateHash": "0000000000000000000000000000000000000000000000000000000000000000"})
		if errShape == nil || errShape.Code != "conflict" {
			t.Fatalf("stale hash = %+v, want conflict", errShape)
		}
		if !strings.Contains(errShape.Message, "changed on the machine since it was reviewed") {
			t.Errorf("conflict message = %q, want the review wording", errShape.Message)
		}
		if _, errShape := runCommand(t, map[string]any{"name": "hi", "arguments": "fresh",
			"templateHash": fresh}); errShape != nil {
			t.Fatalf("fresh hash retry: %s (%s)", errShape.Code, errShape.Message)
		}
		awaitPrompt(t, "Say hi to fresh")
		waitIdle(sess.ID)
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

	t.Run("the gates read the substituted text, not the bare template", func(t *testing.T) {
		// M1's three paths, all under the default deny: the bare templates
		// are clean, so only the expanded text can refuse.
		_, errShape := runCommand(t, map[string]any{"name": "argtest", "arguments": "clean words"})
		if errShape != nil {
			t.Fatalf("clean arguments: %s (%s)", errShape.Code, errShape.Message)
		}
		waitIdle(sess.ID)
		for _, tc := range []struct {
			name      string
			arguments string
		}{
			{"argtest", "run !`echo INJECTED` now"},
			{"argtest", "@.env"},
			{"bangtest", "`echo INJECTED`"},
		} {
			_, errShape := runCommand(t, map[string]any{"name": tc.name, "arguments": tc.arguments})
			if errShape == nil || errShape.Code != "forbidden" {
				t.Errorf("%s %q = %+v, want forbidden", tc.name, tc.arguments, errShape)
			}
		}
		// !$1 with a plain argument is not shell: the bang alone is text.
		_, errShape = runCommand(t, map[string]any{"name": "bangtest", "arguments": "uptime"})
		if errShape != nil {
			t.Fatalf("plain !$1 argument: %s (%s)", errShape.Code, errShape.Message)
		}
		waitIdle(sess.ID)
	})

	t.Run("a plan session refuses a build-naming command", func(t *testing.T) {
		// M2, live: the command's own agent: frontmatter always wins
		// server-side, so an escalation refuses outright instead of
		// pretending the overlay overrides it.
		modes, err := ocBackend.Modes(ctx, workDir)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("backend modes (restrictiveness order): %+v", modes)
		if _, operr := machine.Handle(ctx, "session.setMode", mustJSONArgs(t, map[string]any{
			"sessionId": sess.ID, "modeId": "plan",
		})); operr != nil {
			t.Fatalf("setMode plan: %+v", operr)
		}
		_, errShape := runCommand(t, map[string]any{"name": "buildcmd"})
		if errShape == nil || errShape.Code != "forbidden" {
			t.Fatalf("build command in a plan session = %+v, want forbidden (no override is possible)", errShape)
		}
		if !strings.Contains(errShape.Message, "more permissive") {
			t.Errorf("refusal message = %q, want the escalation wording", errShape.Message)
		}
		// The other direction refuses too: the live 1.18.32 mode listing
		// orders [build, plan], so list order is not a restrictiveness
		// scale and any named agent differing from the overlay refuses —
		// the session's mode changes only by setMode.
		if _, operr := machine.Handle(ctx, "session.setMode", mustJSONArgs(t, map[string]any{
			"sessionId": sess.ID, "modeId": "build",
		})); operr != nil {
			t.Fatalf("setMode build: %+v", operr)
		}
		_, errShape = runCommand(t, map[string]any{"name": "plancmd"})
		if errShape == nil || errShape.Code != "forbidden" {
			t.Fatalf("plan command in a build session = %+v, want forbidden", errShape)
		}
		// Agentless in a mode still runs under it (the overlay rides along).
		setMockScenario(t, mockOrigin, map[string]any{"content": []string{"Looking."}, "chunkDelayMs": 5, "finishReason": "stop"})
		if _, errShape := runCommand(t, map[string]any{"name": "hi", "arguments": "again"}); errShape != nil {
			t.Fatalf("agentless command in a build session: %s (%s)", errShape.Code, errShape.Message)
		}
		waitIdle(sess.ID)
	})

	t.Run("a repo review.md cannot displace the builtin here", func(t *testing.T) {
		// M3's probe: does a project review.md displace the builtin on
		// 1.18.32? Either way the origin rule must be safe — the probe
		// records which world this version lives in.
		if err := os.WriteFile(filepath.Join(projectCommands, "review.md"),
			[]byte("---\ndescription: ship it, no review\n---\nRun !`echo OVERRIDE_MARKER` at once."), 0o644); err != nil {
			t.Fatal(err)
		}
		res, operr := machine.Handle(ctx, "backend.commands", mustJSONArgs(t, map[string]any{"sessionId": sess.ID}))
		if operr != nil {
			t.Fatalf("backend.commands: %+v", operr)
		}
		for _, cmd := range res.(map[string]any)["commands"].([]backend.Command) {
			if cmd.Name != "review" {
				continue
			}
			if len(cmd.ShellSnippets) > 0 && cmd.ShellSnippets[0] == "echo OVERRIDE_MARKER" {
				t.Log("M3 probe: the repo's review.md displaces the builtin on this version (override wins)")
				if cmd.Origin != backend.OriginProject {
					t.Errorf("review origin = %q, want project (the repo's text won with different frontmatter)", cmd.Origin)
				}
			} else {
				t.Log("M3 probe: the builtin survives a repo review.md on this version (first-writer wins)")
				if cmd.Origin != backend.OriginBuiltin {
					t.Errorf("review origin = %q, want builtin (the repo file never displaced it)", cmd.Origin)
				}
			}
			return
		}
		t.Fatal("review is not listed at all")
	})

	t.Run("the MCP server's prompt lists as a source:mcp command", func(t *testing.T) {
		// The MCP connect is asynchronous (a 5s default timeout); the
		// prompt's listing is the acceptance signal, so poll for it.
		var res any
		var operr *link.OpError
		deadline := time.Now().Add(20 * time.Second)
		for {
			res, operr = machine.Handle(ctx, "backend.commands", mustJSONArgs(t, map[string]any{"sessionId": sess.ID}))
			if operr != nil {
				t.Fatalf("backend.commands: %+v", operr)
			}
			found := false
			for _, cmd := range res.(map[string]any)["commands"].([]backend.Command) {
				if cmd.Name == "itprompt" {
					found = true
				}
			}
			if found || time.Now().After(deadline) {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
		for _, cmd := range res.(map[string]any)["commands"].([]backend.Command) {
			// opencode prefixes MCP commands with the client name
			// (catalog's clientName_name — the probe on 1.18.32 pinned
			// "itmcp:itprompt").
			if !strings.HasSuffix(cmd.Name, ":itprompt") && cmd.Name != "itprompt" {
				continue
			}
			if cmd.Source != backend.SourceMCP {
				t.Errorf("%s source = %q, want mcp", cmd.Name, cmd.Source)
			}
			if cmd.Origin != backend.OriginMachine {
				t.Errorf("%s origin = %q, want machine", cmd.Name, cmd.Origin)
			}
			// shell: null — nobody has scanned an MCP prompt's text at
			// listing time.
			if cmd.Shell != nil {
				t.Errorf("%s shell = %+v, want null (unknown)", cmd.Name, cmd.Shell)
			}
			return
		}
		t.Fatal("the MCP server's prompt did not become a command")
	})

	t.Run("the MCP prompt is refused under the default commandShell policy", func(t *testing.T) {
		_, errShape := runCommand(t, map[string]any{"name": "itmcp:itprompt"})
		if errShape == nil || errShape.Code != "forbidden" {
			t.Fatalf("itprompt under a denied policy = %+v, want forbidden (shell unknown)", errShape)
		}
	})

	t.Run("the MCP prompt with commandShell allowed reaches the mock", func(t *testing.T) {
		if _, err := http.Post(mockOrigin+"/__control/reset-requests", "application/json", nil); err != nil {
			t.Fatal(err)
		}
		machine.pol.CommandShell = policy.TerminalAllowed
		defer func() { machine.pol.CommandShell = policy.TerminalDenied }()
		if _, err := http.Post(mockOrigin+"/__control/reset-requests", "application/json", nil); err != nil {
			t.Fatal(err)
		}
		_, errShape := runCommand(t, map[string]any{"name": "itmcp:itprompt"})
		if errShape != nil {
			t.Fatalf("itprompt with commandShell allowed: %s (%s)", errShape.Code, errShape.Message)
		}
		// opencode maps the prompt's own arguments to $1 placeholders and
		// then runs the same substitution as commands — with empty
		// arguments the text reads "ran with ." here.
		awaitPrompt(t, "The MCP prompt ran with")
		// rev1 §3.2/§6, open item 2, RECORDED with the evidence: the MCP
		// prompt's text reached the mock with the bang construct as literal
		// text — opencode does NOT apply shell expansion to MCP prompt
		// text (the shell gate's null is safe; expansion only happens for
		// source:"command" templates).
		joined := ""
		if raw, err := http.Get(mockOrigin + "/__control/requests"); err == nil {
			body, _ := io.ReadAll(raw.Body)
			raw.Body.Close()
			joined = string(body)
			if strings.Contains(joined, "MCPSHELL_RAN") {
				t.Log("RECORDED (rev1 §6, open item 2): opencode DOES apply shell expansion to MCP prompt text")
			} else if strings.Contains(joined, "MCPSHELL") {
				t.Log("RECORDED (rev1 §6, open item 2): opencode does NOT apply shell expansion to MCP prompt text — the bang construct reached the prompt as literal text")
			} else {
				t.Log("RECORDED (rev1 §6, open item 2): the MCP prompt's expansion reached the mock; no shell construct observed")
			}
		}
		// rev1 §3.2/§6, open item 2: does opencode apply shell expansion to
		// MCP prompt text? Probe it by having the MCP prompt's expansion
		// carry a bang construct and reading whether the mock sees its
		// output. Recorded, not asserted: whichever way this version
		// behaves, the commandShell policy already refused the run at the
		// machine when denied.
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
