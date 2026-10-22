package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"galopin/internal/link"
	"galopin/internal/mcpconn"
)

// Local MCP connectors (PROTOCOL.md §10, ADR 0102): the machine serves the
// MCP servers of its own mcp.json to its owner's chat. The traffic itself is
// internal/mcpconn's; this file is the machine's side of it: the ops, the
// frames, the audit line.

// mcpConfigFileName is the connectors file beside credentials.json.
const mcpConfigFileName = "mcp.json"

// startConnectors builds the machine's connector hub from <stateDir>/mcp.json
// and wires it to the link and the audit log. The hub reads mc.lnk when it
// sends, so it may be built before the link exists.
func (mc *machine) startConnectors(stateDir string) *mcpconn.Hub {
	hub := mcpconn.New(mcpconn.Config{
		Path:     filepath.Join(stateDir, mcpConfigFileName),
		StateDir: stateDir,
		Lookup:   os.LookupEnv,
		Logf:     logf,
		// Zero is the 10 minutes of PROTOCOL.md §10.6; tests shorten it.
		IdleTimeout: mc.mcpIdle,
		Audit:       func(server, tool, outcome string) { mc.audit.mcpCall(server, tool, outcome) },
		Send: func(channelID string, message []byte) error {
			if mc.lnk == nil {
				return errNoLink
			}
			return mc.lnk.PublishMcp(channelID, message)
		},
		Closed: func(channelID, reason string, detail *string) {
			if mc.lnk != nil {
				_ = mc.lnk.PublishMcpClosed(channelID, reason, detail)
			}
		},
	})
	mc.mcp = hub
	return hub
}

var errNoLink = errors.New("not connected to Cerea")

// HandleMcp implements link.McpHandler: one C→M mcp frame.
func (mc *machine) HandleMcp(channelID string, message json.RawMessage) {
	if mc.mcp != nil {
		mc.mcp.Message(channelID, message)
	}
}

// LinkDown implements link.McpHandler: the link dropped, so every channel
// closes (PROTOCOL.md §10.6).
func (mc *machine) LinkDown() {
	if mc.mcp != nil {
		mc.mcp.LinkDown()
	}
}

var _ link.McpHandler = (*machine)(nil)

// opMcp answers mcp.list, mcp.open and mcp.close (PROTOCOL.md §10.3).
func (mc *machine) opMcp(ctx context.Context, op string, args json.RawMessage) (any, *link.OpError) {
	switch op {
	case "mcp.list":
		servers := []mcpconn.ServerView{}
		if mc.mcp != nil {
			servers = mc.mcp.List()
		}
		return map[string]any{"servers": servers}, nil
	case "mcp.open":
		var a struct {
			Server string `json:"server"`
		}
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, invalidArgs(err)
		}
		if a.Server == "" {
			return nil, invalidArgs(errors.New("server is required"))
		}
		if mc.mcp == nil {
			return nil, opErrf("not_found", "no connector named %s", a.Server)
		}
		id, oerr := mc.mcp.Open(ctx, a.Server)
		if oerr != nil {
			return nil, &link.OpError{Code: oerr.Code, Message: oerr.Message}
		}
		return map[string]any{"channelId": id}, nil
	case "mcp.close":
		var a struct {
			ChannelID string `json:"channelId"`
		}
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, invalidArgs(err)
		}
		if mc.mcp != nil && a.ChannelID != "" {
			mc.mcp.Close(a.ChannelID)
		}
		return map[string]any{}, nil
	}
	return nil, opErrf("unsupported", "unknown op %q", op)
}
