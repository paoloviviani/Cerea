package main

import (
	"context"
	"encoding/json"
	"testing"

	"galopin/internal/backend"
	backendopencode "galopin/internal/backend/opencode"
	"galopin/internal/files"
)

// commandingBackend is fakeBackend plus the commands capability: a fixed
// list it answers ListCommands with, and a run recorder.
type commandingBackend struct {
	fakeBackend
	commands []backend.Command
	runs     []backend.CommandRun
	runErr   error
}

func (c *commandingBackend) Capabilities() backend.Capabilities {
	return backend.Capabilities{Commands: true}
}

func (c *commandingBackend) ListCommands(_ context.Context, _, _ string) ([]backend.Command, error) {
	return c.commands, nil
}

func (c *commandingBackend) RunCommand(_ context.Context, _, _ string, run backend.CommandRun) error {
	if c.runErr != nil {
		return c.runErr
	}
	c.runs = append(c.runs, run)
	return nil
}

// GetSession answers a session with no overlay mode — the escalation gate
// reads it, and the plain commandingBackend says nothing about modes.
func (c *commandingBackend) GetSession(context.Context, string, string) (backend.Session, error) {
	return backend.Session{ID: "s1"}, nil
}

// Modes answers nothing: no order is known, so the escalation gate's
// fallback applies (any named agent escalates while an overlay mode is set).
func (c *commandingBackend) Modes(context.Context, string) ([]backend.Mode, error) {
	return nil, nil
}

// resolvingBackend is commandingBackend plus the run path's expansion:
// templates ride along so the gates read the substituted text, the way the
// opencode backend's ResolveCommand answers.
type resolvingBackend struct {
	commandingBackend
	templates map[string]string
}

func (r *resolvingBackend) ResolveCommand(_ context.Context, _, _ string, name, arguments string) (backend.ResolvedCommand, error) {
	for _, cmd := range r.commands {
		if cmd.Name == name {
			template, ok := r.templates[name]
			if !ok {
				template = ""
			}
			return backend.ResolvedCommand{Command: cmd, Expanded: backendopencode.ExpandArguments(template, arguments)}, nil
		}
	}
	return backend.ResolvedCommand{}, backend.ErrCommandNotFound
}

// modeListing makes the escalation gate's order explicit, and reports the
// session's mode the way the real backend would.
type commandingWithModes struct {
	commandingBackend
	sessionMode string
}

func (c *commandingWithModes) Modes(context.Context, string) ([]backend.Mode, error) {
	// Gateway models throughout: the escalation tests are about the agent
	// choice, and the model gate must not fire on them.
	return []backend.Mode{
		{ID: "plan", Label: "Plan", Model: "pystino/mock"},
		{ID: "build", Label: "Build", Model: "pystino/mock"},
		{ID: "free", Label: "Free", Model: "freebie/free-model"},
	}, nil
}

func (c *commandingWithModes) GetSession(_ context.Context, _, _ string) (backend.Session, error) {
	return backend.Session{ID: "s1", ModeID: c.sessionMode}, nil
}

func commandList(mods ...func(*backend.Command)) []backend.Command {
	shellTrue := true
	shellFalse := false
	out := []backend.Command{
		{Name: "plain", Source: backend.SourceCommand, Origin: backend.OriginProject, Shell: &shellFalse},
		{Name: "shelly", Source: backend.SourceCommand, Origin: backend.OriginProject, Shell: &shellTrue, ShellSnippets: []string{"rm -rf /"}},
		{Name: "unknown-shell", Source: backend.SourceMCP, Origin: backend.OriginMachine, Shell: nil},
		{Name: "secret-ref", Source: backend.SourceCommand, Origin: backend.OriginProject, Shell: &shellFalse, FileRefs: []string{".env"}},
		{Name: "free-model", Source: backend.SourceCommand, Origin: backend.OriginProject, Shell: &shellFalse, Model: "freebie/free-model"},
		{Name: "subtasked", Source: backend.SourceCommand, Origin: backend.OriginProject, Shell: &shellFalse, Subtask: true, Agent: "build"},
		{Name: "agentless", Source: backend.SourceCommand, Origin: backend.OriginProject, Shell: &shellFalse},
	}
	for _, mod := range mods {
		mod(&out[0])
	}
	return out
}

func TestOpSessionCommandRunsAHappyPath(t *testing.T) {
	back := &commandingBackend{commands: commandList()}
	mc := newTestMachine(t, back)
	trackTestSession(t, mc, "s1")

	if _, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"plain","arguments":"--fast","clientMessageId":"cm-1"}`)); operr != nil {
		t.Fatalf("session.command: %+v", operr)
	}
	if len(back.runs) != 1 {
		t.Fatalf("runs = %d, want 1", len(back.runs))
	}
	run := back.runs[0]
	if run.Name != "plain" || run.Arguments != "--fast" || run.ClientMessageID != "cm-1" {
		t.Errorf("run = %+v, want the raw arguments sent verbatim", run)
	}
}

func TestOpSessionCommandUnknownNameIsNotFound(t *testing.T) {
	back := &commandingBackend{commands: commandList()}
	mc := newTestMachine(t, back)
	trackTestSession(t, mc, "s1")

	_, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"nope"}`))
	if operr == nil || operr.Code != "not_found" {
		t.Fatalf("unknown command = %+v, want not_found (a stale menu must not 500)", operr)
	}
}

func TestOpSessionCommandTemplateHashConflict(t *testing.T) {
	shellFalse := false
	back := &commandingBackend{commands: []backend.Command{
		{Name: "plain", Source: backend.SourceCommand, Origin: backend.OriginProject, Shell: &shellFalse, TemplateHash: "aaa"},
	}}
	mc := newTestMachine(t, back)
	trackTestSession(t, mc, "s1")

	_, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"plain","templateHash":"bbb"}`))
	if operr == nil || operr.Code != "conflict" {
		t.Fatalf("changed template = %+v, want conflict", operr)
	}
	// The matching hash runs.
	if _, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"plain","templateHash":"aaa"}`)); operr != nil {
		t.Fatalf("matching hash = %+v, want a run", operr)
	}
	if len(back.runs) != 1 {
		t.Fatalf("runs = %d, want 1", len(back.runs))
	}
}

func TestOpSessionCommandShellGate(t *testing.T) {
	back := &commandingBackend{commands: commandList()}
	// The default policy denies command shell.
	mc := newTestMachine(t, back)
	trackTestSession(t, mc, "s1")

	for _, name := range []string{"shelly", "unknown-shell"} {
		_, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
			`{"sessionId":"s1","name":"`+name+`"}`))
		if operr == nil || operr.Code != "forbidden" {
			t.Fatalf("%s under a denied policy = %+v, want forbidden", name, operr)
		}
		if len(back.runs) != 0 {
			t.Fatalf("%s ran under a denied policy", name)
		}
	}
	// A provably shell-free command runs without the capability.
	if _, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"plain"}`)); operr != nil {
		t.Fatalf("plain under a denied policy = %+v, want a run", operr)
	}
	if len(back.runs) != 1 {
		t.Fatalf("runs = %d, want 1", len(back.runs))
	}
}

func TestOpSessionCommandShellAllowedByPolicy(t *testing.T) {
	back := &commandingBackend{commands: commandList()}
	mc := newTestMachine(t, back)
	mc.pol.CommandShell = "allowed"
	trackTestSession(t, mc, "s1")

	if _, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"shelly"}`)); operr != nil {
		t.Fatalf("shelly under an allowed policy = %+v, want a run", operr)
	}
	if len(back.runs) != 1 {
		t.Fatalf("runs = %d, want 1", len(back.runs))
	}
}

func TestOpSessionCommandFileDenyGate(t *testing.T) {
	back := &commandingBackend{commands: commandList()}
	mc := newTestMachine(t, back)
	trackTestSession(t, mc, "s1")

	// .env is on the default deny list.
	_, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"secret-ref"}`))
	if operr == nil || operr.Code != "forbidden" {
		t.Fatalf("a fileDeny ref = %+v, want forbidden", operr)
	}
	if len(back.runs) != 0 {
		t.Fatal("the denied command ran")
	}
	// An exempt name is fine: .env.example is negated in the default list.
	shellFalse := false
	back.commands = []backend.Command{
		{Name: "example-ref", Source: backend.SourceCommand, Shell: &shellFalse, FileRefs: []string{".env.example"}},
	}
	if _, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"example-ref"}`)); operr != nil {
		t.Fatalf("an exempt ref = %+v, want a run", operr)
	}
}

func TestOpSessionCommandFreeModelGate(t *testing.T) {
	back := &commandingBackend{commands: commandList()}
	mc := newTestMachine(t, back)
	trackTestSession(t, mc, "s1")

	_, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"free-model"}`))
	if operr == nil || operr.Code != "forbidden" {
		t.Fatalf("a free-model frontmatter = %+v, want forbidden (the setModel gate)", operr)
	}
	// Allowed by policy, the same command runs.
	mc.pol.AllowFreeModels = true
	if _, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"free-model"}`)); operr != nil {
		t.Fatalf("free model with allowFreeModels = %+v, want a run", operr)
	}
}

func TestOpSessionCommandAgentEscalation(t *testing.T) {
	back := &commandingWithModes{commandingBackend: commandingBackend{commands: commandList()}}
	// The default policy denies command shell; every command here is
	// shell-free, so the gates below are the only thing under test.
	mc := newTestMachine(t, back)
	mc.pol.CommandShell = "allowed"
	trackTestSession(t, mc, "s1")

	// Session in plan (index 0), command names build (index 1): the overlay
	// mode wins — sent verbatim, the command's agent ignored.
	back.sessionMode = "plan"
	if _, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"agentless","arguments":"x"}`)); operr != nil {
		t.Fatalf("agentless = %+v, want a run", operr)
	}
	// An agentless command runs under the session's own mode (the
	// 2026-09-26 plan's step 5): the overlay rides along.
	if len(back.runs) != 1 || back.runs[0].Agent != "plan" {
		t.Fatalf("runs = %+v, want an agentless command to carry the session's mode", back.runs)
	}
	back.runs = nil

	// A subtask command with a named agent under a more restrictive overlay
	// is refused outright: its child would run unsupervised in the other
	// agent.
	_, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"subtasked"}`))
	if operr == nil || operr.Code != "forbidden" {
		t.Fatalf("subtask escalation = %+v, want forbidden", operr)
	}
	if len(back.runs) != 0 {
		t.Fatal("the refused subtask ran")
	}

	// Session in build, command names plan (less restrictive): the
	// command's own agent applies.
	back.sessionMode = "build"
	if _, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"subtasked"}`)); operr != nil {
		t.Fatalf("subtask de-escalation = %+v, want a run", operr)
	}
	if len(back.runs) != 1 || back.runs[0].Agent != "build" {
		t.Fatalf("runs = %+v, want the command's own agent", back.runs)
	}
}

func TestOpSessionCommandEscalationRefusesEveryCommand(t *testing.T) {
	// The override is impossible — opencode runs cmd.agent whenever one is
	// set, whatever this process sends — so a more-permissive command agent
	// than the session's overlay mode refuses every command, subtask or
	// plain alike. The unit pin runs against the fake server; the live IT
	// runs the same shape against the real binary (batch A's arbiter rule).
	back := &commandingWithModes{commandingBackend: commandingBackend{
		commands: []backend.Command{
			{Name: "needsbuild", Source: backend.SourceCommand, Agent: "build"},
		},
	}, sessionMode: "plan"}
	mc := newTestMachine(t, back)
	mc.pol.CommandShell = "allowed"
	trackTestSession(t, mc, "s1")

	_, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"needsbuild"}`))
	if operr == nil || operr.Code != "forbidden" {
		t.Fatalf("plain-command escalation = %+v, want forbidden", operr)
	}
	if len(back.runs) != 0 {
		t.Fatal("the refused command ran")
	}
}

func TestOpSessionCommandExpandedShellGate(t *testing.T) {
	// The three M1 paths: a snippet smuggled in through the arguments lands
	// in the expanded text opencode scans, so the gate must read the
	// expansion, never the bare template.
	falseShell := false
	mk := func(template string) *resolvingBackend {
		return &resolvingBackend{
			commandingBackend: commandingBackend{commands: []backend.Command{
				{Name: "x", Source: backend.SourceCommand, Origin: backend.OriginProject, Shell: &falseShell},
			}},
			templates: map[string]string{"x": template},
		}
	}
	mcDenied := func(t *testing.T, template string) (*machine, *resolvingBackend) {
		t.Helper()
		back := mk(template)
		mc := newTestMachine(t, back)
		trackTestSession(t, mc, "s1")
		return mc, back
	}

	// 1. The snippet rides $ARGUMENTS.
	mc, back := mcDenied(t, "Say $ARGUMENTS.")
	_, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"x","arguments":"hi"}`))
	if operr != nil {
		t.Fatalf("clean arguments = %+v, want a run", operr)
	}
	mc2, _ := mcDenied(t, "Say $ARGUMENTS.")
	_, operr = mc2.Handle(context.Background(), "session.command", json.RawMessage(
		"{\"sessionId\":\"s1\",\"name\":\"x\",\"arguments\":\"run !`echo pwned` now\"}"))
	if operr == nil || operr.Code != "forbidden" {
		t.Fatalf("snippet-in-args = %+v, want forbidden", operr)
	}
	_ = back

	// 2. The snippet rides a @ref.
	mc3, _ := mcDenied(t, "Read $1.")
	_, operr = mc3.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"x","arguments":"@.env"}`))
	if operr == nil || operr.Code != "forbidden" {
		t.Fatalf("@.env-in-args = %+v, want forbidden", operr)
	}

	// 3. !$1 becomes shell only after substitution.
	mc4, _ := mcDenied(t, "Run !$1 now.")
	_, operr = mc4.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"x","arguments":"uptime"}`))
	if operr != nil {
		t.Fatalf("plain !$1 arg = %+v, want a run (no backticks, no shell)", operr)
	}
	mc5, _ := mcDenied(t, "Run !$1 now.")
	_, operr = mc5.Handle(context.Background(), "session.command", json.RawMessage(
		"{\"sessionId\":\"s1\",\"name\":\"x\",\"arguments\":\"`echo pwned`\"}"))
	if operr == nil || operr.Code != "forbidden" {
		t.Fatalf("backticked !$1 arg = %+v, want forbidden", operr)
	}
}

func TestOpSessionCommandAgentModelGate(t *testing.T) {
	falseShell := false
	back := &commandingWithModes{commandingBackend: commandingBackend{
		commands: []backend.Command{
			{Name: "gatewayagent", Source: backend.SourceCommand, Shell: &falseShell, Agent: "build"},
			{Name: "freeagent", Source: backend.SourceCommand, Shell: &falseShell, Agent: "free"},
			{Name: "unknownagent", Source: backend.SourceCommand, Shell: &falseShell, Agent: "ghost"},
		},
	}}
	mc := newTestMachine(t, back)
	mc.pol.CommandShell = "allowed"
	trackTestSession(t, mc, "s1")

	// The command's agent carries a gateway model: runs.
	if _, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"gatewayagent"}`)); operr != nil {
		t.Fatalf("gateway agent model = %+v, want a run", operr)
	}
	// The command's agent carries a non-gateway model: refused while free
	// models are disallowed (the setModel gate's second input).
	_, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"freeagent"}`))
	if operr == nil || operr.Code != "forbidden" {
		t.Fatalf("non-gateway agent model = %+v, want forbidden", operr)
	}
	// The command's agent is unknown to the backend: refused too, rather
	// than assumed gateway.
	_, operr = mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"unknownagent"}`))
	if operr == nil || operr.Code != "forbidden" {
		t.Fatalf("unknown agent model = %+v, want forbidden", operr)
	}
}

func TestOverlayModeWinsAgentWithoutAnOrder(t *testing.T) {
	// A backend that lists no modes: any named agent is an escalation while
	// an overlay mode is set.
	if !overlayModeWinsAgent("plan", "build", nil) {
		t.Fatal("want the overlay to win with no mode order to prove otherwise")
	}
	if overlayModeWinsAgent("plan", "", nil) {
		t.Fatal("an agentless command has nothing to override")
	}
	if overlayModeWinsAgent("", "build", nil) {
		t.Fatal("no overlay mode, no escalation to prevent")
	}
	// With an order, only the more-restrictive session mode wins.
	modes := []backend.Mode{{ID: "plan"}, {ID: "build"}}
	if !overlayModeWinsAgent("plan", "build", modes) {
		t.Fatal("plan session + build command: the overlay must win")
	}
	if overlayModeWinsAgent("build", "plan", modes) {
		t.Fatal("build session + plan command: the command's own agent applies")
	}
	if overlayModeWinsAgent("plan", "plan", modes) {
		t.Fatal("the same mode is not an escalation")
	}
}

func TestOpSessionCommandUnsupportedBackend(t *testing.T) {
	mc := newTestMachine(t, &fakeBackend{})
	trackTestSession(t, mc, "s1")
	_, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"plain"}`))
	if operr == nil || operr.Code != "unsupported" {
		t.Fatalf("commands on a backend without them = %+v, want unsupported", operr)
	}
}

func TestOpSessionCommandBusyIsInvalid(t *testing.T) {
	back := &commandingBackend{commands: commandList(), runErr: backend.ErrSessionBusy}
	mc := newTestMachine(t, back)
	trackTestSession(t, mc, "s1")

	_, operr := mc.Handle(context.Background(), "session.command", json.RawMessage(
		`{"sessionId":"s1","name":"plain"}`))
	if operr == nil || operr.Code != "invalid" {
		t.Fatalf("a busy backend's refusal = %+v, want invalid (the A0 sentinel)", operr)
	}
}

func TestOpBackendCommandsRequiresAWorkspaceOrSession(t *testing.T) {
	back := &commandingBackend{commands: commandList()}
	mc := newTestMachine(t, back)
	trackTestSession(t, mc, "s1")

	if _, operr := mc.Handle(context.Background(), "backend.commands", json.RawMessage(`{}`)); operr == nil || operr.Code != "invalid" {
		t.Fatalf("backend.commands with neither id = %+v, want invalid", operr)
	}
	res, operr := mc.Handle(context.Background(), "backend.commands", json.RawMessage(`{"sessionId":"s1"}`))
	if operr != nil {
		t.Fatalf("backend.commands by sessionId: %+v", operr)
	}
	if out := res.(map[string]any); len(out["commands"].([]backend.Command)) != len(commandList()) {
		t.Fatalf("commands = %v, want the full list", out["commands"])
	}
}

func TestOpBackendCommandsUnsupportedBackend(t *testing.T) {
	mc := newTestMachine(t, &fakeBackend{})
	trackTestSession(t, mc, "s1")
	_, operr := mc.Handle(context.Background(), "backend.commands", json.RawMessage(`{"sessionId":"s1"}`))
	if operr == nil || operr.Code != "unsupported" {
		t.Fatalf("listing on a backend without commands = %+v, want unsupported", operr)
	}
}

// MatchDeny is the shared matcher; the gate's use of it is pinned here so a
// matcher change that stops matching path tails is caught from the
// command side too.
func TestCommandFileDenyMatchesPathTails(t *testing.T) {
	if !files.MatchDeny([]string{"config/prod.yml"}, "repo/config/prod.yml") {
		t.Fatal("a path-tail deny entry must match the ref")
	}
}
