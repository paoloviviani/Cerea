package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"galopin/internal/backend"
	"galopin/internal/decide"
	"galopin/internal/link"
	"galopin/internal/permrules"
)

// The connector tools (ADR 0108, item 3; PROTOCOL.md §6 "Connector tools",
// §5 "Machine calls"): a session's agent reaches the connectors its person
// opted it in to. Two sources, one pair of tools:
//
//   - Cerea's connectors (the deployment's and the person's own): Cerea lists
//     them (connector.list) and runs each call with the person's credentials
//     (connector.call). No credential ever crosses the link; Cerea decides
//     which connectors the session may see, so a machine can name only what
//     was opted in.
//   - This machine's own connectors (mcp.json): served here, in-process, with
//     no trip to Cerea. Cerea only says which of them the session may use.
//
// They are the `tools` permission class like any MCP tool: the machine's
// limit caps, the session's word decides, the card carries class `tools` (so
// Auto routes it to the reviewer or the person, and the review log records it).
// The two tools are fixed (opencode installs tool files at start and cannot
// add one per session), so the model lists, then calls by id.

const (
	connectorFamily = "connector"
	// connectorCallLimit bounds one connector call end to end; Cerea's own
	// bound is shorter, so its answer arrives before this gives up.
	connectorCallLimit = 90 * time.Second
	// maxConnectorResult bounds the text a call hands the model.
	maxConnectorResult = 200 << 10
	// maxConnectorArgs bounds a call's arguments.
	maxConnectorArgs = 256 << 10
	// maxCardArgs bounds the arguments shown on a card.
	maxCardArgs = 4 << 10
	// connectorIDPrefixes: ids from connector_list.
	cereaIDPrefix = "cerea:"
	localIDPrefix = "local:"
)

type connectorTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

type connectorEntry struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	Summary string          `json:"summary,omitempty"`
	Where   string          `json:"where"`
	Tools   []connectorTool `json:"tools"`
	Note    string          `json:"note,omitempty"`
}

// connectorList is what Cerea answers connector.list with.
type connectorList struct {
	Connectors []struct {
		ID      string          `json:"id"`
		Name    string          `json:"name"`
		Summary string          `json:"summary"`
		Tools   []connectorTool `json:"tools"`
		Note    string          `json:"note"`
	} `json:"connectors"`
	// Local names the machine's own connectors this session is opted in to.
	Local []string `json:"local"`
}

func (at *agentTools) connectorGate(tc *toolCaller, list bool) (permrules.Action, error) {
	rh, ok := at.mc.back.(backend.RuleHost)
	if !ok {
		return permrules.Ask, nil
	}
	act, reason := decide.ConnectorCall(at.mc.decidePolicy(rh), at.mc.rootState(rh, tc.session.ID), list)
	if act == permrules.Deny {
		return permrules.Deny, refuse("%s", reason)
	}
	return act, nil
}

// connectorsFor is the session's connectors with their tools: Cerea's, then
// this machine's. A source that cannot be reached is said in a note, not an
// error, so the other still works.
func (at *agentTools) connectorsFor(ctx context.Context, tc *toolCaller) ([]connectorEntry, []string) {
	var out []connectorEntry
	var notes []string
	var local []string
	raw, err := at.connectorCerea(ctx, tc, "list", map[string]any{})
	if err != nil {
		notes = append(notes, "Cerea's connectors are unavailable: "+err.Error())
	} else {
		var l connectorList
		if json.Unmarshal(raw, &l) != nil {
			notes = append(notes, "Cerea's connector list was not readable")
		}
		for _, c := range l.Connectors {
			out = append(out, connectorEntry{ID: cereaIDPrefix + c.ID, Name: c.Name, Summary: c.Summary, Where: "cerea", Tools: c.Tools, Note: c.Note})
		}
		local = l.Local
	}
	for _, name := range local {
		hub := at.mc.mcp
		if hub == nil {
			continue
		}
		tools, lerr := hub.LocalTools(ctx, name)
		e := connectorEntry{ID: localIDPrefix + name, Name: name, Where: "this machine", Tools: []connectorTool{}}
		if lerr != nil {
			e.Note = "unavailable: " + lerr.Error()
		}
		for _, t := range tools {
			e.Tools = append(e.Tools, connectorTool{Name: t.Name, Description: t.Description, InputSchema: t.InputSchema})
		}
		out = append(out, e)
	}
	at.rememberConnectors(tc.session.ID, out)
	return out, notes
}

func (at *agentTools) rememberConnectors(session string, list []connectorEntry) {
	at.mu.Lock()
	defer at.mu.Unlock()
	if at.connectorNames == nil {
		at.connectorNames = map[string]map[string]string{}
	}
	names := map[string]string{}
	for _, c := range list {
		names[c.ID] = c.Name
	}
	at.connectorNames[session] = names
}

func (at *agentTools) connectorName(session, id string) string {
	at.mu.Lock()
	defer at.mu.Unlock()
	if n := at.connectorNames[session][id]; n != "" {
		return n
	}
	return id
}

// connectorCerea is one connector.<op> machine call, every failure a refusal
// the model can read.
func (at *agentTools) connectorCerea(ctx context.Context, tc *toolCaller, op string, args any) (json.RawMessage, error) {
	mcalls := at.machineCalls()
	if mcalls == nil {
		return nil, refuse("Cerea is not reachable from this machine right now; try again later")
	}
	if !mcalls.Supports(connectorFamily) {
		return nil, refuse("this Cerea does not offer its connectors to agents; update it")
	}
	res, operr := mcalls.Call(ctx, link.Call{
		Op: connectorFamily + "." + op, SessionID: tc.session.ID, RootSessionID: at.mc.mat.RootOf(tc.session.ID),
		Caller: at.callerFacts(tc), Args: args, Timeout: connectorCallLimit,
	})
	if operr != nil {
		switch operr.Code {
		case "unavailable":
			return nil, refuse("Cerea could not do that right now (%s); try again later", operr.Message)
		case "unsupported":
			return nil, refuse("this Cerea does not offer its connectors to agents; update it")
		}
		return nil, refuse("%s", operr.Message)
	}
	return res, nil
}

// connectorListTool implements connector_list.
func (at *agentTools) connectorListTool(ctx context.Context, tc *toolCaller, call backend.ToolCall) (string, error) {
	if _, err := decodeObject(call.Args, "the arguments", "note"); err != nil {
		return "", err
	}
	if _, err := at.connectorGate(tc, true); err != nil {
		return "", err
	}
	list, notes := at.connectorsFor(ctx, tc)
	res := map[string]any{"connectors": list}
	if list == nil {
		res["connectors"] = []connectorEntry{}
	}
	if len(list) == 0 && len(notes) == 0 {
		notes = append(notes, "no connectors are switched on for this session; the person can add them in the session's permissions sheet")
	}
	if len(notes) > 0 {
		res["notes"] = notes
	}
	body, _ := json.Marshal(res)
	if len(body) > maxConnectorResult {
		for i := range list {
			for j := range list[i].Tools {
				list[i].Tools[j].InputSchema = nil
			}
		}
		res["connectors"] = list
		res["notes"] = append(notes, "the tool schemas were left out because the list is large; call a tool with the arguments its description suggests")
		body, _ = json.Marshal(res)
	}
	return string(body), nil
}

// connectorCallTool implements connector_call; the second result names the
// connector and tool for the audit row.
func (at *agentTools) connectorCallTool(ctx context.Context, tc *toolCaller, call backend.ToolCall) (string, string, error) {
	m, err := decodeObject(call.Args, "the arguments", "connector", "tool", "arguments")
	if err != nil {
		return "", "", err
	}
	var id, tool string
	if v, ok := m["connector"]; !ok || json.Unmarshal(v, &id) != nil || strings.TrimSpace(id) == "" {
		return "", "", refuse("connector is required (an id from connector_list)")
	}
	if v, ok := m["tool"]; !ok || json.Unmarshal(v, &tool) != nil || strings.TrimSpace(tool) == "" {
		return "", id, refuse("tool is required (a tool name from connector_list)")
	}
	to := id + " " + tool
	args := m["arguments"]
	if len(args) == 0 || string(args) == "null" || string(args) == `""` {
		args = json.RawMessage(`{}`)
	}
	var probe map[string]json.RawMessage
	if json.Unmarshal(args, &probe) != nil {
		return "", to, refuse("arguments must be a JSON object")
	}
	if len(args) > maxConnectorArgs {
		return "", to, refuse("arguments are longer than %d bytes", maxConnectorArgs)
	}
	isCerea, isLocal := strings.HasPrefix(id, cereaIDPrefix), strings.HasPrefix(id, localIDPrefix)
	if !isCerea && !isLocal {
		return "", to, refuse("unknown connector %q: use an id from connector_list", id)
	}

	act, err := at.connectorGate(tc, false)
	if err != nil {
		return "", to, err
	}
	name := at.connectorName(tc.session.ID, id)
	meta := map[string]any{
		"connector": map[string]any{"id": id, "name": name, "where": map[bool]string{true: "cerea", false: "this machine"}[isCerea]},
		"tool":      tool,
	}
	if len(args) <= maxCardArgs {
		meta["arguments"] = json.RawMessage(args)
	} else {
		meta["argumentsBytes"] = len(args)
	}
	decision, message, err := at.approve(ctx, tc, call, act == permrules.Allow, to, reasonAllowedByRules, backend.PermissionRequest{
		Tool: "connector_call", Title: "Use " + tool + " from " + name, Metadata: meta,
	})
	if err != nil {
		return "", to, err
	}
	if decision != backend.DecisionOnce {
		return "", to, declined(message)
	}

	var text string
	var isErr bool
	if isLocal {
		hub := at.mc.mcp
		if hub == nil {
			return "", to, refuse("this machine has no connectors")
		}
		res, lerr := hub.LocalCall(ctx, strings.TrimPrefix(id, localIDPrefix), tool, args, connectorCallLimit)
		if lerr != nil {
			return "", to, refuse("%s", lerr.Error())
		}
		text, isErr = contentText(res.Content), res.IsError
	} else {
		raw, cerr := at.connectorCerea(ctx, tc, "call", map[string]any{"connector": strings.TrimPrefix(id, cereaIDPrefix), "tool": tool, "arguments": json.RawMessage(args)})
		if cerr != nil {
			return "", to, cerr
		}
		var r struct {
			IsError bool   `json:"isError"`
			Text    string `json:"text"`
		}
		if json.Unmarshal(raw, &r) != nil {
			return "", to, refuse("Cerea's answer was not readable")
		}
		text, isErr = r.Text, r.IsError
	}
	text = clip(text, maxConnectorResult)
	if isErr {
		return "", to, refuse("the tool reported an error: %s", text)
	}
	return text, to, nil
}

// contentText is the text of a result's content blocks; anything else is
// named, not carried (the model is not handed bytes it cannot read).
func contentText(blocks []json.RawMessage) string {
	var parts []string
	for _, b := range blocks {
		var c struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(b, &c) != nil {
			continue
		}
		if c.Type == "text" {
			parts = append(parts, c.Text)
		} else if c.Type != "" {
			parts = append(parts, "["+c.Type+" content not shown]")
		}
	}
	return strings.Join(parts, "\n")
}

func clip(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := s[:max]
	for !utf8.ValidString(cut) && len(cut) > 0 {
		cut = cut[:len(cut)-1]
	}
	return cut + fmt.Sprintf("\n[result cut: %d of %d bytes shown]", len(cut), len(s))
}
