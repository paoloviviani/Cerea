package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	backendacp "galopin/internal/backend/acp"
	"galopin/internal/localmcp"
	"galopin/internal/mcpserve"
	"galopin/internal/mockllm"
	"galopin/internal/policy"
)

// Real goose against galopin's goose engine, with a fake OpenAI-compatible model
// (internal/mockllm) as the proxy's upstream: no key, no network. Gated on
// GALOPIN_GOOSE_IT=1 and a `goose` on PATH (galopin is pointed at it with GALOPIN_GOOSE_BIN); CI's goose
// workflow runs it against the pinned and the latest goose.

type gooseRig struct {
	t       *testing.T
	b       runningBackend
	events  <-chan backend.BackendEvent
	work    string
	env     []string // HOME and XDG_DATA_HOME, to run goose's own CLI against the same store
	mock    *httptest.Server
	mockURL string
}

func newGooseRig(t *testing.T) *gooseRig { return newGooseRigVia(t, nil) }

// newGooseRigVia is newGooseRig with goose's provider pointed at a real galopin
// shim in front of the mock (the path a real machine uses), returned through
// *via, so usage read off the proxy can be seen.
func newGooseRigVia(t *testing.T, via **shim) *gooseRig {
	t.Helper()
	if os.Getenv("GALOPIN_GOOSE_IT") == "" {
		t.Skip("set GALOPIN_GOOSE_IT=1 (and have goose on PATH) to run the goose engine tests")
	}
	useITGoose(t)
	if _, err := gooseBinary(); err != nil {
		t.Skip(err)
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	t.Setenv("GOOSE_PATH_ROOT", "")
	t.Setenv("TMPDIR", t.TempDir())

	mock := httptest.NewServer(mockllm.New())
	t.Cleanup(mock.Close)
	port := mock.Listener.Addr().(*net.TCPAddr).Port

	stateDir := t.TempDir()
	credsPath := filepath.Join(stateDir, "credentials.json")
	creds := &credentials{ShimPort: port, ShimSecret: "it-secret"}
	var proxy *shim
	if via != nil {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		shimPort := ln.Addr().(*net.TCPAddr).Port
		gwCreds := &credentials{Gateway: mock.URL + "/v1", AccessToken: "tok", RefreshToken: "r", ExpiresIn: 3600,
			ObtainedAt: time.Now().Unix(), ShimPort: shimPort, ShimSecret: "it-secret"}
		if err := saveCredentials(credsPath, gwCreds); err != nil {
			t.Fatal(err)
		}
		proxy = newShim(gwCreds, credsPath, statusPathFor(credsPath), shimPort)
		srv := &httptest.Server{Listener: ln, Config: &http.Server{Handler: http.HandlerFunc(proxy.requireLocalAuth(proxy.handler))}}
		srv.Start()
		t.Cleanup(srv.Close)
		creds = gwCreds
		*via = proxy
	}
	if err := writeGooseEngineConfig(gooseRootFor(credsPath), creds, []gatewayModel{{ID: "mock-model"}}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	t.Cleanup(cancel)
	b, err := startGooseBackend(ctx, &runOptions{}, credsPath, stateDir, policy.Default(), nil, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.Stop() })
	if proxy != nil {
		proxy.setUsageSink(gooseUsageSink(b.(*backendacp.Backend), gooseProviderPath(filepath.Join(gooseRootFor(credsPath), "config"))))
	}
	events, err := b.Subscribe(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return &gooseRig{t: t, b: b, events: events, work: t.TempDir(), mock: mock, mockURL: mock.URL,
		env: append(os.Environ(), "HOME="+home, "XDG_DATA_HOME="+filepath.Join(home, "data"), "XDG_CONFIG_HOME="+filepath.Join(home, "config"))}
}

func (r *gooseRig) scenario(sc mockllm.Scenario) {
	body, _ := json.Marshal(map[string]any{"scenario": sc})
	resp, err := http.Post(r.mockURL+"/__control/scenario", "application/json", strings.NewReader(string(body)))
	if err != nil {
		r.t.Fatal(err)
	}
	resp.Body.Close()
}

// turn sends a prompt and runs it to idle, answering every ask with decision,
// and returns the asks it saw and the assistant text.
func (r *gooseRig) turn(sessionID, text string, decision backend.Decision) (asks []backend.PermissionRequest, reply string) {
	r.t.Helper()
	ctx := context.Background()
	if err := r.b.Prompt(ctx, r.work, sessionID, backend.Prompt{Text: text}); err != nil {
		r.t.Fatal(err)
	}
	deadline := time.After(2 * time.Minute)
	for {
		select {
		case ev := <-r.events:
			if ev.SessionID != sessionID {
				continue
			}
			if j, err := json.Marshal(ev.Event); err == nil && os.Getenv("GALOPIN_GOOSE_IT_TRACE") != "" {
				t := string(j)
				if len(t) > 400 {
					t = t[:400]
				}
				r.t.Logf("EVENT %s", t)
			}
			switch e := ev.Event; e.Kind {
			case backend.EventPermissionAsked:
				asks = append(asks, *e.Request)
				if err := r.b.ReplyPermission(ctx, r.work, sessionID, e.Request.ID, decision, ""); err != nil {
					r.t.Errorf("reply: %v", err)
				}
			case backend.EventPart:
				if e.Part != nil && e.Part.Role == "assistant" && e.Part.Type == backend.PartText {
					reply = e.Part.Text
				}
			case backend.EventDelta:
				reply += e.Delta
			case backend.EventStatus:
				if e.Status == backend.StatusIdle {
					return asks, reply
				}
			}
		case <-deadline:
			r.t.Fatal("turn timed out")
		}
	}
}

func TestGooseEngineModesAndSessionsAreGalopins(t *testing.T) {
	r := newGooseRig(t)
	ctx := context.Background()
	sess, err := r.b.CreateSession(ctx, r.work, backend.CreateSessionOptions{Title: "it"})
	if err != nil {
		t.Fatal(err)
	}
	if sess.ModeID != "approve" {
		t.Errorf("a new session's mode = %q, want approve", sess.ModeID)
	}
	modes, _ := r.b.Modes(ctx, r.work)
	var ids []string
	for _, m := range modes {
		ids = append(ids, m.ID)
	}
	for _, hidden := range gooseHiddenModes {
		for _, id := range ids {
			if id == hidden {
				t.Errorf("mode %q is offered: %v", hidden, ids)
			}
		}
	}
	if !strings.Contains(strings.Join(ids, ","), "approve") {
		t.Errorf("modes = %v, want approve among them", ids)
	}
	if _, err := r.b.SetMode(ctx, r.work, sess.ID, "auto"); err == nil {
		t.Error("SetMode(auto) was accepted")
	}

	// A plain answer, then the session shows in goose's own list as a user session.
	asks, reply := r.turn(sess.ID, "say hello", backend.DecisionOnce)
	if len(asks) != 0 || !strings.Contains(reply, "mock") {
		t.Errorf("plain turn: asks=%d reply=%q", len(asks), reply)
	}
	cmd := exec.Command(mustGooseBin(t), "session", "list", "--format", "json")
	cmd.Env = r.env
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("goose session list: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), sess.ID) {
		t.Fatalf("goose's own session list does not show %s:\n%s", sess.ID, out)
	}
	var rows []map[string]any
	if err := json.Unmarshal(out, &rows); err != nil {
		t.Fatalf("goose session list --format json: %v\n%s", err, out)
	}
	found := false
	for _, row := range rows {
		if row["id"] == sess.ID {
			found = true
			if row["session_type"] != "user" {
				t.Errorf("session type = %v, want user (visible in goose Desktop)", row["session_type"])
			}
		}
	}
	if !found {
		t.Errorf("session %s not in goose's list", sess.ID)
	}
}

// useITGoose points galopin at the goose on PATH (CI installs the pinned or the
// latest one there): the only way to run a goose other than the verified copy.
func useITGoose(t *testing.T) {
	t.Helper()
	if os.Getenv(gooseEnvOverride) != "" {
		return
	}
	if p, err := exec.LookPath("goose"); err == nil {
		t.Setenv(gooseEnvOverride, p)
	}
}

func mustGooseBin(t *testing.T) string {
	t.Helper()
	useITGoose(t)
	b, err := gooseBinary()
	if err != nil {
		t.Skip(err)
	}
	return b
}

func TestGooseEngineAsksForEveryToolCall(t *testing.T) {
	r := newGooseRig(t)
	sess, err := r.b.CreateSession(context.Background(), r.work, backend.CreateSessionOptions{Title: "asks"})
	if err != nil {
		t.Fatal(err)
	}
	// The model asks for a shell command; once the command is in the
	// conversation it answers in text.
	r.scenario(mockllm.Scenario{
		ToolCalls:    []mockllm.ToolCall{{ID: "call_1", Name: "shell", Arguments: `{"command":"echo galopin-sum-result"}`}},
		FinishReason: "tool_calls",
		Routes:       []mockllm.Route{{Contains: "galopin-sum-result", Scenario: mockllm.Scenario{Content: []string{"the answer is galopin-sum-result"}, FinishReason: "stop"}}},
	})
	asks, reply := r.turn(sess.ID, "run the sum", backend.DecisionOnce)
	if len(asks) == 0 {
		t.Fatalf("goose ran a tool without asking (reply %q): the approve mode is not holding", reply)
	}
	key, _ := r.b.(interface {
		NormalizeAsk(backend.PermissionRequest) (string, []string)
	}).NormalizeAsk(asks[0])
	t.Logf("ask: tool=%q title=%q class=%q", asks[0].Tool, asks[0].Title, key)
	if !strings.Contains(reply, "galopin-sum-result") {
		t.Errorf("reply after an allowed tool = %q", reply)
	}

	// A rejected ask: the tool must not run, and the turn still ends.
	r.scenario(mockllm.Scenario{
		ToolCalls:    []mockllm.ToolCall{{ID: "call_2", Name: "shell", Arguments: `{"command":"echo galopin-second"}`}},
		FinishReason: "tool_calls",
		Routes:       []mockllm.Route{{Contains: "galopin-second", Scenario: mockllm.Scenario{Content: []string{"it was refused"}, FinishReason: "stop"}}},
	})
	asks, reply = r.turn(sess.ID, "run it again", backend.DecisionReject)
	if len(asks) == 0 {
		t.Fatal("the second tool call was not asked")
	}
	if !strings.Contains(reply, "refused") {
		t.Errorf("reply after a rejected ask = %q", reply)
	}
}

// fakeLocalSource is a one-tool localmcp.Source that records its calls.
type fakeLocalSource struct{ calls chan string }

func (f *fakeLocalSource) Tools(context.Context) []localmcp.Tool {
	return []localmcp.Tool{{Name: "echo-say", Description: "Echo a message back.",
		Schema: json.RawMessage(`{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}`)}}
}

func (f *fakeLocalSource) Call(_ context.Context, name string, args json.RawMessage) (string, error) {
	var a struct {
		Message string `json:"message"`
	}
	_ = json.Unmarshal(args, &a)
	f.calls <- name + ":" + a.Message
	return "echoed:" + a.Message, nil
}

// goose, set up as 'galopin goose setup' sets up the user's own goose, uses the
// proxy's provider and the "Cerea connectors" extension (galopin's local
// endpoint, here with a fake source): a model-requested tool call reaches it.
func TestGooseSetupProviderAndLocalAgentsExtension(t *testing.T) {
	if os.Getenv("GALOPIN_GOOSE_IT") == "" {
		t.Skip("set GALOPIN_GOOSE_IT=1 (and have goose on PATH) to run the goose engine tests")
	}
	bin := mustGooseBin(t)
	home := t.TempDir()
	cfgDir := filepath.Join(home, ".config", "goose")
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", "")
	t.Setenv("GOOSE_PATH_ROOT", "")

	mock := httptest.NewServer(mockllm.New())
	t.Cleanup(mock.Close)
	port := mock.Listener.Addr().(*net.TCPAddr).Port
	src := &fakeLocalSource{calls: make(chan string, 4)}
	mux := http.NewServeMux()
	mux.Handle(localmcp.Path, localmcp.Handler("ext-secret", src, "test"))
	ext := httptest.NewServer(mux)
	t.Cleanup(ext.Close)

	// Exactly what setup writes.
	provider, err := gooseProviderJSON("127.0.0.1:"+strconv.Itoa(port), "it-secret", []gooseModel{{ID: "mock-model", Context: 8000}}, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(cfgDir, "custom_providers"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(gooseProviderPath(cfgDir), provider, 0o600); err != nil {
		t.Fatal(err)
	}
	spec := newGooseExt(ext.URL+localmcp.Path, "ext-secret")
	cfg, err := applyGooseConfig("", &gooseSidecar{Was: map[string]*string{}, Set: map[string]string{}}, true, gooseProviderID, "mock-model", &spec)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfgDir, "config.yaml"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}

	body, _ := json.Marshal(map[string]any{"scenario": mockllm.Scenario{
		ToolCalls:    []mockllm.ToolCall{{ID: "call_9", Name: "cereaconnectors__echo-say", Arguments: `{"message":"hi-galopin"}`}},
		FinishReason: "tool_calls",
		Routes:       []mockllm.Route{{Contains: "echoed:hi-galopin", Scenario: mockllm.Scenario{Content: []string{"done"}, FinishReason: "stop"}}},
	}})
	resp, err := http.Post(mock.URL+"/__control/scenario", "application/json", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	cmd := exec.Command(bin, "run", "-t", "use the echo tool")
	cmd.Env = append(os.Environ(), "HOME="+home, "GOOSE_DISABLE_KEYRING=1", "GOOSE_MODE=auto")
	out, err := cmd.CombinedOutput()
	t.Logf("goose run:\n%s", out)
	if err != nil {
		t.Fatalf("goose run: %v", err)
	}
	select {
	case got := <-src.calls:
		if got != "echo-say:hi-galopin" {
			t.Errorf("the endpoint saw %q", got)
		}
	default:
		t.Error("goose never called the Cerea connectors extension")
	}
}

// galopin's per-session MCP endpoint is offered to goose sessions: the model
// finds galopin's tools (connector_list among them) and its call reaches the
// call function bound to that session.
func TestGooseSessionsGetGalopinsMCPEndpoint(t *testing.T) {
	r := newGooseRig(t)
	type seen struct{ session, tool string }
	calls := make(chan seen, 4)
	srv := mcpserve.New(mcpTools, func(_ context.Context, session, tool string, _ json.RawMessage) (string, error) {
		calls <- seen{session, tool}
		return `{"connectors":[],"marker":"connector-list-reached"}`, nil
	}, "test")
	ts := httptest.NewServer(srv.Handler())
	// goose holds its MCP connection open: stop it before the server closes.
	t.Cleanup(func() { _ = r.b.Stop(); ts.Close() })
	host, ok := r.b.(backend.MCPHost)
	if !ok || !host.MCPCapable() {
		t.Fatal("the goose backend does not offer MCP: it should (mcpCapabilities.http)")
	}
	host.SetMCPIssuer(&mcpGate{srv: srv, base: ts.URL})

	sess, err := r.b.CreateSession(context.Background(), r.work, backend.CreateSessionOptions{Title: "mcp"})
	if err != nil {
		t.Fatal(err)
	}
	r.scenario(mockllm.Scenario{
		ToolCalls:    []mockllm.ToolCall{{ID: "call_c", Name: "galopin__connector_list", Arguments: `{}`}},
		FinishReason: "tool_calls",
		Routes:       []mockllm.Route{{Contains: "connector-list-reached", Scenario: mockllm.Scenario{Content: []string{"listed"}, FinishReason: "stop"}}},
	})
	asks, reply := r.turn(sess.ID, "list the connectors", backend.DecisionOnce)
	t.Logf("asks=%d reply=%q", len(asks), reply)
	select {
	case got := <-calls:
		if got.session != sess.ID || got.tool != "connector_list" {
			t.Errorf("call = %+v, want connector_list as %s", got, sess.ID)
		}
	default:
		t.Fatal("goose never called galopin's connector_list")
	}
	if len(asks) == 0 {
		t.Error("goose called an MCP tool without asking: approve mode must ask for every tool")
	}
}

// Usage is derived from galopin's proxy: goose reports none over ACP, but the
// session gets a usage event after a turn, with the model's context window from
// the provider file the catalogue wrote.
func TestGooseEngineUsageComesFromTheProxy(t *testing.T) {
	var proxy *shim
	r := newGooseRigVia(t, &proxy)
	ctx := context.Background()
	if !r.b.Capabilities().Usage {
		t.Fatal("the goose backend does not advertise usage")
	}
	sess, err := r.b.CreateSession(ctx, r.work, backend.CreateSessionOptions{Title: "usage"})
	if err != nil {
		t.Fatal(err)
	}
	proxy.setSessionTag(func(string) string { return sess.ID })
	if err := r.b.Prompt(ctx, r.work, sess.ID, backend.Prompt{Text: "say hello"}); err != nil {
		t.Fatal(err)
	}
	var got *backend.Usage
	deadline := time.After(2 * time.Minute)
	for got == nil {
		select {
		case ev := <-r.events:
			if ev.SessionID == sess.ID && ev.Event.Kind == backend.EventUsage {
				got = ev.Event.Usage
			}
		case <-deadline:
			t.Fatal("no usage event for the turn")
		}
	}
	if got.Input != 80 || got.CacheRead != 40 || got.Output != 7 || got.ContextUsed != 127 {
		t.Errorf("usage = %+v, want input 80, cache 40, output 7, context 127", got)
	}
	if got.ContextMax == nil || *got.ContextMax <= 0 {
		t.Errorf("no context window: %+v", got)
	}
}

// Compaction over ACP: goose's own /compact, run as a prompt through the
// Compactor the backend offers.
func TestGooseEngineCompacts(t *testing.T) {
	r := newGooseRig(t)
	ctx := context.Background()
	if !r.b.Capabilities().Compact {
		t.Fatal("the goose backend does not advertise compact")
	}
	sess, err := r.b.CreateSession(ctx, r.work, backend.CreateSessionOptions{Title: "compact"})
	if err != nil {
		t.Fatal(err)
	}
	r.turn(sess.ID, "say hello", backend.DecisionOnce)
	if err := r.b.(backend.Compactor).Compact(ctx, r.work, sess.ID); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(time.Minute)
	for {
		select {
		case ev := <-r.events:
			if ev.SessionID == sess.ID && ev.Event.Kind == backend.EventStatus && ev.Event.Status == backend.StatusIdle {
				tr, err := r.b.Transcript(ctx, r.work, sess.ID)
				if err != nil {
					t.Fatal(err)
				}
				last := tr.Messages[len(tr.Messages)-1]
				var text string
				for _, p := range last.Parts {
					text += p.Text
				}
				if !strings.Contains(strings.ToLower(text), "compaction") {
					t.Errorf("last message after compact = %q", text)
				}
				return
			}
		case <-deadline:
			t.Fatal("compaction did not finish")
		}
	}
}
