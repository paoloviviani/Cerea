package main

import (
	"context"
	"encoding/json"
	"testing"

	"galopin/internal/backend"
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

// modeListing makes the escalation gate's order explicit, and reports the
// session's mode the way the real backend would.
type commandingWithModes struct {
	commandingBackend
	sessionMode string
}

func (c *commandingWithModes) Modes(context.Context, string) ([]backend.Mode, error) {
	return []backend.Mode{
		{ID: "plan", Label: "Plan"},
		{ID: "build", Label: "Build"},
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
	back := &commandingWithModes{commandingBackend{commands: commandList()}, ""}
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
