package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"galopin/internal/backend"
	"galopin/internal/permrules"
	"galopin/internal/workspaces"
)

// The agent-coordination tools (PROTOCOL.md §6 "Agent tools"): the machine's
// half. The backend relays a tool call here with the calling session's id;
// this file gates it, raises galopin's own approval, and does the work. The
// numbers below are the specified limits.
const (
	// maxSpawnDepth: a session at this depth in the spawn chain cannot spawn.
	maxSpawnDepth = 2
	// maxLivePerRoot: spawned sessions that are live at once, per spawn root.
	maxLivePerRoot = 3
	// spawnsPerWindow attempts per root within spawnWindow.
	spawnsPerWindow = 6
	spawnWindow     = 10 * time.Minute
	// maxHop is the highest hop a session_send may carry.
	maxHop = 3
	// sendsPerWindow per ordered sender→target pair within sendWindow.
	sendsPerWindow = 5
	sendWindow     = time.Minute
	// maxToolText caps a spawn prompt / send text, so a card never shows a
	// truncation the model did not make.
	maxToolText = 8 << 10
	// spawnLiveGrace: a spawned session counts as live this long even before
	// its first busy status arrives.
	spawnLiveGrace = 30 * time.Second
	// callVerifyWait: how long a relayed call waits for its own tool part to
	// show up on the event stream before it is refused as unverifiable.
	callVerifyWait = 5 * time.Second
)

// agentTools is the machine's coordination state: the rate windows. The
// spawn tree itself lives in the backend's persisted markers.
type agentTools struct {
	mc   *machine
	host backend.ToolHost
	now  func() time.Time

	mu       sync.Mutex
	spawnLog map[string][]time.Time // root session -> spawn attempts
	sendLog  map[string][]time.Time // "from>to" -> sends
	born     map[string]time.Time   // spawned session -> when
}

// installAgentTools wires the tools when the backend has them.
func (mc *machine) installAgentTools() {
	host, ok := mc.back.(backend.ToolHost)
	if !ok || !mc.back.Capabilities().AgentTools || !mc.pol.AgentToolsAllowed() {
		return
	}
	at := &agentTools{
		mc: mc, host: host, now: time.Now,
		spawnLog: map[string][]time.Time{}, sendLog: map[string][]time.Time{}, born: map[string]time.Time{},
	}
	mc.agentTools = at
	host.SetToolHandler(at.handle)
}

func refuse(format string, args ...any) error {
	return &backend.ToolRefusal{Message: fmt.Sprintf(format, args...)}
}

// handle is the backend.ToolHandler: verify the caller, then dispatch.
func (at *agentTools) handle(ctx context.Context, call backend.ToolCall) (string, error) {
	if err := at.verifyCaller(ctx, call); err != nil {
		at.mc.audit.agentTool(call.Tool, call.SessionID, "", "refused", "unverified caller")
		return "", err
	}
	dir, workspaceID, operr := at.mc.resolveSession(call.SessionID)
	if operr != nil {
		at.mc.audit.agentTool(call.Tool, call.SessionID, "", "refused", "session not tracked")
		return "", refuse("this session is not one galopin tracks; tools that coordinate sessions are unavailable in it")
	}
	caller, err := at.mc.back.GetSession(ctx, dir, call.SessionID)
	if err != nil {
		return "", err
	}
	tc := &toolCaller{dir: dir, workspaceID: workspaceID, session: caller}
	var out, reason string
	var to string
	switch call.Tool {
	case "session_list":
		out, err = at.list(ctx, tc)
	case "session_spawn":
		out, to, err = at.spawn(ctx, tc, call)
	case "session_send":
		out, to, err = at.send(ctx, tc, call)
	default:
		err = refuse("unknown tool %q", call.Tool)
	}
	switch {
	case err == nil:
		at.mc.audit.agentTool(call.Tool, call.SessionID, to, "done", "")
	default:
		if r, ok := err.(*backend.ToolRefusal); ok {
			reason = r.Message
		} else {
			reason = "failed"
		}
		if ctx.Err() != nil {
			reason = "aborted"
		}
		at.mc.audit.agentTool(call.Tool, call.SessionID, to, "refused", reason)
	}
	return out, err
}

type toolCaller struct {
	dir, workspaceID string
	session          backend.Session
}

// verifyCaller proves the relayed call is a real, unfinished call of that
// tool in that session: the event stream must show a matching tool part. A
// session id alone (anyone holding the relay token can write one) never
// borrows another session's standing.
func (at *agentTools) verifyCaller(ctx context.Context, call backend.ToolCall) error {
	if call.CallID == "" {
		return refuse("this call carries no call id, so galopin cannot tell which session made it")
	}
	deadline := time.Now().Add(callVerifyWait)
	for {
		if at.mc.mat.ActiveToolCall(call.SessionID, call.Tool, call.CallID) {
			return nil
		}
		if time.Now().After(deadline) {
			return refuse("galopin could not match this call to a running %s call in the session", call.Tool)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// listed is one session of the machine's fresh listing.
type listed struct {
	s  backend.Session
	ws workspaces.Workspace
}

// allSessions is the machine's non-archived sessions, tracked as a side
// effect (as session.list does), so a galopin restarted since they were
// created still addresses them.
func (at *agentTools) allSessions(ctx context.Context) ([]listed, error) {
	var all []listed
	var flat []backend.Session
	var wsIDs []string
	for _, w := range at.mc.workspaces.List(false) {
		list, err := at.mc.back.ListSessions(ctx, w.Path)
		if err != nil {
			return nil, err
		}
		for _, s := range list {
			at.mc.trackSession(w, s)
			flat = append(flat, s)
			wsIDs = append(wsIDs, w.ID)
			all = append(all, listed{s: s, ws: w})
		}
	}
	enriched := at.mc.enrichAll(flat, wsIDs)
	for i := range all {
		all[i].s = enriched[i]
	}
	return all, nil
}

func modeLabel(id string) string {
	if id == "" {
		return "default"
	}
	return id
}

// list implements session_list: top-level sessions only (a subagent is part
// of its parent's tree and is addressed with task, not session_send).
func (at *agentTools) list(ctx context.Context, tc *toolCaller) (string, error) {
	all, err := at.allSessions(ctx)
	if err != nil {
		return "", err
	}
	type row struct {
		SessionID   string             `json:"sessionId"`
		Title       string             `json:"title"`
		WorkspaceID string             `json:"workspaceId"`
		Workspace   string             `json:"workspace"`
		Mode        string             `json:"mode"`
		Status      string             `json:"status"`
		SpawnedBy   *backend.SpawnedBy `json:"spawnedBy,omitempty"`
		Note        string             `json:"note,omitempty"`
	}
	callerRoot := at.mc.mat.RootOf(tc.session.ID)
	rows := []row{}
	for _, l := range all {
		if l.s.ParentID != "" {
			continue
		}
		r := row{
			SessionID: l.s.ID, Title: l.s.Title, WorkspaceID: l.ws.ID, Workspace: l.ws.Name,
			Mode: modeLabel(l.s.ModeID), Status: string(l.s.Status), SpawnedBy: l.s.SpawnedBy,
		}
		if at.mc.mat.RootOf(l.s.ID) == callerRoot {
			r.Note = "your own session tree: not a session_send target"
		}
		rows = append(rows, r)
	}
	body, err := json.Marshal(rows)
	return string(body), err
}

// spawnChain follows a session's spawnedBy links to the top: its depth (0 for
// a session nobody spawned) and its root.
func spawnChain(marks map[string]backend.SpawnedBy, id string) (depth int, root string) {
	root = id
	for i := 0; i < 16; i++ { // bounded: a marker cycle must not loop
		m, ok := marks[root]
		if !ok {
			return depth, root
		}
		depth++
		root = m.SessionID
	}
	return depth, root
}

// spawnMode resolves the mode a spawned session gets and whether that is an
// ESCALATION: a mode that may be less restricted than the caller's. It returns
// the caller's own mode for "" / "inherit" ("" = the backend's default, which is
// the caller's own when it has none). Equal to the caller's, or "plan" (the
// read-only built-in), is no escalation; any other name could be less
// restricted than the caller and galopin has no order to compare modes by. An
// escalation is not refused: it always shows the card, whatever the machine's
// rule for session_spawn says, and the card names the mode and the caller's.
func spawnMode(callerMode, requested string) (mode string, escalates bool) {
	requested = strings.TrimSpace(requested)
	if requested == "" || requested == "inherit" {
		return callerMode, false
	}
	if requested == callerMode || requested == "plan" {
		return requested, false
	}
	return requested, true
}

func (at *agentTools) liveSpawnedUnder(root string, marks map[string]backend.SpawnedBy, byID map[string]backend.Session) int {
	at.mu.Lock()
	defer at.mu.Unlock()
	n := 0
	now := at.now()
	for id := range marks {
		if _, r := spawnChain(marks, id); r != root {
			continue
		}
		s, exists := byID[id]
		if !exists {
			continue // archived or deleted
		}
		st := s.Status
		if status, ok := at.mc.mat.Status(id); ok && status != "" {
			st = status
		}
		if st != backend.StatusIdle || at.mc.mat.PendingPermissions(id) > 0 || now.Sub(at.born[id]) < spawnLiveGrace {
			n++
		}
	}
	return n
}

// recent drops entries older than the window and reports how many remain.
func recent(log []time.Time, now time.Time, window time.Duration) []time.Time {
	kept := log[:0]
	for _, t := range log {
		if now.Sub(t) < window {
			kept = append(kept, t)
		}
	}
	return kept
}

func decodeArgs(raw []byte, allowed ...string) (map[string]string, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, refuse("the arguments are not a JSON object")
	}
	ok := map[string]bool{}
	for _, k := range allowed {
		ok[k] = true
	}
	out := map[string]string{}
	for k, v := range m {
		if !ok[k] {
			return nil, refuse("unsupported argument %q (allowed: %s)", k, strings.Join(allowed, ", "))
		}
		var s string
		if err := json.Unmarshal(v, &s); err != nil {
			return nil, refuse("argument %q must be a string", k)
		}
		out[k] = s
	}
	return out, nil
}

// spawn implements session_spawn; the second result is the child id for the
// audit row.
func (at *agentTools) spawn(ctx context.Context, tc *toolCaller, call backend.ToolCall) (string, string, error) {
	// A workspaceId/directory-shaped argument is refused, not ignored: the
	// workspace is always the caller's own.
	args, err := decodeArgs(call.Args, "title", "prompt", "mode")
	if err != nil {
		return "", "", err
	}
	title, prompt := strings.TrimSpace(args["title"]), args["prompt"]
	if title == "" || len(title) > 200 {
		return "", "", refuse("title is required (at most 200 characters)")
	}
	if strings.TrimSpace(prompt) == "" {
		return "", "", refuse("prompt is required")
	}
	if len(prompt) > maxToolText {
		return "", "", refuse("prompt is longer than %d bytes; shorten it or put the detail in a file the new session can read", maxToolText)
	}
	if _, ok := at.mc.workspaces.Get(tc.workspaceID); !ok {
		return "", "", refuse("this session's workspace is no longer registered")
	}
	// The machine's rules decide whether this needs a card at all: allow runs
	// it unasked, deny refuses it (before it spends any of the rate budget),
	// anything else is a gp_ card.
	grant, err := at.grant(ctx, tc, "session_spawn")
	if err != nil {
		return "", "", err
	}
	childMode, escalates := spawnMode(tc.session.ModeID, args["mode"])
	if childMode != "" {
		modes, merr := at.mc.back.Modes(ctx, tc.dir)
		if merr != nil {
			return "", "", merr
		}
		found := false
		for _, m := range modes {
			found = found || m.ID == childMode
		}
		if !found {
			return "", "", refuse("mode %q does not exist in this workspace", childMode)
		}
	}
	// The child runs on the caller's model, under the same free-model gate as
	// session.setModel.
	if tc.session.ModelID != "" && !at.mc.pol.AllowFreeModels && len(at.mc.pol.FilterModelIDs([]string{tc.session.ModelID})) == 0 {
		return "", "", refuse("model %q is not a gateway model, and this machine does not allow free models", tc.session.ModelID)
	}

	// Fork-bomb limits, all before any ask is raised.
	marks := at.host.SpawnMarks()
	depth, root := spawnChain(marks, tc.session.ID)
	if depth >= maxSpawnDepth {
		return "", "", refuse("spawn chain limit: sessions spawned %d deep cannot spawn further", maxSpawnDepth)
	}
	all, err := at.allSessions(ctx)
	if err != nil {
		return "", "", err
	}
	byID := map[string]backend.Session{}
	for _, l := range all {
		byID[l.s.ID] = l.s
	}
	if n := at.liveSpawnedUnder(root, marks, byID); n >= maxLivePerRoot {
		return "", "", refuse("live spawn limit: %d spawned sessions are already running under this root; wait for one to finish", n)
	}
	at.mu.Lock()
	now := at.now()
	at.spawnLog[root] = recent(at.spawnLog[root], now, spawnWindow)
	if len(at.spawnLog[root]) >= spawnsPerWindow {
		at.mu.Unlock()
		return "", "", refuse("spawn rate limit: at most %d spawns per %d minutes", spawnsPerWindow, int(spawnWindow.Minutes()))
	}
	at.spawnLog[root] = append(at.spawnLog[root], now)
	at.mu.Unlock()

	// An allow skips the card unless the child could be less restricted than
	// its caller: then a person decides, seeing both modes.
	auto := grant == permrules.Allow && !escalates
	meta := map[string]any{
		"title": title, "modeId": modeLabel(childMode), "modelId": nilIfEmpty(tc.session.ModelID),
		"workspaceId": tc.workspaceID, "prompt": prompt,
	}
	if escalates {
		meta["escalates"] = true
		meta["callerModeId"] = modeLabel(tc.session.ModeID)
	}
	decision, message, err := at.approve(ctx, tc, call, auto, "", reasonAllowedByRules, backend.PermissionRequest{
		Tool:     "session_spawn",
		Title:    "Start a new session: " + title,
		Metadata: meta,
	})
	if err != nil {
		return "", "", err
	}
	if decision != backend.DecisionOnce {
		return "", "", declined(message)
	}

	w, _ := at.mc.workspaces.Get(tc.workspaceID)
	child, err := at.mc.back.CreateSession(ctx, tc.dir, backend.CreateSessionOptions{
		Title: title, ModeID: childMode, ModelID: tc.session.ModelID,
		SpawnedBy: &backend.SpawnedBy{SessionID: tc.session.ID, Title: tc.session.Title},
	})
	if err != nil {
		return "", "", err
	}
	at.mc.trackSession(w, child)
	at.mc.auditProjectConfig(w, child.ID)
	// The child starts with auto-accept off, whatever the caller or an
	// ancestor has: it is a fresh top-level session, and this says so
	// explicitly (an explicit off, so nothing it later inherits can turn it on).
	_ = at.mc.mat.SetAutoAccept(child.ID, false)
	at.mu.Lock()
	at.born[child.ID] = at.now()
	at.mu.Unlock()
	if err := at.mc.back.Prompt(ctx, tc.dir, child.ID, backend.Prompt{Text: prompt}); err != nil {
		return "", child.ID, refuse("the new session %q was created but its first prompt was not accepted: %v", child.ID, err)
	}
	result := map[string]any{"sessionId": child.ID, "title": title, "mode": modeLabel(childMode)}
	if auto {
		result["autoApproved"] = true
	}
	body, _ := json.Marshal(result)
	return string(body), child.ID, nil
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func declined(message string) error {
	if strings.TrimSpace(message) != "" {
		return refuse("The person declined this: %s", message)
	}
	return refuse("The person declined this.")
}

// ask raises galopin's own approval for the call and waits for the answer.
func (at *agentTools) ask(ctx context.Context, tc *toolCaller, call backend.ToolCall, req backend.PermissionRequest) (backend.Decision, string, error) {
	req.CallID = call.CallID
	req.MessageID = call.MessageID
	return at.host.Ask(ctx, tc.dir, tc.session.ID, req)
}

// reasonAllowedByRules is the audit reason of a call this machine's rules let
// through without a card (decision "allow").
const reasonAllowedByRules = "rule"

// grant is the machine's rule for one of galopin's two coordination tools,
// read from the asking session's opencode rules (the agent's, then the ones
// galopin applied) by the tool's name. deny returns a refusal the model reads;
// the caller turns allow into no card and ask into one. A backend that cannot
// show its rules answers ask: a card is the safe reading of "unknown".
func (at *agentTools) grant(ctx context.Context, tc *toolCaller, tool string) (permrules.Action, error) {
	rh, ok := at.mc.back.(backend.RuleHost)
	if !ok {
		return permrules.Ask, nil
	}
	rules, err := rh.EffectiveRules(ctx, tc.dir, tc.session.ID)
	if err != nil {
		// Unreadable rules are not consent.
		return permrules.Ask, nil
	}
	if permrules.Grant(rules, tool) == permrules.Deny {
		return permrules.Deny, refuse("this machine's rules do not allow %s", tool)
	}
	return permrules.Grant(rules, tool), nil
}

// approve is the decision before the ask: when allowed is true the machine's
// rules said allow, the call is approved here — audited as decision "allow"
// with reason "rule", no gp_ ask raised, so no card — and otherwise galopin's
// own approval is raised (never answered by the responder, "always" read as
// once). Only this path sets autoApproved in a tool's result.
func (at *agentTools) approve(ctx context.Context, tc *toolCaller, call backend.ToolCall, allowed bool, to, reason string, req backend.PermissionRequest) (backend.Decision, string, error) {
	if allowed {
		at.mc.audit.agentTool(call.Tool, tc.session.ID, to, "allow", reason)
		return backend.DecisionOnce, "", nil
	}
	return at.ask(ctx, tc, call, req)
}

// send implements session_send.
func (at *agentTools) send(ctx context.Context, tc *toolCaller, call backend.ToolCall) (string, string, error) {
	args, err := decodeArgs(call.Args, "target", "text")
	if err != nil {
		return "", "", err
	}
	targetID, text := strings.TrimSpace(args["target"]), args["text"]
	if targetID == "" {
		return "", "", refuse("target is required (a session id from session_list)")
	}
	if strings.TrimSpace(text) == "" {
		return "", "", refuse("text is required")
	}
	if len(text) > maxToolText {
		return "", targetID, refuse("text is longer than %d bytes; shorten it", maxToolText)
	}
	if targetID == tc.session.ID {
		return "", targetID, refuse("you cannot send to yourself")
	}
	all, err := at.allSessions(ctx)
	if err != nil {
		return "", "", err
	}
	var target *listed
	for i := range all {
		if all[i].s.ID == targetID {
			target = &all[i]
		}
	}
	if target == nil {
		return "", targetID, refuse("no such session on this machine (or it is archived): %q; use session_list", targetID)
	}
	if target.s.ParentID != "" {
		return "", targetID, refuse("that is a subagent, not an addressable session; use task for your own subagents")
	}
	if at.mc.mat.RootOf(targetID) == at.mc.mat.RootOf(tc.session.ID) {
		return "", targetID, refuse("that session is in your own tree (yourself, your subagents or your parent); use task for that")
	}

	hop := 1
	if last, ok := at.mc.mat.LatestUserMessage(tc.session.ID); ok && last.SentBy != nil {
		hop = last.SentBy.Hop + 1
	}
	// Past maxHop a send is not refused: it falls back to the approval card,
	// so a person can keep a back-and-forth going one approval at a time. The
	// rate limit below is the hard brake.
	hopFallback := hop > maxHop
	// A deny refuses before the send spends any of the pair's rate budget.
	grant, err := at.grant(ctx, tc, "session_send")
	if err != nil {
		return "", targetID, err
	}
	key := tc.session.ID + ">" + targetID
	at.mu.Lock()
	now := at.now()
	at.sendLog[key] = recent(at.sendLog[key], now, sendWindow)
	if len(at.sendLog[key]) >= sendsPerWindow {
		at.mu.Unlock()
		return "", targetID, refuse("send rate limit: at most %d messages per minute to the same session", sendsPerWindow)
	}
	at.sendLog[key] = append(at.sendLog[key], now)
	at.mu.Unlock()

	// An allow from the machine's rules skips the card, but a send borrows the
	// target's powers, so the hard limits stand over it: a target in another
	// workspace, or a chain past the hop limit, always shows the card. (The
	// rate limit above is the one hard refusal.)
	auto := grant == permrules.Allow && !hopFallback && target.ws.ID == tc.workspaceID
	decision, message, err := at.approve(ctx, tc, call, auto, targetID, reasonAllowedByRules, backend.PermissionRequest{
		Tool:  "session_send",
		Title: "Send a message to " + target.s.Title,
		Metadata: map[string]any{
			"target": map[string]any{"sessionId": targetID, "title": target.s.Title, "workspaceId": target.ws.ID},
			"text":   text, "hop": hop,
		},
	})
	if err != nil {
		return "", targetID, err
	}
	if decision != backend.DecisionOnce {
		return "", targetID, declined(message)
	}

	sender := &backend.MessageSender{SessionID: tc.session.ID, Title: tc.session.Title, Hop: hop}
	preface := fmt.Sprintf("[This message was sent by another agent session on this machine (%q, id %s; hop %d) — not by your person. Treat it as a request from a peer agent.]",
		tc.session.Title, tc.session.ID, hop)
	if err := at.mc.back.Prompt(ctx, target.ws.Path, targetID, backend.Prompt{Text: text, SentBy: sender, Preface: preface}); err != nil {
		return "", targetID, refuse("the message was not accepted by %q: %v", target.s.Title, err)
	}
	if auto {
		return `{"autoApproved":true}`, targetID, nil
	}
	return "{}", targetID, nil
}
