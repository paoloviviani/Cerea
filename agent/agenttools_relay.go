package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"galopin/internal/backend"
	"galopin/internal/decide"
	"galopin/internal/link"
	"galopin/internal/permrules"
)

// Relayed coordination, the caller's half (ADR 0121; PROTOCOL.md §5 family
// `coord`, §6 "Agent tools"). session_list, session_read, session_send and
// session_spawn reach a session on ANOTHER computer of the same owner through
// Cerea. galopin decides and asks (the card), Cerea checks the owner, the
// limits and the approval ticket and routes, the target's galopin delivers.
//
// What is different from the local tools, on purpose:
//   - the decision function is called with relayed=true: Plan refuses, every
//     other word is a card, nothing (exception, Auto row, target word) frees it;
//   - the card carries metadata.relay, so Cerea records it, renders it from its
//     own record and never gives it to the Auto reviewer; its id is the call's
//     approvalId, the one-shot ticket Cerea mints when the owner answers there;
//   - "always" is never offered (the backend reads it as once), and nothing is
//     stored for it.
const (
	// coordFamily is the machine-call family; the welcome lists it.
	coordFamily = "coord"
	// coordCallLimit bounds read, send, spawn and resolve; coordListLimit a list.
	coordCallLimit = 20 * time.Second
	coordListLimit = 8 * time.Second
	// relayHopMessage is the refusal past the hop limit: relayed sends are cards
	// already, so past the limit the call is refused outright (ADR 0121 section 8).
	relayHopMessage = "hop limit: agents may pass a request on at most %d times"
)

// remoteTargetRe is a remote session address: a Cerea device id (24 hex), a
// colon and the session id on that computer. A local session id never matches.
var remoteTargetRe = regexp.MustCompile(`^([0-9a-f]{24}):(.+)$`)

// parseRemoteTarget splits "<computerId>:<sessionId>"; ok is false for a local id.
func parseRemoteTarget(target string) (computerID, sessionID string, ok bool) {
	m := remoteTargetRe.FindStringSubmatch(strings.TrimSpace(target))
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}

var deviceIDRe = regexp.MustCompile(`^[0-9a-f]{24}$`)

// relayCall is one relayed tool call, validated.
type relayCall struct {
	op   string // "send" | "read" | "spawn"
	tool string // the permission key: session_send | session_read | session_spawn

	computerID  string
	sessionID   string // send, read
	workspaceID string // spawn
	text        string // send
	prompt      string // spawn
	title       string // spawn
	mode        string // spawn: plan | build
	last        int    // read
	hop         int
}

// coordResolved is what Cerea's coord.resolve answers: the labels of the card,
// read live by Cerea. galopin shows them in its own copy of the card and trusts
// none of them for anything but display (Cerea renders its own record).
type coordResolved struct {
	Computer struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"computer"`
	Workspace struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"workspace"`
	Session *struct {
		ID     string `json:"id"`
		Title  string `json:"title"`
		Mode   string `json:"mode"`
		Status string `json:"status"`
	} `json:"session"`
}

// relayCapable reports whether this machine may make relayed calls at all: the
// backend has the tools, and the owner's local veto is not set.
func (at *agentTools) relayAllowedHere() error {
	if !at.mc.pol.RelayedCoordinationAllowed() {
		return refuse("this computer's owner turned relayed coordination off locally; agents here can only reach this computer's own sessions")
	}
	return nil
}

// coordCaller returns the machine-call link when Cerea supports the family.
func (at *agentTools) coordCaller() (machineCaller, error) {
	mcalls := at.machineCalls()
	if mcalls == nil {
		return nil, refuse("Cerea is not reachable from this machine right now; try again later")
	}
	if !mcalls.Supports(coordFamily) {
		return nil, refuse("this Cerea does not support relayed coordination; update it")
	}
	return mcalls, nil
}

// isLinkLevel says a call failed on the way (the link, the timeout), not in
// Cerea's own answer: for a send that means it may or may not have arrived.
func isLinkLevel(msg string) bool {
	return strings.HasPrefix(msg, "Cerea ") || strings.HasPrefix(msg, "the call was cancelled") ||
		strings.HasPrefix(msg, "this machine is not paired")
}

// coordCall makes one coord.<op> machine call for the calling session and turns
// every failure into a refusal the model can read.
func (at *agentTools) coordCall(ctx context.Context, tc *toolCaller, op string, args any, timeout time.Duration, mayHaveArrived bool) (json.RawMessage, error) {
	mcalls, err := at.coordCaller()
	if err != nil {
		return nil, err
	}
	res, operr := mcalls.Call(ctx, link.Call{
		Op: coordFamily + "." + op, SessionID: tc.session.ID, RootSessionID: at.mc.mat.RootOf(tc.session.ID),
		Caller: at.callerFacts(tc), Args: args, Timeout: timeout,
	})
	if operr != nil {
		switch operr.Code {
		case "unsupported":
			if strings.Contains(operr.Message, "coord") || strings.Contains(operr.Message, "know the call") {
				return nil, refuse("this Cerea does not support relayed coordination; update it")
			}
		case "unavailable":
			if mayHaveArrived && isLinkLevel(operr.Message) {
				return nil, refuse("%s It may or may not have arrived: read the session before trying again.", strings.TrimSpace(operr.Message))
			}
		}
		return nil, refuse("%s", operr.Message)
	}
	return res, nil
}

// remoteListRow is one session of another computer in session_list's answer.
type remoteListRow struct {
	ComputerID   string `json:"computerId"`
	Computer     string `json:"computer"`
	SessionID    string `json:"sessionId"`
	Target       string `json:"target"`
	Title        string `json:"title"`
	WorkspaceID  string `json:"workspaceId"`
	Workspace    string `json:"workspace"`
	Mode         string `json:"mode"`
	Status       string `json:"status"`
	LastActivity string `json:"lastActivity,omitempty"`
}

// listArgs reads session_list's `computers` flag; every other key is ignored
// (opencode requires `note` and the model fills it in however it likes).
func listWantsComputers(raw []byte) bool {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return false
	}
	v, ok := m["computers"]
	if !ok {
		return false
	}
	var b bool
	if json.Unmarshal(v, &b) == nil {
		return b
	}
	var s string
	if json.Unmarshal(v, &s) == nil {
		return strings.EqualFold(strings.TrimSpace(s), "true")
	}
	return false
}

// remoteList is the part of session_list that reaches other computers: rows,
// the computers (when asked for) and a one-line note when it could not be had.
// It never fails the list: the local rows are always returned.
func (at *agentTools) remoteList(ctx context.Context, tc *toolCaller, wantComputers bool) (rows []remoteListRow, computers json.RawMessage, note string) {
	// A caller that could not be told anything about other computers is still
	// useful locally, so each reason is a note, or silence where it is the norm.
	if !at.mc.pol.RelayedCoordinationAllowed() {
		return nil, nil, ""
	}
	if tc.session.ParentID != "" || at.mc.mat.RootOf(tc.session.ID) != tc.session.ID {
		return nil, nil, ""
	}
	if rh, ok := at.mc.back.(backend.RuleHost); ok {
		if act, _ := decide.CoordinationFor(at.mc.decidePolicy(rh), at.mc.rootState(rh, tc.session.ID), "session_list", false, "", true); act == permrules.Deny {
			return nil, nil, ""
		}
	}
	mcalls := at.machineCalls()
	if mcalls == nil || !mcalls.Supports(coordFamily) {
		if wantComputers {
			return nil, nil, "other computers are not available: this Cerea does not support relayed coordination; update it."
		}
		return nil, nil, ""
	}
	raw, err := at.coordCall(ctx, tc, "list", map[string]any{"workspaces": wantComputers}, coordListLimit, false)
	if err != nil {
		return nil, nil, "other computers are not listed: " + err.Error()
	}
	var res struct {
		Computers json.RawMessage `json:"computers"`
		Sessions  []remoteListRow `json:"sessions"`
		Note      string          `json:"note"`
	}
	if json.Unmarshal(raw, &res) != nil {
		return nil, nil, "other computers are not listed: Cerea's answer was not readable."
	}
	for i := range res.Sessions {
		res.Sessions[i].Target = res.Sessions[i].ComputerID + ":" + res.Sessions[i].SessionID
	}
	if wantComputers {
		computers = res.Computers
	}
	return res.Sessions, computers, res.Note
}

// relayGate is the decision for a relayed call: refuses on Plan or a local deny
// of agents, a card otherwise (decide.CoordinationFor with relayed=true).
func (at *agentTools) relayGate(tc *toolCaller, tool string) error {
	rh, ok := at.mc.back.(backend.RuleHost)
	if !ok {
		return nil // no permission state: a card is the safe reading
	}
	act, reason := decide.CoordinationFor(at.mc.decidePolicy(rh), at.mc.rootState(rh, tc.session.ID), tool, false, "", true)
	if act == permrules.Deny {
		return refuse("%s", reason)
	}
	return nil
}

// relayPreflight is every check that needs neither Cerea nor the person: the
// local veto, the subagent rule, Plan and the local deny.
func (at *agentTools) relayPreflight(tc *toolCaller, tool string) error {
	if err := at.relayAllowedHere(); err != nil {
		return err
	}
	// A task subagent's final message is its report to its parent; a request
	// to another computer from it would reach people who did not start it.
	if tc.session.ParentID != "" || at.mc.mat.RootOf(tc.session.ID) != tc.session.ID {
		return refuse("a subagent cannot reach other computers: report to your parent in your final message")
	}
	return at.relayGate(tc, tool)
}

// nextHop is 1 plus the hop of the message that started the caller's latest
// turn (a peer's message carries its hop; a person's carries none).
func (at *agentTools) nextHop(sessionID string) int {
	hop := 1
	if last, ok := at.mc.mat.LatestUserMessage(sessionID); ok && last.SentBy != nil {
		hop = last.SentBy.Hop + 1
	}
	return hop
}

// takePair counts one send or read of an ordered caller→target pair against
// its window and refuses past the limit, before any card is raised.
func (at *agentTools) takePair(key string, limit int, window time.Duration, what string) error {
	at.mu.Lock()
	defer at.mu.Unlock()
	now := at.now()
	at.sendLog[key] = recent(at.sendLog[key], now, window)
	if len(at.sendLog[key]) >= limit {
		return refuse("%s rate limit: at most %d per minute to the same session", what, limit)
	}
	at.sendLog[key] = append(at.sendLog[key], now)
	return nil
}

// takeRemoteSpawn is the spawn tree's own counters, which count a remote spawn
// like a local one: the chain depth and the attempts per root in the window.
func (at *agentTools) takeRemoteSpawn(tc *toolCaller) error {
	marks := at.host.SpawnMarks()
	depth, root := spawnChain(marks, tc.session.ID)
	if depth >= maxSpawnDepth {
		return refuse("spawn chain limit: sessions spawned %d deep cannot spawn further", maxSpawnDepth)
	}
	at.mu.Lock()
	defer at.mu.Unlock()
	now := at.now()
	at.spawnLog[root] = recent(at.spawnLog[root], now, spawnWindow)
	if len(at.spawnLog[root]) >= spawnsPerWindow {
		return refuse("spawn rate limit: at most %d spawns per %d minutes", spawnsPerWindow, int(spawnWindow.Minutes()))
	}
	at.spawnLog[root] = append(at.spawnLog[root], now)
	return nil
}

// resolveArgs are coord.resolve's: the op and the ids the card will name.
func (rc relayCall) resolveArgs() map[string]any {
	a := map[string]any{"op": rc.op, "computerId": rc.computerID}
	if rc.sessionID != "" {
		a["sessionId"] = rc.sessionID
	}
	if rc.workspaceID != "" {
		a["workspaceId"] = rc.workspaceID
	}
	return a
}

// cardMetadata is galopin's copy of the card's facts: the hash-covered fields
// Cerea binds the ticket to, and the labels Cerea resolved. Cerea draws the
// card from its own record, never from this.
func (rc relayCall) cardMetadata(res coordResolved) map[string]any {
	meta := map[string]any{
		"relay": true, "op": rc.op, "computerId": rc.computerID, "hop": rc.hop,
		"computer": res.Computer.Name, "workspace": res.Workspace.Name,
	}
	switch rc.op {
	case "send":
		meta["sessionId"], meta["text"] = rc.sessionID, rc.text
	case "read":
		meta["sessionId"], meta["last"] = rc.sessionID, rc.last
	case "spawn":
		meta["workspaceId"], meta["prompt"], meta["title"], meta["mode"] = rc.workspaceID, rc.prompt, rc.title, rc.mode
		meta["startsOnAsk"] = true
	}
	if res.Session != nil {
		meta["target"] = map[string]any{"sessionId": res.Session.ID, "title": res.Session.Title, "mode": res.Session.Mode, "status": res.Session.Status}
	}
	return meta
}

// callArgs is the coord.<op> call's args, every approval-covered field in it.
func (rc relayCall) callArgs(approvalID string) map[string]any {
	a := map[string]any{"computerId": rc.computerID, "hop": rc.hop, "approvalId": approvalID}
	switch rc.op {
	case "send":
		a["sessionId"], a["text"] = rc.sessionID, rc.text
	case "read":
		a["sessionId"], a["last"] = rc.sessionID, rc.last
	case "spawn":
		a["workspaceId"], a["prompt"], a["title"], a["mode"] = rc.workspaceID, rc.prompt, rc.title, rc.mode
	}
	return a
}

// relayRun is the whole remote call after validation: counters, resolve, the
// card, then the call with the card's id as its approval. The result is Cerea's.
func (at *agentTools) relayRun(ctx context.Context, tc *toolCaller, call backend.ToolCall, rc relayCall) (json.RawMessage, string, error) {
	to := rc.computerID + ":" + rc.sessionID
	if rc.op == "spawn" {
		to = rc.computerID + ":" + rc.workspaceID
	}
	if _, err := at.coordCaller(); err != nil {
		return nil, to, err
	}
	if err := at.relayPreflight(tc, rc.tool); err != nil {
		return nil, to, err
	}
	// The rates refuse before any card, as a local send does; a refused call
	// spends none of a person's attention.
	switch rc.op {
	case "send":
		if err := at.takePair("relay:"+tc.session.ID+">"+to, sendsPerWindow, sendWindow, "send"); err != nil {
			return nil, to, err
		}
	case "read":
		if err := at.takePair("relayread:"+tc.session.ID+">"+to, readsPerWindow, readWindow, "read"); err != nil {
			return nil, to, err
		}
	case "spawn":
		if err := at.takeRemoteSpawn(tc); err != nil {
			return nil, to, err
		}
	}
	// The labels, read live by Cerea. A failure is the call's answer and no
	// card is raised: a card with names nobody checked is the thing to avoid.
	raw, err := at.coordCall(ctx, tc, "resolve", rc.resolveArgs(), coordCallLimit, false)
	if err != nil {
		return nil, to, err
	}
	var resolved coordResolved
	if json.Unmarshal(raw, &resolved) != nil {
		return nil, to, refuse("Cerea's answer was not readable")
	}
	approvalID, err := newAskID()
	if err != nil {
		return nil, to, err
	}
	decision, message, err := at.ask(ctx, tc, call, backend.PermissionRequest{
		ID:       approvalID,
		Tool:     rc.tool,
		Title:    rc.cardTitle(resolved),
		Metadata: rc.cardMetadata(resolved),
	})
	if err != nil {
		return nil, to, err
	}
	if decision != backend.DecisionOnce {
		return nil, to, declined(message)
	}
	// The call itself, with the card's id as its approval. (Literal op names,
	// so the protocol fixtures' completeness check can enumerate them.)
	var res json.RawMessage
	switch rc.op {
	case "send":
		res, err = at.coordCall(ctx, tc, "send", rc.callArgs(approvalID), coordCallLimit, true)
	case "read":
		res, err = at.coordCall(ctx, tc, "read", rc.callArgs(approvalID), coordCallLimit, false)
	default:
		res, err = at.coordCall(ctx, tc, "spawn", rc.callArgs(approvalID), coordCallLimit, true)
	}
	if err != nil {
		return nil, to, err
	}
	return res, to, nil
}

func (rc relayCall) cardTitle(res coordResolved) string {
	switch rc.op {
	case "send":
		return fmt.Sprintf("Send a message to a session on %s", res.Computer.Name)
	case "read":
		return fmt.Sprintf("Read messages from a session on %s", res.Computer.Name)
	}
	return fmt.Sprintf("Start a new session on %s", res.Computer.Name)
}

// relayRead implements session_read for a session of another computer.
func (at *agentTools) relayRead(ctx context.Context, tc *toolCaller, call backend.ToolCall, computerID, sessionID string, last int) (string, string, error) {
	if last == 0 {
		last = readDefaultLast
	}
	if last > readMaxLast {
		last = readMaxLast
	}
	rc := relayCall{op: "read", tool: "session_read", computerID: computerID, sessionID: sessionID, last: last, hop: at.nextHop(tc.session.ID)}
	raw, to, err := at.relayRun(ctx, tc, call, rc)
	if err != nil {
		return "", to, err
	}
	var res struct {
		Text      string `json:"text"`
		Truncated bool   `json:"truncated"`
	}
	if json.Unmarshal(raw, &res) != nil {
		return "", to, refuse("Cerea's answer was not readable")
	}
	return res.Text, to, nil
}

// relaySend implements session_send for a session of another computer.
func (at *agentTools) relaySend(ctx context.Context, tc *toolCaller, call backend.ToolCall, computerID, sessionID, text string) (string, string, error) {
	to := computerID + ":" + sessionID
	if strings.TrimSpace(text) == "" {
		return "", to, refuse("text is required")
	}
	if len(text) > maxToolText {
		return "", to, refuse("text is longer than %d bytes; shorten it", maxToolText)
	}
	hop := at.nextHop(tc.session.ID)
	if hop > maxHop {
		return "", to, refuse(relayHopMessage, maxHop)
	}
	rc := relayCall{op: "send", tool: "session_send", computerID: computerID, sessionID: sessionID, text: text, hop: hop}
	_, to, err := at.relayRun(ctx, tc, call, rc)
	if err != nil {
		return "", to, err
	}
	body, _ := json.Marshal(map[string]any{"delivered": true, "target": to,
		"note": "the message was delivered; any answer arrives as a message from that session, after the person approves it there"})
	return string(body), to, nil
}

// relaySpawn implements session_spawn with `computer` and `workspaceId`.
func (at *agentTools) relaySpawn(ctx context.Context, tc *toolCaller, call backend.ToolCall, computerID, workspaceID string, spec spawnSpec) (string, string, error) {
	to := computerID + ":" + workspaceID
	title, prompt := strings.TrimSpace(spec.title), spec.prompt
	if title == "" || len(title) > 200 {
		return "", to, refuse("title is required (at most 200 characters)")
	}
	if strings.TrimSpace(prompt) == "" {
		return "", to, refuse("prompt is required")
	}
	if len(prompt) > maxToolText {
		return "", to, refuse("prompt is longer than %d bytes; shorten it or put the detail in a file the new session can read", maxToolText)
	}
	if strings.TrimSpace(spec.profile) != "" {
		return "", to, refuse("a profile cannot be named for a session on another computer: it starts on that computer's own default model")
	}
	mode := strings.TrimSpace(spec.mode)
	switch mode {
	case "", "inherit":
		mode = "build"
	case "plan", "build":
	default:
		return "", to, refuse("mode %q is not available on another computer: use \"plan\" or \"build\"", mode)
	}
	hop := at.nextHop(tc.session.ID)
	if hop > maxHop {
		return "", to, refuse(relayHopMessage, maxHop)
	}
	rc := relayCall{op: "spawn", tool: "session_spawn", computerID: computerID, workspaceID: workspaceID, title: title, prompt: prompt, mode: mode, hop: hop}
	raw, to, err := at.relayRun(ctx, tc, call, rc)
	if err != nil {
		return "", to, err
	}
	var res map[string]any
	if json.Unmarshal(raw, &res) != nil {
		return "", to, refuse("Cerea's answer was not readable")
	}
	if id, _ := res["sessionId"].(string); id != "" {
		res["target"] = computerID + ":" + id
	}
	res["permissionMode"] = string(permrules.Ask)
	res["fireAndForget"] = true
	res["note"] = "it starts on Ask under that computer's own limits and does not report back; read it with session_read (the person approves each read)"
	body, _ := json.Marshal(res)
	return string(body), to, nil
}

// newAskID mints the id of a relayed call's card: galopin's own prefix and 8
// random bytes. The card's id is the call's approvalId.
func newAskID() (string, error) {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return "gp_" + hex.EncodeToString(raw), nil
}
