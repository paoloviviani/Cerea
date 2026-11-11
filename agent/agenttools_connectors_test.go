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
	// Plan refuses the call but not the list; a local deny of tools refuses both
	// (ADR 0109).
	r, _ := connectorRig(t, permrules.Deny, nil)
	if _, err := r.call("caller", "connector_call", map[string]any{"connector": "cerea:connector:abc", "tool": "find"}); err == nil || !strings.Contains(err.Error(), "Plan") {
		t.Fatalf("Plan: %v", err)
	}
	if _, err := r.call("caller", "connector_list", map[string]any{}); err != nil {
		t.Fatalf("list on Plan: %v", err)
	}

	r, fc := connectorRig(t, permrules.Allow, withDeny("tools"))
	for tool, args := range map[string]map[string]any{"connector_list": {}, "connector_call": {"connector": "cerea:connector:abc", "tool": "find"}} {
		_, err := r.call("caller", tool, args)
		if err == nil || !strings.Contains(err.Error(), "refused") {
			t.Fatalf("local deny, %s: %v", tool, err)
		}
	}
	if len(fc.got) != 0 {
		t.Fatalf("a refused call reached Cerea: %+v", fc.got)
	}

	// With no limit on the machine, Allow runs the call with no card.
	r, _ = connectorRig(t, permrules.Allow, nil)
	if _, err := r.call("caller", "connector_call", map[string]any{"connector": "cerea:connector:abc", "tool": "find"}); err != nil {
		t.Fatal(err)
	}
	if len(r.asks()) != 0 {
		t.Fatalf("Allow raised %d cards", len(r.asks()))
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

// bigConnectors is n connectors of tools tools each, every one with a long
// description and a large schema: a list well over opencode's 50 KB cap.
func bigConnectors(n, tools int) []connectorEntry {
	schema := json.RawMessage(`{"type":"object","properties":{"q":{"type":"string","description":"` + strings.Repeat("s", 600) + `"}}}`)
	var out []connectorEntry
	for i := 0; i < n; i++ {
		c := connectorEntry{ID: "cerea:c" + string(rune('a'+i)), Name: "Conn" + string(rune('A'+i)), Where: "cerea"}
		for j := 0; j < tools; j++ {
			c.Tools = append(c.Tools, connectorTool{Name: "tool_" + string(rune('a'+j%26)) + string(rune('a'+j/26)), Description: strings.Repeat("d", 400), InputSchema: schema})
		}
		out = append(out, c)
	}
	return out
}

func TestFitConnectorListShrinksInStepsUnderTheCap(t *testing.T) {
	// ~110 KB with schemas, as the list that came back cut: over opencode's cap,
	// under the old 200 KiB threshold.
	list := bigConnectors(1, 100)
	full := fitConnectorList(list, nil, 1<<30)
	if len(full) < 100<<10 || len(full) > maxConnectorResult {
		t.Fatalf("test list is %d bytes, want between 100 KiB and %d", len(full), maxConnectorResult)
	}
	for _, tc := range []struct {
		name         string
		list         []connectorEntry
		wantSchema   bool
		wantDesc     bool
		wantTools    bool
		noteContains string
	}{
		{"small stays whole", bigConnectors(1, 3), true, true, true, ""},
		{"drops schemas first", bigConnectors(1, 50), false, true, true, "argument schemas are left out"},
		{"then shortens descriptions", bigConnectors(1, 100), false, false, true, "descriptions are cut short"},
		{"then names only", bigConnectors(2, 400), false, false, true, "only the tool names"},
		{"then connectors only", bigConnectors(20, 2000), false, false, false, "tools are left out"},
	} {
		body := fitConnectorList(tc.list, nil, maxConnectorList)
		if len(body) > maxConnectorList {
			t.Errorf("%s: %d bytes, over %d", tc.name, len(body), maxConnectorList)
		}
		var res struct {
			Connectors []connectorEntry `json:"connectors"`
			Notes      []string         `json:"notes"`
		}
		if err := json.Unmarshal(body, &res); err != nil || len(res.Connectors) != len(tc.list) {
			t.Fatalf("%s: unreadable or connectors lost: %v", tc.name, err)
		}
		s := string(body)
		if got := strings.Contains(s, `"inputSchema"`); got != tc.wantSchema {
			t.Errorf("%s: schema present = %v", tc.name, got)
		}
		if got := strings.Contains(s, strings.Repeat("d", 400)); got != tc.wantDesc {
			t.Errorf("%s: full description present = %v", tc.name, got)
		}
		if got := len(res.Connectors[0].Tools) > 0; got != tc.wantTools {
			t.Errorf("%s: tools present = %v", tc.name, got)
		}
		if tc.noteContains == "" {
			if len(res.Notes) != 0 {
				t.Errorf("%s: unexpected notes %v", tc.name, res.Notes)
			}
		} else if !strings.Contains(strings.Join(res.Notes, "\n"), tc.noteContains) || !strings.Contains(strings.Join(res.Notes, "\n"), "connector_list with connector") {
			t.Errorf("%s: notes = %v", tc.name, res.Notes)
		}
		if !strings.Contains(s, `"tools":[`) {
			t.Errorf("%s: tools must stay an array, not null", tc.name)
		}
	}
	// The entries are not changed by shrinking.
	if list[0].Tools[0].InputSchema == nil || len(list[0].Tools[0].Description) != 400 {
		t.Fatal("fitConnectorList changed its input")
	}
}

func TestConnectorListOverTheCapIsShortenedAndOneConnectorCanBeAsked(t *testing.T) {
	r, fc := connectorRig(t, permrules.Ask, nil)
	big := bigConnectors(2, 100)
	raw := struct {
		Connectors []map[string]any `json:"connectors"`
		Local      []string         `json:"local"`
	}{Local: []string{}}
	for _, c := range big {
		raw.Connectors = append(raw.Connectors, map[string]any{"id": strings.TrimPrefix(c.ID, "cerea:"), "name": c.Name, "tools": c.Tools})
	}
	b, _ := json.Marshal(raw)
	fc.list = string(b)

	out, err := r.call("caller", "connector_list", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if len(out) > maxConnectorList || !strings.Contains(out, "left out") {
		t.Fatalf("list = %d bytes, notes missing: %.200s", len(out), out)
	}
	// By name or id, one connector's tools; "" is "not given" (opencode makes every argument required).
	for _, want := range []string{"cerea:ca", "conna"} {
		one, err := r.call("caller", "connector_list", map[string]any{"connector": want, "tool": "", "note": ""})
		if err != nil || !strings.Contains(one, `"cerea:ca"`) || strings.Contains(one, `"cerea:cb"`) {
			t.Fatalf("connector %q = %v, %.200s", want, err, one)
		}
	}
	// One tool is in full, schema included, whatever the connector's size.
	one, err := r.call("caller", "connector_list", map[string]any{"connector": "cerea:ca", "tool": "tool_aa"})
	if err != nil || !strings.Contains(one, `"inputSchema"`) || len(one) > maxConnectorList || strings.Contains(one, "tool_ba") {
		t.Fatalf("one tool = %v, %.300s", err, one)
	}
	// Misses say what there is.
	_, err = r.call("caller", "connector_list", map[string]any{"connector": "nope"})
	refusedWith(t, err, "cerea:ca")
	_, err = r.call("caller", "connector_list", map[string]any{"connector": "cerea:ca", "tool": "nope"})
	refusedWith(t, err, "no tool")
	_, err = r.call("caller", "connector_list", map[string]any{"tool": "find"})
	refusedWith(t, err, "tool needs connector")
}
