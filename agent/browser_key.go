package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"galopin/internal/link"
	"galopin/internal/mcpconn"
)

// The approval key of the browser runtime (PROTOCOL.md §10.7). Cerea signs each approval for a
// commit-class browser action with a per-device key; the runtime checks the signature. galopin
// fetches the key over the authenticated link (`browser.key`) whenever the runtime is about to be
// started, writes it to <state dir>/browser/key (0600) for the runtime to read, and never logs it.

const browserKeyFamily = "browser"

type browserKeyCaller struct {
	WorkspaceID    string   `json:"workspaceId"`
	PermissionMode string   `json:"permissionMode"`
	Coordination   []string `json:"coordination"`
}

// browserKeyCalls makes the one machine call of the browser family. The frame is the one
// protocol-fixtures/calls/browser.key.call.json documents: a machine-level call, not a session's,
// so the session ids are the fixed word "browser".
type browserKeyCalls struct{}

func (browserKeyCalls) browserCall(ctx context.Context, calls machineCaller, op string) (json.RawMessage, *link.OpError) {
	return calls.Call(ctx, link.Call{
		Op: op, SessionID: "browser", RootSessionID: "browser",
		Caller:  browserKeyCaller{PermissionMode: "ask", Coordination: []string{}},
		Args:    map[string]any{},
		Timeout: 20 * time.Second,
	})
}

// fetchBrowserKey asks Cerea for this machine's key and stores it at path.
func fetchBrowserKey(ctx context.Context, calls machineCaller, path string) *mcpconn.OpenError {
	if calls == nil {
		return &mcpconn.OpenError{Code: "unavailable", Message: "Cerea is not reachable from this machine right now, so the browser cannot get its approval key; try again in a moment"}
	}
	if !calls.Supports(browserKeyFamily) {
		return &mcpconn.OpenError{Code: "unavailable", Message: "this Cerea does not support browser use; update it"}
	}
	res, operr := browserKeyCalls{}.browserCall(ctx, calls, "browser.key")
	if operr != nil {
		code := "unavailable"
		if operr.Code == "forbidden" {
			code = "forbidden"
		}
		return &mcpconn.OpenError{Code: code, Message: "Cerea would not give the browser its approval key: " + operr.Message}
	}
	var r struct {
		Key string `json:"key"`
		Alg string `json:"alg"`
	}
	if err := json.Unmarshal(res, &r); err != nil || r.Alg != "HMAC-SHA256" {
		return &mcpconn.OpenError{Code: "unavailable", Message: "Cerea answered the browser key call in a form this galopin does not understand; update galopin"}
	}
	raw, err := base64.RawURLEncoding.DecodeString(r.Key)
	if err != nil || len(raw) != 32 {
		return &mcpconn.OpenError{Code: "unavailable", Message: "Cerea sent a browser key of the wrong shape"}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return &mcpconn.OpenError{Code: "unavailable", Message: "cannot keep the browser key: " + err.Error()}
	}
	if err := writeFileAtomic(path, []byte(r.Key+"\n"), 0o600); err != nil {
		return &mcpconn.OpenError{Code: "unavailable", Message: "cannot keep the browser key: " + err.Error()}
	}
	return nil
}

// browserBeforeStart is the hub hook: before the runtime's process starts, refresh its key.
func (mc *machine) browserBeforeStart(stateDir string) func(context.Context, *mcpconn.Entry) *mcpconn.OpenError {
	return func(ctx context.Context, e *mcpconn.Entry) *mcpconn.OpenError {
		if e.Name != browserConnectorName {
			return nil
		}
		var calls machineCaller
		if mc.lnk != nil {
			calls = mc.lnk
		}
		return fetchBrowserKey(ctx, calls, pathsFor(stateDir).key)
	}
}
