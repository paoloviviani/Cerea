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

// commandFake answers the endpoints the commands tests touch: GET /doc
// (the capability probe), GET /command per directory (the origin diff's
// two halves), POST /session/:id/command (blocking until released, body
// recorded), and GET /session/:id/message (echoing the last command's
// minted messageID, so a Transcript shows what the mapping produced).
type commandFake struct {
	mu             sync.Mutex
	docHasCommand  bool
	commandsByDir  map[string][]map[string]any
	lastCommand    map[string]any
	release        chan struct{} // closed to let a blocked command POST answer
	commandStatus  int
	commandStarted chan struct{} // closed once a command POST arrives
	startedOnce    sync.Once
	docRequests    int
}

func newCommandFake(t *testing.T, cfg func(*commandFake)) (*Backend, *commandFake) {
	t.Helper()
	f := &commandFake{
		commandsByDir:  map[string][]map[string]any{},
		release:        make(chan struct{}),
		commandStatus:  http.StatusCreated,
		commandStarted: make(chan struct{}),
	}
	if cfg != nil {
		cfg(f)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/doc":
			f.mu.Lock()
			f.docRequests++
			has := f.docHasCommand
			f.mu.Unlock()
			body := `{"paths":{"/session/{id}/prompt_async":{"post":{"operationId":"session.prompt_async"}}}}`
			if has {
				body = `{"paths":{"/session/{id}/prompt_async":{"post":{"operationId":"session.prompt_async"}},"/session/{id}/command":{"post":{"operationId":"session.command"}}}}`
			}
			_, _ = io.WriteString(w, body)
		case r.URL.Path == "/command":
			dir := r.URL.Query().Get("directory")
			f.mu.Lock()
			listed := f.commandsByDir[dir]
			f.mu.Unlock()
			_ = json.NewEncoder(w).Encode(listed)
		case strings.HasSuffix(r.URL.Path, "/command") && strings.HasPrefix(r.URL.Path, "/session/"):
			body, _ := io.ReadAll(r.Body)
			f.mu.Lock()
			f.lastCommand = nil
			_ = json.Unmarshal(body, &f.lastCommand)
			f.mu.Unlock()
			f.startedOnce.Do(func() { close(f.commandStarted) })
			// session.command is synchronous: it answers only when the
			// whole turn has run. The fake holds it until the test releases.
			<-f.release
			w.WriteHeader(f.commandStatus)
		case strings.HasSuffix(r.URL.Path, "/message"):
			f.mu.Lock()
			minted, _ := f.lastCommand["messageID"].(string)
			f.mu.Unlock()
			_, _ = io.WriteString(w, `[{"info":{"id":"`+minted+`","role":"user"},"parts":[]}]`)
		case r.URL.Path == "/session/ses_1":
			_, _ = io.WriteString(w, `{"id":"ses_1","title":"t"}`)
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

func (f *commandFake) last() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]any{}
	for k, v := range f.lastCommand {
		out[k] = v
	}
	return out
}

func TestCommandsSupportedProbesDocNotVersion(t *testing.T) {
	b, f := newCommandFake(t, func(f *commandFake) { f.docHasCommand = true })
	if !b.commandsSupported() {
		t.Fatal("commandsSupported = false, want true (the /doc lists session.command)")
	}
	if b.Version() != "1.18.31" {
		t.Fatalf("Version = %q, want the pinned one (the capability must never come from it)", b.Version())
	}
	if b.Capabilities().Commands != true {
		t.Fatal("Capabilities().Commands = false, want true")
	}

	// Cached: the second call does not hit /doc again.
	f.mu.Lock()
	after := f.docRequests
	f.mu.Unlock()
	_ = b.commandsSupported()
	f.mu.Lock()
	if f.docRequests != after {
		t.Fatalf("doc requests went %d -> %d on a cached read", after, f.docRequests)
	}
	f.mu.Unlock()

	// A supervised restart is a new server: the cache is invalidated by the
	// backend generation bump, and the next read re-probes.
	b.commandsMu.Lock()
	b.backendGen++
	b.commandsMu.Unlock()
	_ = b.commandsSupported()
	f.mu.Lock()
	if f.docRequests == after {
		t.Fatal("a backend generation bump must re-probe /doc")
	}
	f.mu.Unlock()
}

func TestCommandsSupportedFalseWhenDocLacksIt(t *testing.T) {
	b, _ := newCommandFake(t, nil)
	if b.commandsSupported() {
		t.Fatal("commandsSupported = true, want false (/doc does not list session.command)")
	}
	if b.Capabilities().Commands {
		t.Fatal("Capabilities().Commands = true, want false")
	}
}

func TestCommandsSupportedFalseWhenDocFails(t *testing.T) {
	// A backend whose /doc cannot be read does not get the capability
	// claimed for it.
	b := New(Config{Hostname: "127.0.0.1", Port: 1, Password: "x"})
	if b.commandsSupported() {
		t.Fatal("commandsSupported = true, want false (the probe failed)")
	}
}

func TestListCommandsDiffOriginsAndScanTemplates(t *testing.T) {
	b, _ := newCommandFake(t, func(f *commandFake) {
		f.commandsByDir["/ws"] = []map[string]any{
			{"name": "init", "description": "guided setup", "source": "command",
				"template": "read @docs/plan.md and go", "hints": []string{}},
			{"name": "deploy", "source": "command",
				"template": "run !`deploy --env prod` now, then @scripts/verify.sh", "hints": []string{}},
			{"name": "ask-mcp", "source": "mcp", "hints": []string{"$1"}},
			{"name": "usercmd", "source": "command",
				"template": "plain text, no expansion @notes.md", "hints": []string{}},
		}
		f.commandsByDir["/state"] = []map[string]any{
			{"name": "init", "description": "guided setup", "source": "command",
				"template": "read @docs/plan.md and go"},
			{"name": "usercmd", "source": "command", "template": "plain text, no expansion @notes.md"},
		}
	})
	b.cfg.StateDir = "/state"

	commands, err := b.ListCommands(context.Background(), "/ws", "ses_1")
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]backend.Command{}
	for _, cmd := range commands {
		byName[cmd.Name] = cmd
	}

	init := byName["init"]
	if init.Origin != backend.OriginBuiltin {
		t.Errorf("init origin = %q, want builtin", init.Origin)
	}
	if init.Shell != nil && *init.Shell {
		t.Error("init shell = true, want false (no !` expansion in the template)")
	}
	if init.TemplateHash == "" {
		t.Error("init templateHash is empty, want the template's sha256")
	}
	if len(init.FileRefs) != 1 || init.FileRefs[0] != "docs/plan.md" {
		t.Errorf("init fileRefs = %v, want [docs/plan.md]", init.FileRefs)
	}

	deploy := byName["deploy"]
	if deploy.Origin != backend.OriginProject {
		t.Errorf("deploy origin = %q, want project (absent from the state listing)", deploy.Origin)
	}
	if deploy.Shell == nil || !*deploy.Shell {
		t.Error("deploy shell = nil/false, want true (the template expands !`…`)")
	}
	if len(deploy.ShellSnippets) != 1 || deploy.ShellSnippets[0] != "deploy --env prod" {
		t.Errorf("deploy snippets = %v, want the one expansion", deploy.ShellSnippets)
	}

	mcp := byName["ask-mcp"]
	if mcp.Shell != nil {
		t.Error("an mcp-sourced command's shell must be nil (unknown), not a guess")
	}
	if mcp.Origin != backend.OriginMachine {
		t.Errorf("mcp origin = %q, want machine", mcp.Origin)
	}
	if mcp.TemplateHash != "" {
		t.Error("an mcp-sourced command must carry no hash: its text is fetched at run time")
	}

	user := byName["usercmd"]
	if user.Origin != backend.OriginMachine {
		t.Errorf("usercmd origin = %q, want machine (listed for the state dir too)", user.Origin)
	}
	if user.Shell == nil || *user.Shell {
		t.Error("usercmd shell = nil/true, want false (the template provably has no expansion)")
	}
	if len(user.FileRefs) != 1 || user.FileRefs[0] != "notes.md" {
		t.Errorf("usercmd fileRefs = %v, want [notes.md]", user.FileRefs)
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

func TestRunCommandReturnsBeforeThePostCompletes(t *testing.T) {
	b, f := newCommandFake(t, func(f *commandFake) { f.docHasCommand = true })

	done := make(chan error, 1)
	start := time.Now()
	go func() {
		done <- b.RunCommand(context.Background(), "/ws", "ses_1", backend.CommandRun{
			Name: "deploy", Arguments: "--env prod", Agent: "build",
		})
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("RunCommand: %v", err)
		}
		if elapsed := time.Since(start); elapsed > time.Second {
			t.Errorf("RunCommand took %s; it must return once the run is accepted", elapsed)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RunCommand did not return promptly (it must not wait for the turn)")
	}

	// The blocking POST is still in flight; release it and give the body a
	// moment to land, then assert it.
	close(f.release)
	<-f.commandStarted
	deadline := time.Now().Add(5 * time.Second)
	for {
		body := f.last()
		if body["command"] == "deploy" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the command POST never landed: %v", body)
		}
		time.Sleep(20 * time.Millisecond)
	}
	body := f.last()
	if body["arguments"] != "--env prod" {
		t.Errorf("arguments = %v, want the raw string", body["arguments"])
	}
	if body["agent"] != "build" {
		t.Errorf("agent = %v, want the effective agent the dispatcher resolved", body["agent"])
	}
	minted, _ := body["messageID"].(string)
	if !strings.HasPrefix(minted, "msg_") || len(minted) != len("msg_")+26 {
		t.Errorf("messageID = %q, want an opencode-shaped minted id", minted)
	}

	// And the transcript carries the marker against exactly that id.
	tr, err := b.Transcript(context.Background(), "/ws", "ses_1")
	if err != nil {
		t.Fatal(err)
	}
	if len(tr.Messages) != 1 || tr.Messages[0].Message.Role != "user" {
		t.Fatalf("transcript = %+v, want one user message", tr.Messages)
	}
	marker := tr.Messages[0].Message.Command
	if marker == nil || marker.Name != "deploy" || marker.Arguments != "--env prod" {
		t.Errorf("command marker = %+v, want deploy --env prod", marker)
	}
}

func TestRunCommandSendsOverlayModelAndVariant(t *testing.T) {
	b, f := newCommandFake(t, func(f *commandFake) { f.docHasCommand = true })
	if _, err := b.SetModel(context.Background(), "/ws", "ses_1", "pystino/coder-large"); err != nil {
		t.Fatal(err)
	}
	if _, err := b.SetEffort(context.Background(), "/ws", "ses_1", "high"); err != nil {
		t.Fatal(err)
	}

	_ = b.RunCommand(context.Background(), "/ws", "ses_1", backend.CommandRun{Name: "compact-ish"})
	close(f.release)
	<-f.commandStarted
	deadline := time.Now().Add(5 * time.Second)
	for {
		if f.last()["model"] != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the command POST never landed")
		}
		time.Sleep(20 * time.Millisecond)
	}
	body := f.last()
	// session.command takes the model as one "provider/model" string,
	// unlike prompt_async's object (plan §1.2).
	if body["model"] != "pystino/coder-large" {
		t.Errorf("model = %v, want the overlay's model as a string", body["model"])
	}
	if body["variant"] != "high" {
		t.Errorf("variant = %v, want the overlay's effort", body["variant"])
	}
	if _, ok := body["agent"]; ok {
		t.Errorf("agent = %v, want it absent when the dispatcher resolved none", body["agent"])
	}
}

func TestRunCommandLateFailureBecomesAnErrorEvent(t *testing.T) {
	b, f := newCommandFake(t, func(f *commandFake) {
		f.docHasCommand = true
		f.commandStatus = http.StatusBadRequest
	})

	events, err := b.Subscribe(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if err := b.RunCommand(context.Background(), "/ws", "ses_1", backend.CommandRun{Name: "deploy"}); err != nil {
		t.Fatalf("RunCommand: %v (the acceptance must succeed even though the turn will fail)", err)
	}
	close(f.release)

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
	b, f := newCommandFake(t, func(f *commandFake) { f.docHasCommand = true })

	if err := b.RunCommand(context.Background(), "/ws", "ses_1", backend.CommandRun{
		Name: "deploy", Arguments: "", ClientMessageID: "cm-1",
	}); err != nil {
		t.Fatal(err)
	}
	close(f.release)
	<-f.commandStarted

	tr, err := b.Transcript(context.Background(), "/ws", "ses_1")
	if err != nil {
		t.Fatal(err)
	}
	if got := tr.Messages[0].Message.ClientMessageID; got != "cm-1" {
		t.Errorf("ClientMessageID = %q, want cm-1 recorded against the minted id", got)
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
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ExpandArguments(tc.template, tc.args); got != tc.want {
				t.Errorf("ExpandArguments(%q, %q) = %q, want %q", tc.template, tc.args, got, tc.want)
			}
		})
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

// A repo borrowing a builtin's name with different frontmatter is the
// repo's: the builtin label needs the state's metadata to agree.
func TestBuiltinSpoofReadsAsProject(t *testing.T) {
	b, _ := newCommandFake(t, func(f *commandFake) {
		f.commandsByDir["/ws"] = []map[string]any{
			{"name": "review", "description": "ship it, no review", "source": "command",
				"template": "do it", "hints": []string{}},
		}
		f.commandsByDir["/state"] = []map[string]any{
			{"name": "review", "description": "review changes", "source": "command",
				"subtask": true, "template": "look", "hints": []string{}},
		}
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

// A user-level name the repo reuses reads as the repo's on a hash
// mismatch — the machine's own text, not the user's.
func TestMachineNameReuseReadsAsProject(t *testing.T) {
	b, _ := newCommandFake(t, func(f *commandFake) {
		f.commandsByDir["/ws"] = []map[string]any{
			{"name": "deploy", "source": "command", "template": "repo text", "hints": []string{}},
		}
		f.commandsByDir["/state"] = []map[string]any{
			{"name": "deploy", "source": "command", "template": "user text", "hints": []string{}},
		}
	})
	b.cfg.StateDir = "/state"

	commands, err := b.ListCommands(context.Background(), "/ws", "ses_1")
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 1 || commands[0].Origin != backend.OriginProject {
		t.Fatalf("commands = %+v, want the reused name as project", commands)
	}
}

func TestResolveCommandExpands(t *testing.T) {
	b, _ := newCommandFake(t, func(f *commandFake) {
		f.commandsByDir["/ws"] = []map[string]any{
			{"name": "hi", "source": "command", "template": "Say hi to $1.", "hints": []string{}},
		}
	})
	b.cfg.StateDir = "/state"

	resolved, err := b.ResolveCommand(context.Background(), "/ws", "ses_1", "hi", "gamma delta")
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Command.Name != "hi" || resolved.Command.Origin != backend.OriginProject {
		t.Errorf("resolved command = %+v, want hi/project", resolved.Command)
	}
	if resolved.Expanded != "Say hi to gamma delta." {
		t.Errorf("expanded = %q, want the substitution applied", resolved.Expanded)
	}

	if _, err := b.ResolveCommand(context.Background(), "/ws", "ses_1", "nope", ""); !errors.Is(err, backend.ErrCommandNotFound) {
		t.Errorf("unknown name err = %v, want ErrCommandNotFound", err)
	}
}
