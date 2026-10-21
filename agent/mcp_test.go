package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"galopin/internal/backend"
	"galopin/internal/permrules"
)

// The coordination tools over MCP (PROTOCOL.md §6): driven end to end with the
// SDK's own client against galopin's real MCP server and the coordination rig,
// so the decision function, the cards and the report-back are the production
// ones.

func (c *coordBackend) MCPCapable() bool                 { return true }
func (c *coordBackend) SetMCPIssuer(i backend.MCPIssuer) { c.issuer = i }

var _ backend.MCPHost = (*coordBackend)(nil)

type mcpRig struct {
	*coordRig
	gate *mcpGate
}

func newMCPRig(t *testing.T, _ any) *mcpRig {
	t.Helper()
	r := reportRig(t)
	gate, err := r.mc.startMCP()
	if err != nil || gate == nil {
		t.Fatalf("startMCP: %v %v", gate, err)
	}
	t.Cleanup(gate.Close)
	return &mcpRig{coordRig: r, gate: gate}
}

// endpoint mints a grant bound to a session and connects a real MCP client
// carrying its token.
func (r *mcpRig) client(session string) (*mcp.ClientSession, backend.MCPEndpoint) {
	r.t.Helper()
	ep := r.gate.Mint()
	if session != "" {
		ep.Bind(session)
	}
	return r.connect(ep), ep
}

type bearer struct{ token string }

func (b bearer) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	if b.token != "" {
		req.Header.Set("Authorization", "Bearer "+b.token)
	}
	return http.DefaultTransport.RoundTrip(req)
}

func (r *mcpRig) connect(ep backend.MCPEndpoint) *mcp.ClientSession {
	r.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil).Connect(ctx,
		&mcp.StreamableClientTransport{Endpoint: ep.URL(), HTTPClient: &http.Client{Transport: bearer{ep.Token()}}, MaxRetries: -1}, nil)
	if err != nil {
		r.t.Fatalf("connect: %v", err)
	}
	r.t.Cleanup(func() { _ = cs.Close() })
	return cs
}

func callTool(t *testing.T, cs *mcp.ClientSession, tool string, args map[string]any) (string, bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", tool, err)
	}
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String(), res.IsError
}

func TestMCPListsTheCoordinationTools(t *testing.T) {
	r := newMCPRig(t, nil)
	cs, _ := r.client("caller")
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, tl := range res.Tools {
		got[tl.Name] = true
	}
	for _, want := range []string{"session_list", "session_read", "session_spawn", "session_send", "schedule_list", "schedule_create", "schedule_update", "schedule_delete"} {
		if !got[want] {
			t.Errorf("tool %s not offered (got %v)", want, got)
		}
	}
	if len(res.Tools) != len(mcpTools) {
		t.Errorf("tools = %d, want %d", len(res.Tools), len(mcpTools))
	}
}

func TestMCPToolSchemasAreObjectSchemas(t *testing.T) {
	for _, tl := range mcpTools {
		var m map[string]any
		if err := json.Unmarshal(tl.Schema, &m); err != nil || m["type"] != "object" {
			t.Errorf("%s: schema is not a JSON object schema: %v", tl.Name, err)
		}
	}
}

func TestMCPAuthRejectsMissingWrongAndOtherSessionTokens(t *testing.T) {
	r := newMCPRig(t, nil)
	a, b := r.gate.Mint(), r.gate.Mint()
	a.Bind("caller")
	b.Bind("peer")
	post := func(url, token, host string) int {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if host != "" {
			req.Host = host
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	for name, c := range map[string]struct {
		url, token, host string
	}{
		"no token":                {a.URL(), "", ""},
		"wrong token":             {a.URL(), "nope", ""},
		"another session's token": {a.URL(), b.Token(), ""},
		"unknown endpoint":        {r.gate.base + "/mcp/00ff", a.Token(), ""},
		"no endpoint":             {r.gate.base + "/mcp/", a.Token(), ""},
		"not an endpoint":         {r.gate.base + "/", a.Token(), ""},
	} {
		if got := post(c.url, c.token, c.host); got != http.StatusUnauthorized && got != http.StatusNotFound {
			t.Errorf("%s: status %d, want 401", name, got)
		}
	}
	if got := post(a.URL(), a.Token(), "evil.example"); got != http.StatusForbidden {
		t.Errorf("a non-loopback Host: status %d, want 403", got)
	}
	if got := post(a.URL(), a.Token(), ""); got != http.StatusOK {
		t.Errorf("the right token: status %d, want 200", got)
	}
	// Revoked: the same token no longer works.
	a.Revoke()
	if got := post(a.URL(), a.Token(), ""); got != http.StatusUnauthorized {
		t.Errorf("a revoked token: status %d, want 401", got)
	}
	r.gate.RevokeSession("peer")
	if got := post(b.URL(), b.Token(), ""); got != http.StatusUnauthorized {
		t.Errorf("a session whose endpoints were revoked: status %d, want 401", got)
	}
}

func TestMCPTokenActsOnlyAsItsOwnSession(t *testing.T) {
	r := newMCPRig(t, nil)
	cs, _ := r.client("caller")
	// Identity is never an argument: a caller cannot name another session as itself.
	out, isErr := callTool(t, cs, "session_read", map[string]any{"target": "peer", "sessionId": "peer"})
	if !isErr || !strings.Contains(out, "unsupported argument") {
		t.Fatalf("a forged identity argument: %v %q", isErr, out)
	}
	// And the session it is bound to is the one the gates see: reading yourself is refused.
	out, isErr = callTool(t, cs, "session_read", map[string]any{"target": "caller"})
	if !isErr || !strings.Contains(out, "cannot read your own session") {
		t.Fatalf("read of itself: %v %q", isErr, out)
	}
	// session_list is the bound session's view.
	out, isErr = callTool(t, cs, "session_list", nil)
	if isErr || !strings.Contains(out, `"sessionId":"peer"`) || !strings.Contains(out, "your own session tree") {
		t.Fatalf("list: %v %q", isErr, out)
	}
}

func TestMCPUnboundEndpointRunsNothing(t *testing.T) {
	r := newMCPRig(t, nil)
	cs, ep := r.client("")
	out, isErr := callTool(t, cs, "session_list", nil)
	if !isErr || !strings.Contains(out, "not ready") {
		t.Fatalf("unbound: %v %q", isErr, out)
	}
	ep.Bind("caller")
	if out, isErr = callTool(t, cs, "session_list", nil); isErr {
		t.Fatalf("after bind: %q", out)
	}
}

func TestMCPCallThatNeedsApprovalRaisesTheSameCard(t *testing.T) {
	r := newMCPRig(t, nil)
	r.say("peer", "assistant", "the secret plan", t0)
	cs, _ := r.client("caller")
	out, isErr := callTool(t, cs, "session_read", map[string]any{"target": "peer"})
	if isErr || !strings.Contains(out, "the secret plan") {
		t.Fatalf("approved read: %v %q", isErr, out)
	}
	a := r.asks()
	if len(a) != 1 || a[0].Tool != "session_read" || a[0].SessionID != "" && a[0].SessionID != "caller" {
		t.Fatalf("asks = %+v, want one session_read card", a)
	}
	// Declined: the model reads the person's refusal in the same shape as the opencode route.
	r.cb.mu.Lock()
	r.cb.answer = func(backend.PermissionRequest) (backend.Decision, string) { return backend.DecisionReject, "not now" }
	r.cb.mu.Unlock()
	out, isErr = callTool(t, cs, "session_read", map[string]any{"target": "peer"})
	if !isErr || !strings.Contains(out, `{"refused":`) || !strings.Contains(out, "declined") || !strings.Contains(out, "not now") {
		t.Fatalf("declined read: %v %q", isErr, out)
	}
}

func TestMCPGoesThroughTheDecisionFunction(t *testing.T) {
	// Plan (deny) refuses; a machine allow with the session's own Allow runs unasked.
	r := newMCPRig(t, nil)
	r.cb.mu.Lock()
	r.cb.sel["caller"] = permrules.Selector{Mode: permrules.Deny}
	r.cb.mu.Unlock()
	cs, _ := r.client("caller")
	out, isErr := callTool(t, cs, "session_spawn", map[string]any{"title": "T", "prompt": "do it"})
	if !isErr || !strings.Contains(out, `{"refused":`) {
		t.Fatalf("spawn under Plan: %v %q", isErr, out)
	}
	if a := r.asks(); len(a) != 0 {
		t.Fatalf("a Plan refusal raised cards: %+v", a)
	}
	r.cb.mu.Lock()
	r.cb.sel["caller"] = permrules.Selector{Mode: permrules.Allow}
	r.cb.mu.Unlock()
	out, isErr = callTool(t, cs, "session_spawn", map[string]any{"title": "T", "prompt": "do it"})
	if isErr || !strings.Contains(out, "autoApproved") {
		t.Fatalf("spawn under Allow: %v %q", isErr, out)
	}
	if a := r.asks(); len(a) != 0 {
		t.Fatalf("an Allow spawn raised cards: %+v", a)
	}
}

func TestMCPMachineCeilingStillCaps(t *testing.T) {
	r := newCoordRig(t, withMax("session_read", "deny"))
	r.mc.agentTools.async = func(f func()) { f() }
	gate, err := r.mc.startMCP()
	if err != nil || gate == nil {
		t.Fatal(err)
	}
	t.Cleanup(gate.Close)
	m := &mcpRig{coordRig: r, gate: gate}
	cs, _ := m.client("caller")
	out, isErr := callTool(t, cs, "session_read", map[string]any{"target": "peer"})
	if !isErr || !strings.Contains(out, "do not allow") {
		t.Fatalf("ceiling deny: %v %q", isErr, out)
	}
}

func TestMCPDelegateReportBackReachesTheCaller(t *testing.T) {
	r := newMCPRig(t, nil)
	cs, _ := r.client("caller")
	out, isErr := callTool(t, cs, "session_spawn", map[string]any{"title": "Fixer", "prompt": "fix the parser"})
	if isErr {
		t.Fatalf("spawn: %q", out)
	}
	var res struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal([]byte(out), &res); err != nil || res.SessionID == "" {
		t.Fatalf("spawn result %q: %v", out, err)
	}
	// The delegate may be read with no card, and the same token reads it.
	r.finishTurn(res.SessionID, "Parser fixed; tests pass.")
	got := r.toCaller()
	if len(got) != 1 || !strings.Contains(got[0].prompt.Text, "Report from Fixer") || !strings.Contains(got[0].prompt.Text, "Parser fixed; tests pass.") {
		t.Fatalf("report to the spawner: %+v", got)
	}
	if n := len(r.asks()); n != 1 { // the spawn's own card, nothing for the report
		t.Fatalf("asks = %d, want 1", n)
	}
	out, isErr = callTool(t, cs, "session_read", map[string]any{"target": res.SessionID})
	if isErr || !strings.Contains(out, "Parser fixed") {
		t.Fatalf("read of the delegate: %v %q", isErr, out)
	}
	if n := len(r.asks()); n != 1 {
		t.Fatalf("a spawner's read of its delegate raised a card (asks = %d)", n)
	}
}

func TestMCPCallsAreAudited(t *testing.T) {
	r := newMCPRig(t, nil)
	cs, _ := r.client("caller")
	callTool(t, cs, "session_list", nil)
	var found bool
	for _, row := range r.audit() {
		if row["tool"] == "session_list" && row["from"] == "caller" && row["decision"] == "done" {
			found = true
		}
	}
	if !found {
		t.Fatalf("no audit row for the call: %v", r.audit())
	}
}
