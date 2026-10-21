package mcpserve

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type bearer struct{ token string }

func (b bearer) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(req)
}

func start(t *testing.T, call CallFunc) (*Server, string) {
	t.Helper()
	s := New([]Tool{{Name: "echo", Description: "d", Schema: json.RawMessage(`{"type":"object"}`)}}, call, "t")
	mux := http.NewServeMux()
	mux.Handle(PathPrefix, s.Handler())
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return s, ts.URL
}

func connect(t *testing.T, g *Grant) *mcp.ClientSession {
	t.Helper()
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "c", Version: "1"}, nil).Connect(context.Background(),
		&mcp.StreamableClientTransport{Endpoint: g.URL, HTTPClient: &http.Client{Transport: bearer{g.Token}}, MaxRetries: -1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return cs
}

func TestCallRunsAsTheBoundSessionWithTheArguments(t *testing.T) {
	var gotSession, gotTool string
	var gotArgs json.RawMessage
	s, base := start(t, func(_ context.Context, session, tool string, args json.RawMessage) (string, error) {
		gotSession, gotTool, gotArgs = session, tool, args
		return "pong", nil
	})
	g := s.Mint(base)
	g.Bind("s1")
	g.Bind("s2") // once only
	res, err := connect(t, g).CallTool(context.Background(), &mcp.CallToolParams{Name: "echo", Arguments: map[string]any{"a": 1}})
	if err != nil || res.IsError {
		t.Fatalf("%v %+v", err, res)
	}
	if gotSession != "s1" || gotTool != "echo" || !strings.Contains(string(gotArgs), `"a":1`) {
		t.Fatalf("call = %q %q %s", gotSession, gotTool, gotArgs)
	}
}

func TestErrorBecomesAToolError(t *testing.T) {
	s, base := start(t, func(context.Context, string, string, json.RawMessage) (string, error) {
		return "", context.DeadlineExceeded
	})
	g := s.Mint(base)
	g.Bind("s1")
	res, err := connect(t, g).CallTool(context.Background(), &mcp.CallToolParams{Name: "echo"})
	if err != nil || !res.IsError {
		t.Fatalf("%v %+v", err, res)
	}
}

func TestRevokeCancelsACallInFlightAndClosesTheEndpoint(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	s, base := start(t, func(ctx context.Context, _, _ string, _ json.RawMessage) (string, error) {
		close(started)
		<-ctx.Done()
		close(cancelled)
		return "", ctx.Err()
	})
	g := s.Mint(base)
	g.Bind("s1")
	cs := connect(t, g)
	go func() { _, _ = cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "echo"}) }()
	<-started
	if s.Live() != 1 {
		t.Fatalf("live = %d", s.Live())
	}
	s.RevokeSession("s1")
	select {
	case <-cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("the held call was not cancelled by the revoke")
	}
	if s.Live() != 0 {
		t.Fatalf("live = %d after revoke", s.Live())
	}
	g.Revoke() // idempotent
	req, _ := http.NewRequest(http.MethodPost, g.URL, strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer "+g.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("revoked endpoint answered %d", resp.StatusCode)
	}
}

func TestTokensAndEndpointsAreUnique(t *testing.T) {
	s, base := start(t, nil)
	a, b := s.Mint(base), s.Mint(base)
	if a.Token == b.Token || a.URL == b.URL || len(a.Token) < 64 {
		t.Fatalf("grants are not distinct or too short: %+v %+v", a, b)
	}
	if strings.Contains(a.URL, a.Token) {
		t.Fatal("the token is in the URL")
	}
	s.RevokeAll()
	if s.Live() != 0 {
		t.Fatal("RevokeAll left grants")
	}
}
