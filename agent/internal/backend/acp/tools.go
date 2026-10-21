package acp

// galopin's coordination tools for an ACP agent (PROTOCOL.md §6, "Coordination
// tools over MCP"). ACP's session/new takes the MCP servers the agent should
// use, per session, so galopin hands each session its own endpoint and token;
// the calls come back to galopin's MCP server, which runs the machine's gates.
// This file is the backend's half: the endpoint per session, galopin's own
// approvals (the gp_ asks), and the spawn markers.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"sync"

	"galopin/internal/backend"
)

// galopinAskPrefix marks a permission request id galopin minted; the same
// prefix the opencode backend uses, so one answer path serves both.
const galopinAskPrefix = "gp_"

type pendingAsk struct {
	sessionID string
	answer    chan askAnswer
}

type askAnswer struct {
	decision backend.Decision
	message  string
}

// toolState is the tool subsystem's per-process state.
type toolState struct {
	mu      sync.Mutex
	issuer  backend.MCPIssuer
	handler backend.ToolHandler
	asks    map[string]*pendingAsk
}

// MCPCapable implements backend.MCPHost: tools are on, and the agent said it
// can use an HTTP MCP server.
func (b *Backend) MCPCapable() bool {
	b.infoMu.Lock()
	defer b.infoMu.Unlock()
	return b.cfg.Tools && b.agentCaps.mcpHTTP
}

// SetMCPIssuer implements backend.MCPHost.
func (b *Backend) SetMCPIssuer(i backend.MCPIssuer) {
	b.tools.mu.Lock()
	b.tools.issuer = i
	b.tools.mu.Unlock()
}

func (b *Backend) mcpIssuer() backend.MCPIssuer {
	b.tools.mu.Lock()
	defer b.tools.mu.Unlock()
	return b.tools.issuer
}

// mcpServers is the session/new (or session/load) "mcpServers" entry for a
// session about to exist, and the endpoint to bind to its id. An agent that
// cannot use HTTP MCP, or tools turned off, gets none.
func (b *Backend) mcpServers() ([]any, backend.MCPEndpoint) {
	issuer := b.mcpIssuer()
	if issuer == nil || !b.MCPCapable() {
		return []any{}, nil
	}
	ep := issuer.Mint()
	return []any{map[string]any{
		"type":    "http",
		"name":    "galopin",
		"url":     ep.URL(),
		"headers": []any{map[string]any{"name": "Authorization", "value": "Bearer " + ep.Token()}},
	}}, ep
}

// adoptMCP binds a minted endpoint to the session it was made for, and keeps
// it so deleting the session revokes it. A nil endpoint is a no-op.
func (b *Backend) adoptMCP(st *sessionState, ep backend.MCPEndpoint) {
	if ep == nil {
		return
	}
	ep.Bind(st.id)
	st.mu.Lock()
	old := st.mcp
	st.mcp = ep
	st.mu.Unlock()
	if old != nil {
		old.Revoke()
	}
}

// SetToolHandler implements backend.ToolHost. The MCP server calls the machine
// directly, so the handler is only remembered.
func (b *Backend) SetToolHandler(h backend.ToolHandler) {
	b.tools.mu.Lock()
	b.tools.handler = h
	b.tools.mu.Unlock()
}

// SpawnMarks implements backend.ToolHost.
func (b *Backend) SpawnMarks() map[string]backend.SpawnedBy {
	out := map[string]backend.SpawnedBy{}
	for _, st := range b.reg.all() {
		st.mu.Lock()
		if st.spawnedBy != nil {
			out[st.id] = *st.spawnedBy
		}
		st.mu.Unlock()
	}
	return out
}

// Ask implements backend.ToolHost: galopin's own approval, held here until a
// person answers through ReplyPermission or ctx is cancelled.
func (b *Backend) Ask(ctx context.Context, workspaceDir, sessionID string, req backend.PermissionRequest) (backend.Decision, string, error) {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	req.ID = galopinAskPrefix + hex.EncodeToString(raw)
	req.SessionID = sessionID
	if req.Metadata == nil {
		req.Metadata = map[string]any{}
	}
	req.Metadata["galopin"] = true
	req.Always = nil
	pa := &pendingAsk{sessionID: sessionID, answer: make(chan askAnswer, 1)}
	b.tools.mu.Lock()
	if b.tools.asks == nil {
		b.tools.asks = map[string]*pendingAsk{}
	}
	b.tools.asks[req.ID] = pa
	b.tools.mu.Unlock()
	b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventPermissionAsked, Request: &req})
	select {
	case a := <-pa.answer:
		return a.decision, a.message, nil
	case <-ctx.Done():
		// The call was aborted (the turn was cancelled, the endpoint revoked):
		// withdraw the ask so no card is left for a call that is gone.
		if _, held := b.claimAsk(req.ID); held {
			b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventPermissionReplied, RequestID: req.ID, Decision: backend.DecisionReject, By: "user"})
		}
		return "", "", ctx.Err()
	}
}

// claimAsk removes and returns a held ask, once: whichever of a reply or a
// withdrawal gets it first wins.
func (b *Backend) claimAsk(id string) (*pendingAsk, bool) {
	b.tools.mu.Lock()
	defer b.tools.mu.Unlock()
	pa, ok := b.tools.asks[id]
	delete(b.tools.asks, id)
	return pa, ok
}

// replyGalopinAsk answers a held gp_ ask; "always" is read as once.
func (b *Backend) replyGalopinAsk(workspaceDir, sessionID, requestID string, decision backend.Decision, message string) error {
	pa, ok := b.claimAsk(requestID)
	if !ok || pa.sessionID != sessionID {
		if ok { // another session's ask: put it back, answer nothing
			b.tools.mu.Lock()
			b.tools.asks[requestID] = pa
			b.tools.mu.Unlock()
		}
		return backend.ErrPermissionGone
	}
	if decision == backend.DecisionAlways {
		decision = backend.DecisionOnce
	}
	if decision != backend.DecisionOnce {
		decision = backend.DecisionReject
	}
	pa.answer <- askAnswer{decision: decision, message: message}
	b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventPermissionReplied, RequestID: requestID, Decision: decision, By: "user"})
	return nil
}

func isGalopinAsk(id string) bool { return strings.HasPrefix(id, galopinAskPrefix) }
