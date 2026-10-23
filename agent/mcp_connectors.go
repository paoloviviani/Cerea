package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"galopin/internal/link"
	"galopin/internal/mcpconn"
)

// Local MCP connectors (PROTOCOL.md §10, ADR 0102): the machine serves the
// MCP servers of its own mcp.json to its owner's chat. The traffic itself is
// internal/mcpconn's; this file is the machine's side of it: the ops, the
// frames, the audit line.

// mcpConfigFileName is the connectors file beside credentials.json.
const mcpConfigFileName = "mcp.json"

// mcpConfigEnv names the environment variable that points galopin at another
// connectors file; --mcp-config wins over it.
const mcpConfigEnv = "GALOPIN_MCP_CONFIG"

// resolveMcpConfig picks the connectors file: --mcp-config, else
// $GALOPIN_MCP_CONFIG, else <stateDir>/mcp.json. A leading ~ is the home
// directory and a relative path is taken from the current directory at start.
// An explicit file must exist (the default may be absent). explicit says which.
func resolveMcpConfig(flagValue string, getenv func(string) string, stateDir string) (path string, explicit bool, err error) {
	src, raw := "--mcp-config", flagValue
	if raw == "" {
		src, raw = mcpConfigEnv, getenv(mcpConfigEnv)
	}
	if raw == "" {
		return filepath.Join(stateDir, mcpConfigFileName), false, nil
	}
	p := raw
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, "~"+string(filepath.Separator)) {
		home, herr := os.UserHomeDir()
		if herr != nil {
			return "", true, fmt.Errorf("%s %q: locating the home directory: %w", src, raw, herr)
		}
		p = filepath.Join(home, p[1:])
	}
	abs, aerr := filepath.Abs(p)
	if aerr != nil {
		return "", true, fmt.Errorf("%s %q: %w", src, raw, aerr)
	}
	st, serr := os.Stat(abs)
	if serr != nil {
		if os.IsNotExist(serr) {
			return "", true, fmt.Errorf("%s: no such file: %s", src, abs)
		}
		return "", true, fmt.Errorf("%s %s: %w", src, abs, serr)
	}
	if st.IsDir() {
		return "", true, fmt.Errorf("%s: %s is a directory, not a file", src, abs)
	}
	return abs, true, nil
}

// startConnectors builds the machine's connector hub from mcpPath
// and wires it to the link and the audit log. The hub reads mc.lnk when it
// sends, so it may be built before the link exists.
func (mc *machine) startConnectors(stateDir, mcpPath string) *mcpconn.Hub {
	hub := mcpconn.New(mcpconn.Config{
		Path:     mcpPath,
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

// opMcp answers mcp.list, mcp.open, mcp.close, mcp.login and mcp.loginComplete (PROTOCOL.md §10.3).
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
	case "mcp.login":
		var a struct {
			Server      string `json:"server"`
			RedirectURI string `json:"redirectUri"`
		}
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, invalidArgs(err)
		}
		if mc.mcp == nil {
			return nil, opErrf("not_found", "no connector named %s", a.Server)
		}
		u, oerr := mc.mcp.Login(ctx, a.Server, a.RedirectURI)
		if oerr != nil {
			return nil, &link.OpError{Code: oerr.Code, Message: oerr.Message}
		}
		return map[string]any{"authorizationUrl": u}, nil
	case "mcp.loginComplete":
		var a struct {
			Server string `json:"server"`
			Code   string `json:"code"`
			State  string `json:"state"`
		}
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, invalidArgs(err)
		}
		if mc.mcp == nil {
			return nil, opErrf("not_found", "no connector named %s", a.Server)
		}
		if oerr := mc.mcp.LoginComplete(ctx, a.Server, a.Code, a.State); oerr != nil {
			return nil, &link.OpError{Code: oerr.Code, Message: oerr.Message}
		}
		return map[string]any{}, nil
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
