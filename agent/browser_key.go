package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

// keyFileReady reports whether the key file holds a key the runtime would accept: a file at least
// this long, decodable as base64url, like the runtime's own key read.
func keyFileReady(path string) bool {
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(string(b)))
	return err == nil && len(raw) >= 16
}

// ensureBrowserKey makes sure the runtime has its key before an action runs under one: the key
// file is read first, and a missing or unusable one is fetched with a single retry. On failure the
// error is returned (and logged by the caller), never fatal to the call: the action goes on, and
// the runtime refuses what it cannot do, with its own words.
func ensureBrowserKey(ctx context.Context, calls machineCaller, path string) *mcpconn.OpenError {
	if keyFileReady(path) {
		return nil
	}
	if err := fetchBrowserKey(ctx, calls, path); err == nil {
		return nil
	}
	return fetchBrowserKey(ctx, calls, path)
}

// browserKeyReady is the hub hook: the first approved action of a task must run with the key in
// place, so the key is refreshed just before the call leaves the hub (only the one tool that
// runs an action under a grant: the runtime refuses a commit-class action with none).
func (mc *machine) browserKeyReady(stateDir string) func(context.Context, *mcpconn.Entry, string) *mcpconn.OpenError {
	return func(ctx context.Context, e *mcpconn.Entry, tool string) *mcpconn.OpenError {
		if e.Name != browserConnectorName || tool != "act" {
			return nil
		}
		var calls machineCaller
		if mc.lnk != nil {
			calls = mc.lnk
		}
		// Fetching with a slow link must not stall the message loop for too long: the
		// deadline bounds the fetch and its one retry, so a missing key costs a bounded
		// wait, never an unbounded one.
		ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		return ensureBrowserKey(ctx, calls, pathsFor(stateDir).key)
	}
}
