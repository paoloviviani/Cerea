package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"galopin/internal/backend"
)

// commandFake answers the endpoints the commands tests touch: GET
// /api/command per directory (the origin diff's two halves), GET /api/agent,
// POST /api/session/:id/command (answering at once with the queued message's
// id, body recorded) and GET /api/session/:id/message (echoing that id, so a
// Transcript shows what the mapping produced). 2.x lists a command by name and
// description only: no template, no source.
type commandFake struct {
	mu            sync.Mutex
	commandsByDir map[string][]map[string]any
	lastCommand   map[string]any
	commandStatus int
	agents        []map[string]any // GET /api/agent's answer
	failAgent     bool             // make GET /api/agent fail
	lastAgentDir  string           // the location[directory] GET /api/agent last saw
	queuedID      string           // the id the command POST answers with
}

func newCommandFake(t *testing.T, cfg func(*commandFake)) (*Backend, *commandFake) {
	t.Helper()
	f := &commandFake{
		commandsByDir: map[string][]map[string]any{},
		commandStatus: http.StatusOK,
		queuedID:      "msg_queued0000000000000000aa",
	}
	if cfg != nil {
		cfg(f)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/agent":
			f.mu.Lock()
			fail, agents := f.failAgent, f.agents
			f.lastAgentDir = r.URL.Query().Get("location[directory]")
			f.mu.Unlock()
			if fail {
				w.WriteHeader(http.StatusInternalServerError)
				break
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": agents})
		case r.URL.Path == "/api/command":
			dir := r.URL.Query().Get("location[directory]")
			f.mu.Lock()
			listed := f.commandsByDir[dir]
			f.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"data": listed})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/command") && strings.HasPrefix(r.URL.Path, "/api/session/"):
			body, _ := io.ReadAll(r.Body)
			f.mu.Lock()
			f.lastCommand = nil
			_ = json.Unmarshal(body, &f.lastCommand)
			status, id := f.commandStatus, f.queuedID
			f.mu.Unlock()
			if status >= 300 {
				w.WriteHeader(status)
				return
			}
			w.WriteHeader(http.StatusNoContent) // opencode 2.3 answers a command with no body
			_ = id
		case strings.HasSuffix(r.URL.Path, "/message"):
			f.mu.Lock()
			id := f.queuedID
			f.mu.Unlock()
			_, _ = io.WriteString(w, `{"data":[{"id":"`+id+`","type":"user","text":"x","time":{"created":`+strconv.FormatInt(time.Now().UnixMilli(), 10)+`}}],"cursor":{}}`)
		case r.URL.Path == "/api/session/ses_1":
			_, _ = io.WriteString(w, `{"data":{"id":"ses_1","title":"t"}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ := strconv.Atoi(portStr)
	b := New(Config{Hostname: host, Port: port, Password: "x"})
	return b, f
}

func (f *commandFake) agentDir() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastAgentDir
}

func (f *commandFake) last() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]any{}
	for k, v := range f.lastCommand {
		out[k] = v
	}
	return out
}

// waitCommand waits for the (asynchronous) command POST to land.
func (f *commandFake) waitCommand(t *testing.T) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if body := f.last(); body["name"] != nil {
			return body
		}
		if time.Now().After(deadline) {
			t.Fatal("the command POST never landed")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// M8's pin: the real backend implements backend.AgentLister from the
// FULL /agent list — primaries and subagents alike, name to model (""
// when the agent pins none). The primary-only projection Modes reads is
// not enough: a command naming a subagent must resolve too, and the
// dispatch's AgentLister assertion must hold on the real backend, not
// only on the test fakes.
func TestAgentModelsListsPrimariesAndSubagents(t *testing.T) {
	b, _ := newCommandFake(t, func(f *commandFake) {
		f.agents = []map[string]any{
			{"id": "build", "mode": "primary"},
			{"id": "plan", "mode": "primary"},
			{"id": "general", "mode": "subagent", "model": map[string]any{"providerID": "pystino", "id": "mock-model"}},
		}
	})
	got := b.AgentModels(context.Background(), "/ws")
	if v, ok := got["build"]; !ok || v != "" {
		t.Fatalf("AgentModels[build] = %q, %v; want \"\", listed", v, ok)
	}
	if _, ok := got["plan"]; !ok {
		t.Fatalf("AgentModels has no plan entry; want every primary listed")
	}
	if got["general"] != "pystino/mock-model" {
		t.Fatalf("AgentModels[general] = %q, want pystino/mock-model (the subagent's own model)", got["general"])
	}
}

// A failed /agent read answers nil — the dispatch then refuses
// agent-naming commands rather than assuming a model the server never
// confirmed (the same fail-closed shape as L6).
func TestAgentModelsNilOnFailure(t *testing.T) {
	b, _ := newCommandFake(t, func(f *commandFake) { f.failAgent = true })
	if got := b.AgentModels(context.Background(), "/ws"); got != nil {
		t.Fatalf("AgentModels on a failed read = %v, want nil", got)
	}
}

// M9: opencode answers /agent per directory — a project's own
// .opencode/agent/*.md and opencode.json agents exist only for that
// workspace. Omitting the query reads the server's own working directory
// instead, which is never the workspace, so project-defined agents read
// as absent from the gate's point of view. Modes shares the same
// omission and the same fix.
func TestAgentModelsSendsWorkspaceDirectory(t *testing.T) {
	b, f := newCommandFake(t, func(f *commandFake) {
		f.agents = []map[string]any{{"id": "build", "mode": "primary"}}
	})
	b.AgentModels(context.Background(), "/ws/project")
	if got := f.agentDir(); got != "/ws/project" {
		t.Fatalf("GET /api/agent location[directory] = %q, want /ws/project", got)
	}
}

func TestModesSendsWorkspaceDirectory(t *testing.T) {
	b, f := newCommandFake(t, func(f *commandFake) {
		f.agents = []map[string]any{{"id": "build", "mode": "primary"}}
	})
	if _, err := b.Modes(context.Background(), "/ws/project"); err != nil {
		t.Fatal(err)
	}
	if got := f.agentDir(); got != "/ws/project" {
		t.Fatalf("GET /api/agent location[directory] = %q, want /ws/project", got)
	}
}

// 2.x always serves commands; the capability no longer rides on a probe.
func TestCommandsAreAlwaysSupported(t *testing.T) {
	b := New(Config{Hostname: "127.0.0.1", Port: 1, Password: "x"})
	if !b.commandsSupported() || !b.Capabilities().Commands {
		t.Fatal("commands must be advertised: 2.x serves them")
	}
}

// 2.x lists a command by name and description only. Without a template there
// is no content to prove an origin or scan for shell, so every command reads as
// the project's (the confirmation sheet) with shell unknown (refused under a
// denied shell policy), never as a trusted builtin or machine command.
func TestListCommandsFailClosedWithoutTemplates(t *testing.T) {
	b, _ := newCommandFake(t, func(f *commandFake) {
		f.commandsByDir["/ws"] = []map[string]any{
			{"name": "init", "description": "guided setup"},
			{"name": "review", "description": "review changes"},
			{"name": "deploy"},
		}
		f.commandsByDir["/state"] = []map[string]any{
			{"name": "init", "description": "guided setup"},
			{"name": "review", "description": "review changes"},
		}
	})
	b.cfg.StateDir = "/state"

	commands, err := b.ListCommands(context.Background(), "/ws", "ses_1")
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 3 {
		t.Fatalf("commands = %+v, want three", commands)
	}
	for _, cmd := range commands {
		if cmd.Origin != backend.OriginProject {
			t.Errorf("%s origin = %q, want project (nothing proves otherwise)", cmd.Name, cmd.Origin)
		}
		if cmd.Shell != nil {
			t.Errorf("%s shell = %v, want unknown (nil): the template is not exposed", cmd.Name, *cmd.Shell)
		}
		if cmd.TemplateHash != "" {
			t.Errorf("%s carries a template hash with no template", cmd.Name)
		}
	}
}

func TestScanTemplateCapsSnippets(t *testing.T) {
	template := "x"
	for i := 0; i < 15; i++ {
		template += " !`snippet" + strconv.Itoa(i) + "`"
	}
	shell, snippets, _ := scanTemplate(template)
	if !shell {
		t.Fatal("shell = false, want true")
	}
	if len(snippets) != maxShellSnippets {
		t.Errorf("snippets = %d, want the cap of %d", len(snippets), maxShellSnippets)
	}
}

func TestScanTemplateCapsSnippetLength(t *testing.T) {
	long := strings.Repeat("x", 500)
	_, snippets, _ := scanTemplate("!`" + long + "`")
	if len(snippets) != 1 || len(snippets[0]) != 200 {
		t.Errorf("snippet length = %d, want the 200-char cap", len(snippets[0]))
	}
}

func TestRunCommandPostsNameAndArgumentsAndMarksTheQueuedMessage(t *testing.T) {
	b, f := newCommandFake(t, nil)

	if err := b.RunCommand(context.Background(), "/ws", "ses_1", backend.CommandRun{
		Name: "deploy", Arguments: "--env prod",
	}); err != nil {
		t.Fatalf("RunCommand: %v", err)
	}
	body := f.waitCommand(t)
	if body["name"] != "deploy" || body["text"] != "--env prod" {
		t.Errorf("body = %v, want name deploy and the raw arguments as text", body)
	}

	// The transcript carries the marker against the id the server queued.
	deadline := time.Now().Add(5 * time.Second)
	for {
		tr, err := b.Transcript(context.Background(), "/ws", "ses_1")
		if err != nil {
			t.Fatal(err)
		}
		if len(tr.Messages) == 1 && tr.Messages[0].Message.Command != nil {
			marker := tr.Messages[0].Message.Command
			if marker.Name != "deploy" || marker.Arguments != "--env prod" {
				t.Errorf("command marker = %+v, want deploy --env prod", marker)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("transcript = %+v, want one user message with the command marker", tr.Messages)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestRunCommandLateFailureBecomesAnErrorEvent(t *testing.T) {
	b, _ := newCommandFake(t, func(f *commandFake) { f.commandStatus = http.StatusBadRequest })

	events, err := b.Subscribe(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if err := b.RunCommand(context.Background(), "/ws", "ses_1", backend.CommandRun{Name: "deploy"}); err != nil {
		t.Fatalf("RunCommand: %v (the acceptance must succeed even though the run will fail)", err)
	}

	deadline := time.After(5 * time.Second)
	for {
		select {
		case env := <-events:
			if env.SessionID != "ses_1" {
				continue
			}
			if env.Event.Kind == backend.EventError {
				if !strings.Contains(env.Event.ErrorMessage, "deploy") {
					t.Errorf("error event message = %q, want it to name the command", env.Event.ErrorMessage)
				}
				return
			}
		case <-deadline:
			t.Fatal("no error event arrived for the late command failure")
		}
	}
}

func TestRunCommandMapsTheClientMessageIDExactly(t *testing.T) {
	b, f := newCommandFake(t, nil)

	if err := b.RunCommand(context.Background(), "/ws", "ses_1", backend.CommandRun{
		Name: "deploy", Arguments: "", ClientMessageID: "cm-1",
	}); err != nil {
		t.Fatal(err)
	}
	f.waitCommand(t)

	deadline := time.Now().Add(5 * time.Second)
	for {
		tr, err := b.Transcript(context.Background(), "/ws", "ses_1")
		if err != nil {
			t.Fatal(err)
		}
		if len(tr.Messages) == 1 && tr.Messages[0].Message.ClientMessageID == "cm-1" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("transcript = %+v, want cm-1 recorded against the queued id", tr.Messages)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// The substitution machine, opencode's own (SessionPrompt.command),
// ported case by case: $N positional, the last placeholder swallowing the
// rest, $ARGUMENTS, and the append-when-no-placeholder rule.
func TestExpandArguments(t *testing.T) {
	for _, tc := range []struct {
		name     string
		template string
		args     string
		want     string
	}{
		{"positional", "Say hi to $1.", "gamma", "Say hi to gamma."},
		{"two positionals, last swallows", "$1 says $2", "a b c", "a says b c"},
		{"last swallows the rest", "Report $1 then $2", "a b c", "Report a then b c"},
		{"only placeholder takes all", "Summarize $1", "a b c", "Summarize a b c"},
		{"missing arg is empty", "Hi $1$2.", "a", "Hi a."},
		{"arguments placeholder", "Do $ARGUMENTS now.", "x y", "Do x y now."},
		{"quoted args keep spaces", `Run "$1"`, `"a b" c`, `Run "a b c"`},
		{"single-quoted args", "Run $1", "'a b'", "Run a b"},
		{"append when no placeholder", "Look.", "over there", "Look.\n\nover there"},
		{"blank arguments append nothing", "Look.", "   ", "Look."},
		{"no args, no placeholders", "Look.", "", "Look."},
		// M6's bypass: $` from the SECOND $ARGUMENTS must pull the
		// original's prefix (including the earlier placeholder's own
		// substitution), not the slice since the previous match — the
		// faithful build carries "Y!`id`", the drifted build "Y! Y".
		{"backtick pattern from the second occurrence",
			"`id` X $ARGUMENTS Y!$ARGUMENTS", "$`",
			"`id` X `id` X  Y!`id` X $ARGUMENTS Y!"},
		// $' stays the original's suffix from the second occurrence too:
		// match 1's suffix is " Y$ARGUMENTS", match 2's is the empty tail.
		{"quote pattern from the second occurrence",
			"`id` X $ARGUMENTS Y$ARGUMENTS", "$'",
			"`id` X  Y$ARGUMENTS Y"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ExpandArguments(tc.template, tc.args); got != tc.want {
				t.Errorf("ExpandArguments(%q, %q) = %q, want %q", tc.template, tc.args, got, tc.want)
			}
		})
	}
}

// TestExpandArgumentsBypassScan is the M6 gate-level pin: the faithful
// build of the two-occurrence $` bypass reconstructs "Y!`id`", so the
// expanded scan must see shell — under the denied policy that refusal is
// the whole point. The drifted build ("Y! Y") scanned clean and passed.
func TestExpandArgumentsBypassScan(t *testing.T) {
	expanded := ExpandArguments("`id` X $ARGUMENTS Y!$ARGUMENTS", "$`")
	if !strings.Contains(expanded, "Y!`id`") {
		t.Fatalf("expansion = %q, want the reconstructed %q", expanded, "Y!`id`")
	}
	shell, _, _ := ScanExpanded(expanded)
	if !shell {
		t.Fatalf("ScanExpanded(%q) = shell false, want true", expanded)
	}
}

// The scan must run on the same text opencode detects shell and resolves
// @files on — the combined text. The L1 regex emulates opencode's own
// (/(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/), lookbehind by hand.
func TestFileRefsIn(t *testing.T) {
	for _, tc := range []struct {
		name string
		text string
		want []string
	}{
		{"plain ref", "read @docs/plan.md", []string{"docs/plan.md"}},
		{"trailing dot is not the ref", "see @.env. next", []string{".env"}},
		{"email is not a ref", "mail foo@bar.com today", nil},
		{"backtick text is not a ref", "run !`echo @x` now", []string{"x"}},
		{"no refs", "plain text", nil},
		// M7: JavaScript's \s ends the reference where Go's \s wouldn't —
		// opencode resolves ".env" and reads it, so the gate must deny
		// ".env", not the glued ".env<NBSP>x" (or VT) that misses the
		// deny list.
		{"NBSP ends the reference", "@.env\u00a0x", []string{".env"}},
		{"vertical tab ends the reference", "@.env\u000bx", []string{".env"}},
		{"BOM ends the reference", "@.env\ufeffx", []string{".env"}},
		{"en-quad ends the reference", "@.env\u2000x", []string{".env"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := fileRefsIn(tc.text)
			if len(got) != len(tc.want) {
				t.Fatalf("fileRefsIn(%q) = %v, want %v", tc.text, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("fileRefsIn(%q) = %v, want %v", tc.text, got, tc.want)
				}
			}
		})
	}
}

// TestSplitArgsWhitespace pins the tokenizer's whitespace class against
// opencode's argsRegex: JavaScript's \s splits, and the two characters
// unicode.IsSpace gets wrong both ways behave as the engine does — NBSP
// and BOM split (Go misses them), U+0085 does not (Go would split it).
// A drifted boundary moves an argument across a quote, and the expanded
// text the gate reads stops being the text the run produces.
func TestSplitArgsWhitespace(t *testing.T) {
	for _, tc := range []struct {
		name string
		args string
		want []string
	}{
		{"NBSP splits", "a\u00a0b", []string{"a", "b"}},
		{"BOM splits", "a\ufeffb", []string{"a", "b"}},
		{"NEL does not split", "a\u0085b", []string{"a\u0085b"}},
		{"en-quad splits", "a\u2000b", []string{"a", "b"}},
		{"plain spaces split", "a b", []string{"a", "b"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := splitArgs(tc.args)
			if len(got) != len(tc.want) {
				t.Fatalf("splitArgs(%q) = %q, want %q", tc.args, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("splitArgs(%q) = %q, want %q", tc.args, got, tc.want)
				}
			}
		})
	}
}

// A repo borrowing a builtin's name is the repo's: with no template to compare,
// not even a matching description makes it a builtin.
func TestBuiltinNameReadsAsProjectWithoutAProof(t *testing.T) {
	b, _ := newCommandFake(t, func(f *commandFake) {
		f.commandsByDir["/ws"] = []map[string]any{{"name": "review", "description": "ship it, no review"}}
		f.commandsByDir["/state"] = []map[string]any{{"name": "review", "description": "review changes"}}
	})
	b.cfg.StateDir = "/state"

	commands, err := b.ListCommands(context.Background(), "/ws", "ses_1")
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 1 || commands[0].Origin != backend.OriginProject {
		t.Fatalf("commands = %+v, want the spoofed review as project", commands)
	}
}

func TestResolveCommandKnowsNoTemplate(t *testing.T) {
	b, _ := newCommandFake(t, func(f *commandFake) {
		f.commandsByDir["/ws"] = []map[string]any{{"name": "hi"}}
	})
	b.cfg.StateDir = "/state"

	resolved, err := b.ResolveCommand(context.Background(), "/ws", "ses_1", "hi", "gamma delta")
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Command.Name != "hi" || resolved.Command.Origin != backend.OriginProject {
		t.Errorf("resolved command = %+v, want hi/project", resolved.Command)
	}
	if resolved.Expanded != "" {
		t.Errorf("expanded = %q, want none: 2.x expands the template itself", resolved.Expanded)
	}

	if _, err := b.ResolveCommand(context.Background(), "/ws", "ses_1", "nope", ""); !errors.Is(err, backend.ErrCommandNotFound) {
		t.Errorf("unknown name err = %v, want ErrCommandNotFound", err)
	}
}
