package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/internal/backend"
	"galopin/internal/link"
	"galopin/internal/mcpconn"
	"galopin/internal/permrules"
	"galopin/internal/policy"
)

// The connector tools (ADR 0108, item 3): a stand-in Cerea answers
// connector.list and connector.call; the machine's own connectors are the real
// hub over the fake stdio server.

type fakeConnectorCerea struct {
	got      []link.Call
	list     string
	call     string
	callErr  *link.OpError
	unsupp   bool
	notReady bool
}

func (f *fakeConnectorCerea) Supports(family string) bool { return family == "connector" && !f.unsupp }
func (f *fakeConnectorCerea) Call(_ context.Context, c link.Call) (json.RawMessage, *link.OpError) {
	f.got = append(f.got, c)
	switch c.Op {
	case "connector.list":
		return json.RawMessage(f.list), nil
	case "connector.call":
		if f.callErr != nil {
			return nil, f.callErr
		}
		return json.RawMessage(f.call), nil
	}
	return nil, &link.OpError{Code: "unsupported", Message: "no"}
}

func (f *fakeConnectorCerea) calls(op string) []link.Call {
	var out []link.Call
	for _, c := range f.got {
		if c.Op == op {
			out = append(out, c)
		}
	}
	return out
}

const listWithBoth = `{"connectors":[{"id":"connector:abc","name":"Tracker","summary":"issues","tools":[{"name":"find","description":"find issues","inputSchema":{"type":"object"}}]}],"local":["notes"]}`

func connectorRig(t *testing.T, mode permrules.Action, mutate func(*policy.Policy)) (*coordRig, *fakeConnectorCerea) {
	t.Helper()
	r := newCoordRig(t, mutate)
	r.cb.mu.Lock()
	r.cb.sel["caller"] = permrules.Selector{Mode: mode}
	r.cb.mu.Unlock()
	fc := &fakeConnectorCerea{list: listWithBoth, call: `{"isError":false,"text":"3 issues"}`}
	r.mc.agentTools.calls = fc
	dir := t.TempDir()
	cfg := `{"mcpServers":{"notes":{"command":` + jsonString(os.Args[0]) + `,"env":{"MCPFAKE_SERVER":"1","FAKE_VALUE":"local"}}}}`
	if err := os.WriteFile(filepath.Join(dir, mcpConfigFileName), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	r.mc.mcp = mcpconn.New(mcpconn.Config{Path: filepath.Join(dir, mcpConfigFileName), StateDir: dir, Logf: t.Logf,
		Audit: func(server, tool, outcome string) { r.mc.audit.mcpCall(server, tool, outcome) }})
	t.Cleanup(r.mc.mcp.Shutdown)
	return r, fc
}

func jsonString(s string) string { b, _ := json.Marshal(s); return string(b) }

func TestConnectorListMergesCereaAndLocalWithIds(t *testing.T) {
	r, fc := connectorRig(t, permrules.Ask, nil)
	out, err := r.call("caller", "connector_list", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	var res struct {
		Connectors []connectorEntry `json:"connectors"`
	}
	if json.Unmarshal([]byte(out), &res) != nil || len(res.Connectors) != 2 {
		t.Fatalf("list = %s", out)
	}
	if res.Connectors[0].ID != "cerea:connector:abc" || res.Connectors[0].Where != "cerea" || res.Connectors[0].Tools[0].Name != "find" {
		t.Fatalf("cerea entry = %+v", res.Connectors[0])
	}
	if res.Connectors[1].ID != "local:notes" || len(res.Connectors[1].Tools) != 3 {
		t.Fatalf("local entry = %+v", res.Connectors[1])
	}
	// The session is named in the call, and a list asks nothing even on Ask.
	if c := fc.calls("connector.list"); len(c) != 1 || c[0].SessionID != "caller" {
		t.Fatalf("calls = %+v", fc.got)
	}
	if len(r.asks()) != 0 {
		t.Fatalf("a list raised a card: %+v", r.asks())
	}
}

func TestConnectorListWithNothingOptedInSaysSo(t *testing.T) {
	r, fc := connectorRig(t, permrules.Allow, nil)
	fc.list = `{"connectors":[],"local":[]}`
	out, err := r.call("caller", "connector_list", map[string]any{})
	if err != nil || !strings.Contains(out, `"connectors":[]`) || !strings.Contains(out, "no connectors are switched on") {
		t.Fatalf("%s, %v", out, err)
	}
}

func TestConnectorCallToCereaForwardsOnlyTheNamesAndArguments(t *testing.T) {
	r, fc := connectorRig(t, permrules.Allow, nil)
	if _, err := r.call("caller", "connector_list", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	out, err := r.call("caller", "connector_call", map[string]any{"connector": "cerea:connector:abc", "tool": "find", "arguments": map[string]any{"q": "bug"}})
	if err != nil || out != "3 issues" {
		t.Fatalf("%q, %v", out, err)
	}
	c := fc.calls("connector.call")
	if len(c) != 1 {
		t.Fatalf("calls = %+v", fc.got)
	}
	raw, _ := json.Marshal(c[0].Args)
	if string(raw) != `{"arguments":{"q":"bug"},"connector":"connector:abc","tool":"find"}` {
		t.Fatalf("args = %s", raw)
	}
	if len(r.asks()) != 0 {
		t.Fatalf("Allow with the tools class at run raised a card: %+v", r.asks())
	}
}

func TestConnectorCallToLocalIsServedWithoutTheLink(t *testing.T) {
	r, fc := connectorRig(t, permrules.Allow, nil)
	out, err := r.call("caller", "connector_call", map[string]any{"connector": "local:notes", "tool": "read_file", "arguments": map[string]any{"path": "x"}})
	if err != nil || !strings.Contains(out, "called read_file local") {
		t.Fatalf("%q, %v", out, err)
	}
	if len(fc.got) != 0 {
		t.Fatalf("a local call reached Cerea: %+v", fc.got)
	}
	rows := r.audit()
	var sawMcp, sawTool bool
	for _, row := range rows {
		if row["action"] == "mcp.call" && row["tool"] == "read_file" && row["outcome"] == "ok" {
			sawMcp = true
		}
		if row["action"] == "agent_tool" && row["tool"] == "connector_call" && row["to"] == "local:notes read_file" && row["decision"] == "done" {
			sawTool = true
		}
	}
	if !sawMcp || !sawTool {
		t.Fatalf("audit rows = %v", rows)
	}
}

func TestConnectorCallOnAskRaisesAToolsCardAndDeclineRunsNothing(t *testing.T) {
	r, fc := connectorRig(t, permrules.Ask, nil)
	r.cb.answer = func(backend.PermissionRequest) (backend.Decision, string) { return backend.DecisionReject, "no thanks" }
	_, err := r.call("caller", "connector_call", map[string]any{"connector": "cerea:connector:abc", "tool": "find", "arguments": map[string]any{}})
	if err == nil || !strings.Contains(err.Error(), "declined") {
		t.Fatalf("err = %v", err)
	}
	asks := r.asks()
	if len(asks) != 1 || asks[0].Tool != "connector_call" {
		t.Fatalf("asks = %+v", asks)
	}
	if len(fc.calls("connector.call")) != 0 {
		t.Fatal("a declined call reached Cerea")
	}
	// The card's class is tools, so Auto routes it like any MCP tool.
	dir, _, _ := r.mc.resolveSession("caller")
	asks[0].ID = "gp_x"
	if class, _ := r.mc.askClass(dir, asks[0]); class != "tools" {
		t.Fatalf("class = %q", class)
	}
	// Accepting it runs the call.
	r.cb.answer = nil
	if out, err := r.call("caller", "connector_call", map[string]any{"connector": "cerea:connector:abc", "tool": "find"}); err != nil || out != "3 issues" {
		t.Fatalf("%q, %v", out, err)
	}
}

func TestConnectorCallGating(t *testing.T) {
	// Plan refuses the call but not the list; a never limit refuses both; an
	// ask limit cards even on Allow.
	r, _ := connectorRig(t, permrules.Deny, nil)
	if _, err := r.call("caller", "connector_call", map[string]any{"connector": "cerea:connector:abc", "tool": "find"}); err == nil || !strings.Contains(err.Error(), "Plan") {
		t.Fatalf("Plan: %v", err)
	}
	if _, err := r.call("caller", "connector_list", map[string]any{}); err != nil {
		t.Fatalf("list on Plan: %v", err)
	}

	r, fc := connectorRig(t, permrules.Allow, withLimit("tools", "never"))
	for tool, args := range map[string]map[string]any{"connector_list": {}, "connector_call": {"connector": "cerea:connector:abc", "tool": "find"}} {
		_, err := r.call("caller", tool, args)
		if err == nil || !strings.Contains(err.Error(), "does not allow") {
			t.Fatalf("never limit, %s: %v", tool, err)
		}
	}
	if len(fc.got) != 0 {
		t.Fatalf("a refused call reached Cerea: %+v", fc.got)
	}

	r, _ = connectorRig(t, permrules.Allow, withLimit("tools", "ask"))
	if _, err := r.call("caller", "connector_call", map[string]any{"connector": "cerea:connector:abc", "tool": "find"}); err != nil {
		t.Fatal(err)
	}
	if len(r.asks()) != 1 {
		t.Fatalf("an ask limit raised %d cards", len(r.asks()))
	}
}

func TestConnectorCallErrorsAreReadable(t *testing.T) {
	r, fc := connectorRig(t, permrules.Allow, nil)
	call := map[string]any{"connector": "cerea:connector:abc", "tool": "find"}

	fc.call = `{"isError":true,"text":"rate limited"}`
	if _, err := r.call("caller", "connector_call", call); err == nil || !strings.Contains(err.Error(), "the tool reported an error: rate limited") {
		t.Fatalf("tool error: %v", err)
	}
	fc.callErr = &link.OpError{Code: "forbidden", Message: "Tracker is not switched on for this session."}
	if _, err := r.call("caller", "connector_call", call); err == nil || !strings.Contains(err.Error(), "not switched on for this session") {
		t.Fatalf("forbidden: %v", err)
	}
	fc.callErr = &link.OpError{Code: "unavailable", Message: "Cerea did not answer in time"}
	if _, err := r.call("caller", "connector_call", call); err == nil || !strings.Contains(err.Error(), "try again later") {
		t.Fatalf("unavailable: %v", err)
	}
	fc.unsupp = true
	if _, err := r.call("caller", "connector_call", call); err == nil || !strings.Contains(err.Error(), "does not offer its connectors") {
		t.Fatalf("old Cerea: %v", err)
	}
	for _, bad := range []map[string]any{
		{"tool": "find"}, {"connector": "x:y", "tool": "find"}, {"connector": "cerea:a"},
		{"connector": "cerea:a", "tool": "t", "arguments": "no"}, {"connector": "cerea:a", "tool": "t", "extra": 1},
	} {
		if _, err := r.call("caller", "connector_call", bad); err == nil {
			t.Errorf("%v accepted", bad)
		}
	}
}

func TestConnectorResultIsClippedAndNonTextNamed(t *testing.T) {
	if got := contentText([]json.RawMessage{json.RawMessage(`{"type":"text","text":"a"}`), json.RawMessage(`{"type":"image","data":"AAAA"}`)}); got != "a\n[image content not shown]" {
		t.Fatalf("contentText = %q", got)
	}
	long := strings.Repeat("é", maxConnectorResult)
	got := clip(long, maxConnectorResult)
	if len(got) > maxConnectorResult+80 || !strings.Contains(got, "[result cut:") {
		t.Fatalf("clip kept %d bytes", len(got))
	}
}
