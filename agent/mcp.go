package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync/atomic"
	"time"

	"galopin/internal/backend"
	"galopin/internal/mcpserve"
)

// galopin's MCP server (PROTOCOL.md §6, "Coordination tools over MCP"): the
// coordination tools offered to an MCP-capable agent, one endpoint and token
// per session. The proof of who is calling is the token (agent identity never
// travels in an MCP call), so a call goes to agentTools.dispatch, which runs
// the same decision function, rate limits, cards and report-back as the
// opencode route; only the tool-part check of handle is replaced.

// mcpGate is the running server.
type mcpGate struct {
	srv  *mcpserve.Server
	http *http.Server
	ln   net.Listener
	base string
}

// mcpCallSeq numbers MCP calls for the audit and the card ("mcp-<n>"): an MCP
// call has no call id the machine can match to the agent's own.
var mcpCallSeq atomic.Uint64

// startMCP starts the MCP server when the backend hands its agents MCP
// servers (backend.MCPHost) and the machine's tools are on; nil otherwise.
func (mc *machine) startMCP() (*mcpGate, error) {
	host, ok := mc.back.(backend.MCPHost)
	if !ok || mc.agentTools == nil || !host.MCPCapable() {
		return nil, nil
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("mcp: listening: %w", err)
	}
	g := &mcpGate{ln: ln, base: "http://" + ln.Addr().String()}
	g.srv = mcpserve.New(mcpTools, mc.agentTools.mcpCall, "1")
	mux := http.NewServeMux()
	mux.Handle(mcpserve.PathPrefix, g.srv.Handler())
	g.http = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := g.http.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logf("mcp: server stopped: %v", err)
		}
	}()
	host.SetMCPIssuer(g)
	return g, nil
}

// Mint implements backend.MCPIssuer.
func (g *mcpGate) Mint() backend.MCPEndpoint { return mcpEndpoint{g.srv.Mint(g.base)} }

// RevokeSession implements backend.MCPIssuer.
func (g *mcpGate) RevokeSession(id string) { g.srv.RevokeSession(id) }

// Close ends every endpoint and stops serving.
func (g *mcpGate) Close() {
	g.srv.RevokeAll()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = g.http.Shutdown(ctx)
}

type mcpEndpoint struct{ g *mcpserve.Grant }

func (e mcpEndpoint) URL() string           { return e.g.URL }
func (e mcpEndpoint) Token() string         { return e.g.Token }
func (e mcpEndpoint) Bind(sessionID string) { e.g.Bind(sessionID) }
func (e mcpEndpoint) Revoke()               { e.g.Revoke() }

// mcpCall is the mcpserve.CallFunc: the session is the token's, the rest runs
// as a relayed call. A refusal reads as in the opencode route: the same JSON
// object, {"refused": reason}.
func (at *agentTools) mcpCall(ctx context.Context, sessionID, tool string, args json.RawMessage) (string, error) {
	out, err := at.dispatch(ctx, backend.ToolCall{
		Tool: tool, SessionID: sessionID, CallID: fmt.Sprintf("mcp-%d", mcpCallSeq.Add(1)), Args: args,
	})
	if err == nil {
		return out, nil
	}
	var refusal *backend.ToolRefusal
	if errors.As(err, &refusal) {
		body, _ := json.Marshal(map[string]string{"refused": refusal.Message})
		return "", errors.New(string(body))
	}
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	logf("mcp: tool %s failed: %v", tool, err)
	body, _ := json.Marshal(map[string]string{"refused": "galopin could not complete this tool call"})
	return "", errors.New(string(body))
}
