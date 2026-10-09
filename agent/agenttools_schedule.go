package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"galopin/internal/backend"
	"galopin/internal/link"
	"galopin/internal/permrules"
)

// The schedule tools (PROTOCOL.md §6 "Agent tools", §5 "Machine calls"): a
// session's agent lists, creates, updates and deletes its owner's scheduled
// actions. Schedules live in Cerea, so each tool is a machine call over the
// link; this file gates it first. One permission key, `schedule`, covers the
// three mutating tools, both as a rule and in the ceiling.

const (
	// scheduleKey is the permission key of the mutating schedule tools.
	scheduleKey = "schedule"
	// schedulesPerWindow mutating calls per root session within scheduleWindow,
	// counted before any card, like spawns.
	schedulesPerWindow = 5
	scheduleWindow     = 10 * time.Minute
	// maxScheduleName bounds a schedule's name.
	maxScheduleName = 200
)

// machineCaller is the link's call half (link.Link), an interface so the
// tests can stand a fake Cerea in.
type machineCaller interface {
	Call(ctx context.Context, c link.Call) (json.RawMessage, *link.OpError)
	Supports(family string) bool
}

// scheduleCaller is the CallerFacts Cerea checks a call against (PROTOCOL.md
// §5): the session's workspace, and its root's selector word and grant.
type scheduleCaller struct {
	WorkspaceID    string   `json:"workspaceId"`
	PermissionMode string   `json:"permissionMode"`
	Coordination   []string `json:"coordination"`
}

// scheduleOutcome is what the gate makes of one schedule tool call.
type scheduleOutcome string

const (
	scheduleAuto   scheduleOutcome = "auto"   // no card
	scheduleAsk    scheduleOutcome = "ask"    // galopin's own card
	scheduleRefuse scheduleOutcome = "refuse" // refused before any card
)

// scheduleFacts are the inputs of the decision (PROTOCOL.md §6 "Schedule
// tools"): the tool, the ceiling's word for `schedule`, the rule's word
// (the session's Deny/Ask/Allow, which covers it, and the machine's own
// rules), whether the machine's own rules deny `schedule` outright, whether
// the calling session is a scheduled run, and whether the call only stops one
// of that run's own schedules.
type scheduleFacts struct {
	tool         string
	ceiling      permrules.Action
	grant        permrules.Action
	machineDeny  bool
	scheduledRun bool
	selfStop     bool
}

// decideSchedule is the whole decision table. Its order matters, and the
// tests pin it: the ceiling's deny and the machine's own deny refuse, a
// ceiling of ask always shows the card, a run stopping its own schedule goes
// through (even under the session's Deny: stopping only reduces activity),
// the session's Deny refuses the rest, and only then do the tool's own rules
// apply.
//
//   - schedule_list: never a card; refused only when the ceiling denies.
//   - schedule_create: like an ordinary tool (Allow covers it, Ask cards, Deny
//     refuses) — except from a scheduled run, which always cards (the runaway
//     guard), whatever the rule says.
//   - schedule_update / schedule_delete: no card when the call only pauses or
//     deletes a schedule the caller is a run of; a card for anything else,
//     whatever the rule says.
func decideSchedule(f scheduleFacts) (scheduleOutcome, string) {
	if f.ceiling == permrules.Deny {
		return scheduleRefuse, "this machine's ceiling does not allow agents to manage schedules"
	}
	if f.tool == "schedule_list" {
		return scheduleAuto, ""
	}
	if f.machineDeny {
		return scheduleRefuse, "this machine's rules do not allow schedule changes"
	}
	if f.ceiling == permrules.Ask {
		return scheduleAsk, "ceiling"
	}
	if f.tool != "schedule_create" && f.selfStop {
		return scheduleAuto, "own schedule"
	}
	if f.grant == permrules.Deny {
		return scheduleRefuse, "this session's permissions (Deny) do not allow schedule changes"
	}
	switch f.tool {
	case "schedule_create":
		if f.scheduledRun {
			return scheduleAsk, "scheduled run"
		}
		if f.grant == permrules.Allow {
			return scheduleAuto, reasonAllowedByRules
		}
		return scheduleAsk, "rule"
	default:
		return scheduleAsk, "not own schedule"
	}
}

// earlyRefusal is decideSchedule's refusal before Cerea is asked anything:
// with what is not yet known (a scheduled run, self) read in the caller's
// favour, so a refusal here is one the full facts would give too.
func earlyRefusal(f scheduleFacts) error {
	f.scheduledRun = false
	f.selfStop = f.tool != "schedule_create"
	if outcome, reason := decideSchedule(f); outcome == scheduleRefuse {
		return refuse("%s", reason)
	}
	return nil
}

// scheduleFactsFor is the facts known before any machine call.
func (at *agentTools) scheduleFactsFor(ctx context.Context, tc *toolCaller, tool string) scheduleFacts {
	return scheduleFacts{
		tool: tool, ceiling: at.scheduleCeiling(), grant: at.scheduleGrant(ctx, tc),
		machineDeny: at.mc.pol.Permission.Rules[scheduleKey] == string(permrules.Deny),
	}
}

// scheduleGrant is the session's word for `schedule`. The blanket Allow covers
// it (the owner's choice), as it does `session_spawn` and `session_send`:
// under Allow the rules are read as they are, the blanket's `*: allow`
// included; under Ask or Deny a wildcard allow says nothing (permrules.Grant),
// so only the machine's own `schedule` rule can lift it. Either way the
// ceiling's tail, last in the rules, caps it. Unreadable rules are not consent.
func (at *agentTools) scheduleGrant(ctx context.Context, tc *toolCaller) permrules.Action {
	rh, ok := at.mc.back.(backend.RuleHost)
	if !ok {
		return permrules.Ask
	}
	rules, err := rh.EffectiveRules(ctx, tc.dir, tc.session.ID)
	if err != nil {
		return permrules.Ask
	}
	return scheduleGrantFrom(rules, rh.PermissionMode(tc.session.ID))
}

// scheduleGrantFrom is scheduleGrant on a session's rules and its mode word.
func scheduleGrantFrom(rules []permrules.Rule, mode permrules.Action) permrules.Action {
	if mode == permrules.Allow {
		return permrules.Evaluate(rules, scheduleKey, "*")
	}
	return permrules.Grant(rules, scheduleKey)
}

func (at *agentTools) scheduleCeiling() permrules.Action {
	return at.mc.pol.Permission.Ceiling().Of(scheduleKey)
}

func (at *agentTools) callerFacts(tc *toolCaller) scheduleCaller {
	c := scheduleCaller{WorkspaceID: tc.workspaceID, PermissionMode: string(permrules.Ask), Coordination: []string{}}
	if rh, ok := at.mc.back.(backend.RuleHost); ok {
		c.PermissionMode = string(rh.PermissionMode(tc.session.ID))
		if keys := rh.Coordination(tc.session.ID); len(keys) > 0 {
			c.Coordination = keys
		}
	}
	return c
}

func (at *agentTools) machineCalls() machineCaller {
	if at.calls != nil {
		return at.calls
	}
	if at.mc.lnk == nil {
		return nil
	}
	return at.mc.lnk
}

// cereaCall makes one schedule.<op> call for the calling session and turns
// every failure into a refusal the model can read.
func (at *agentTools) cereaCall(ctx context.Context, tc *toolCaller, op string, args any) (json.RawMessage, error) {
	mcalls := at.machineCalls()
	if mcalls == nil {
		return nil, refuse("Cerea is not reachable from this machine right now; try again later")
	}
	if !mcalls.Supports(scheduleKey) {
		return nil, refuse("this Cerea does not support schedules from agents; update it")
	}
	res, operr := mcalls.Call(ctx, link.Call{
		Op: "schedule." + op, SessionID: tc.session.ID, RootSessionID: at.mc.mat.RootOf(tc.session.ID),
		Caller: at.callerFacts(tc), Args: args,
	})
	if operr != nil {
		switch operr.Code {
		case "unavailable":
			return nil, refuse("Cerea is not reachable right now (%s); try again later", operr.Message)
		case "unsupported":
			return nil, refuse("this Cerea does not support schedules from agents; update it")
		}
		return nil, refuse("Cerea refused this (%s): %s", operr.Code, operr.Message)
	}
	return res, nil
}

// scheduleItem is the part of a schedule.list item galopin reads.
type scheduleItem struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	RecurrenceText string   `json:"recurrenceText"`
	Timezone       string   `json:"timezone"`
	Paused         bool     `json:"paused"`
	Workspace      any      `json:"workspace"`
	Session        string   `json:"session"`
	PermissionMode string   `json:"permissionMode"`
	Coordination   []string `json:"coordination"`
	Self           bool     `json:"self"`
}

// findSchedule is one of this device's schedules by id, from a fresh list.
func (at *agentTools) findSchedule(ctx context.Context, tc *toolCaller, id string) (scheduleItem, error) {
	raw, err := at.cereaCall(ctx, tc, "list", map[string]any{})
	if err != nil {
		return scheduleItem{}, err
	}
	var list struct {
		Schedules []scheduleItem `json:"schedules"`
	}
	if json.Unmarshal(raw, &list) != nil {
		return scheduleItem{}, refuse("Cerea's schedule list was not readable")
	}
	for _, s := range list.Schedules {
		if s.ID == id {
			return s, nil
		}
	}
	return scheduleItem{}, refuse("no schedule %q on this machine; use schedule_list", id)
}

// scheduleContext asks Cerea whether the caller is a scheduled run.
func (at *agentTools) scheduleContext(ctx context.Context, tc *toolCaller) (string, error) {
	raw, err := at.cereaCall(ctx, tc, "context", map[string]any{})
	if err != nil {
		return "", err
	}
	var c struct {
		ScheduledRunOf *string `json:"scheduledRunOf"`
	}
	if json.Unmarshal(raw, &c) != nil {
		// Unknown is not "not a run": the guard reads it as one.
		return "unknown", nil
	}
	if c.ScheduledRunOf == nil {
		return "", nil
	}
	return *c.ScheduledRunOf, nil
}

// scheduleFields are the create/update fields, decoded strictly.
type scheduleFields struct {
	Name           *string          `json:"name,omitempty"`
	Prompt         *string          `json:"prompt,omitempty"`
	Recurrence     *json.RawMessage `json:"recurrence,omitempty"`
	Timezone       *string          `json:"timezone,omitempty"`
	WorkspaceID    *string          `json:"workspaceId,omitempty"`
	Session        *string          `json:"session,omitempty"`
	PermissionMode *string          `json:"permissionMode,omitempty"`
	AgentMode      *string          `json:"agentMode,omitempty"`
	Coordination   *[]string        `json:"coordination,omitempty"`
	Paused         *bool            `json:"paused,omitempty"`
}

// decodeObject reads a JSON object, refusing any key not in allowed.
func decodeObject(raw []byte, what string, allowed ...string) (map[string]json.RawMessage, error) {
	var m map[string]json.RawMessage
	if len(raw) == 0 || string(raw) == "null" {
		return map[string]json.RawMessage{}, nil
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, refuse("%s is not a JSON object", what)
	}
	ok := map[string]bool{}
	for _, k := range allowed {
		ok[k] = true
	}
	for k := range m {
		if !ok[k] {
			return nil, refuse("unsupported key %q in %s (allowed: %s)", k, what, strings.Join(allowed, ", "))
		}
	}
	return m, nil
}

// readFields decodes the schedule fields present in m. An empty string (and
// an empty coordination list for create) means "not given": opencode makes
// every tool argument required, so the model passes "" for a default.
func readFields(m map[string]json.RawMessage) (scheduleFields, error) {
	var f scheduleFields
	str := func(key string, dst **string) error {
		v, ok := m[key]
		if !ok || string(v) == "null" {
			return nil
		}
		var s string
		if json.Unmarshal(v, &s) != nil {
			return refuse("%s must be a string", key)
		}
		if strings.TrimSpace(s) == "" {
			return nil
		}
		*dst = &s
		return nil
	}
	for key, dst := range map[string]**string{
		"name": &f.Name, "prompt": &f.Prompt, "timezone": &f.Timezone, "workspaceId": &f.WorkspaceID,
		"session": &f.Session, "permissionMode": &f.PermissionMode, "agentMode": &f.AgentMode,
	} {
		if err := str(key, dst); err != nil {
			return f, err
		}
	}
	if v, ok := m["recurrence"]; ok && string(v) != "null" && string(v) != `""` {
		var probe map[string]any
		if json.Unmarshal(v, &probe) != nil {
			return f, refuse("recurrence must be an object such as {\"type\":\"daily\",\"at\":\"09:00\"}")
		}
		rv := v
		f.Recurrence = &rv
	}
	if v, ok := m["coordination"]; ok && string(v) != "null" {
		var keys []string
		if json.Unmarshal(v, &keys) != nil {
			return f, refuse("coordination must be a list of strings")
		}
		f.Coordination = &keys
	}
	if v, ok := m["paused"]; ok && string(v) != "null" {
		var b bool
		if json.Unmarshal(v, &b) != nil {
			return f, refuse("paused must be true or false")
		}
		f.Paused = &b
	}
	if f.Name != nil && len(*f.Name) > maxScheduleName {
		return f, refuse("name is longer than %d characters", maxScheduleName)
	}
	if f.Prompt != nil && len(*f.Prompt) > maxToolText {
		return f, refuse("prompt is longer than %d bytes; shorten it or put the detail in a file the run can read", maxToolText)
	}
	if f.PermissionMode != nil && !permrules.Action(*f.PermissionMode).Valid() {
		return f, refuse("permissionMode must be deny, ask or allow")
	}
	if f.AgentMode != nil && *f.AgentMode != "plan" && *f.AgentMode != "build" {
		return f, refuse("agentMode must be \"plan\" (read-only runs) or \"build\"")
	}
	if f.Session != nil && *f.Session != "new" && *f.Session != "this" {
		return f, refuse("session must be \"new\" or \"this\"")
	}
	return f, nil
}

// describeRecurrence is the card's timetable line for a recurrence the
// model wrote (Cerea's own recurrenceText is what list returns).
func describeRecurrence(raw json.RawMessage) string {
	var r struct {
		Type  string `json:"type"`
		Every int    `json:"every"`
		At    string `json:"at"`
		Day   *int   `json:"day"`
		Expr  string `json:"expr"`
	}
	if json.Unmarshal(raw, &r) != nil {
		return string(raw)
	}
	days := []string{"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"}
	switch r.Type {
	case "hours":
		if r.Every == 1 {
			return "every hour"
		}
		return fmt.Sprintf("every %d hours", r.Every)
	case "daily":
		return "every day at " + r.At
	case "weekdays":
		return "weekdays at " + r.At
	case "weekly":
		if r.Day != nil && *r.Day >= 0 && *r.Day < 7 {
			return fmt.Sprintf("every %s at %s", days[*r.Day], r.At)
		}
	case "cron":
		return "cron " + r.Expr
	}
	return string(raw)
}

// cardFields is the card's view of the fields: everything a person must see
// to approve, the full prompt included.
func (at *agentTools) cardFields(tc *toolCaller, f scheduleFields) map[string]any {
	out := map[string]any{}
	if f.Name != nil {
		out["name"] = *f.Name
	}
	if f.Recurrence != nil {
		out["recurrence"] = *f.Recurrence
		out["recurrenceText"] = describeRecurrence(*f.Recurrence)
	}
	if f.Timezone != nil {
		out["timezone"] = *f.Timezone
	}
	if f.WorkspaceID != nil {
		ws := map[string]any{"id": *f.WorkspaceID}
		if w, ok := at.mc.workspaces.Get(*f.WorkspaceID); ok {
			ws["name"] = w.Name
		}
		out["workspace"] = ws
	}
	if f.Session != nil {
		if *f.Session == "this" {
			out["session"] = map[string]any{"sessionId": at.mc.mat.RootOf(tc.session.ID), "title": tc.session.Title}
		} else {
			out["session"] = "new"
		}
	}
	if f.PermissionMode != nil {
		out["permissionMode"] = *f.PermissionMode
	}
	if f.AgentMode != nil {
		out["agentMode"] = *f.AgentMode
	}
	if f.Coordination != nil {
		out["coordination"] = *f.Coordination
	}
	if f.Prompt != nil {
		out["prompt"] = *f.Prompt
	}
	if f.Paused != nil {
		out["paused"] = *f.Paused
	}
	return out
}

// scheduleGate runs the decision for a mutating call and, when it says ask,
// raises the card. It returns whether the call went through without a card.
func (at *agentTools) scheduleGate(ctx context.Context, tc *toolCaller, call backend.ToolCall, f scheduleFacts, ref string, req backend.PermissionRequest) (bool, error) {
	outcome, reason := decideSchedule(f)
	if outcome == scheduleRefuse {
		return false, refuse("%s", reason)
	}
	// The rate window, per root, counted before any card (like spawns).
	root := at.mc.mat.RootOf(tc.session.ID)
	at.mu.Lock()
	now := at.now()
	at.scheduleLog[root] = recent(at.scheduleLog[root], now, scheduleWindow)
	if len(at.scheduleLog[root]) >= schedulesPerWindow {
		at.mu.Unlock()
		return false, refuse("schedule rate limit: at most %d schedule changes per %d minutes", schedulesPerWindow, int(scheduleWindow.Minutes()))
	}
	at.scheduleLog[root] = append(at.scheduleLog[root], now)
	at.mu.Unlock()

	if outcome == scheduleAuto {
		at.mc.audit.agentToolSchedule(call.Tool, tc.session.ID, ref, "allow", reason)
		return true, nil
	}
	if req.Metadata == nil {
		req.Metadata = map[string]any{}
	}
	req.Tool = call.Tool
	req.Metadata["reason"] = reason
	decision, message, err := at.ask(ctx, tc, call, req)
	if err != nil {
		return false, err
	}
	if decision != backend.DecisionOnce {
		return false, declined(message)
	}
	return false, nil
}

// scheduleList implements schedule_list.
func (at *agentTools) scheduleList(ctx context.Context, tc *toolCaller, call backend.ToolCall) (string, error) {
	if _, err := decodeObject(call.Args, "the arguments", "note"); err != nil {
		return "", err
	}
	if outcome, reason := decideSchedule(scheduleFacts{tool: call.Tool, ceiling: at.scheduleCeiling()}); outcome == scheduleRefuse {
		return "", refuse("%s", reason)
	}
	raw, err := at.cereaCall(ctx, tc, "list", map[string]any{})
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// scheduleCreate implements schedule_create; the second result is the
// schedule's name for the audit row.
func (at *agentTools) scheduleCreate(ctx context.Context, tc *toolCaller, call backend.ToolCall) (string, string, error) {
	m, err := decodeObject(call.Args, "the arguments",
		"name", "prompt", "recurrence", "timezone", "workspaceId", "session", "permissionMode", "agentMode", "coordination")
	if err != nil {
		return "", "", err
	}
	f, err := readFields(m)
	if err != nil {
		return "", "", err
	}
	if f.Name == nil {
		return "", "", refuse("name is required: say what the schedule does, it outlives this session")
	}
	ref := *f.Name
	if f.Prompt == nil {
		return "", ref, refuse("prompt is required: everything each run needs, it cannot see this conversation")
	}
	if f.Recurrence == nil {
		return "", ref, refuse("recurrence is required, e.g. {\"type\":\"daily\",\"at\":\"09:00\"}")
	}
	if f.PermissionMode == nil {
		return "", ref, refuse("permissionMode is required: deny, ask or allow (no looser than your own)")
	}
	if f.Session == nil {
		s := "new"
		f.Session = &s
	}
	if f.WorkspaceID == nil {
		f.WorkspaceID = &tc.workspaceID
	}
	facts := at.scheduleFactsFor(ctx, tc, call.Tool)
	if err := earlyRefusal(facts); err != nil {
		return "", ref, err
	}
	runOf, err := at.scheduleContext(ctx, tc)
	if err != nil {
		return "", ref, err
	}
	facts.scheduledRun = runOf != ""
	meta := map[string]any{"schedule": at.cardFields(tc, f)}
	if facts.scheduledRun {
		meta["scheduledRun"] = true
	}
	auto, err := at.scheduleGate(ctx, tc, call, facts, ref, backend.PermissionRequest{
		Title: "Create a schedule: " + *f.Name, Metadata: meta,
	})
	if err != nil {
		return "", ref, err
	}
	args := map[string]any{
		"name": *f.Name, "prompt": *f.Prompt, "recurrence": *f.Recurrence, "workspaceId": *f.WorkspaceID,
		"session": *f.Session, "permissionMode": *f.PermissionMode,
	}
	if f.Timezone != nil {
		args["timezone"] = *f.Timezone
	}
	if f.AgentMode != nil {
		args["agentMode"] = *f.AgentMode
	}
	if f.Coordination != nil && len(*f.Coordination) > 0 {
		args["coordination"] = *f.Coordination
	}
	raw, err := at.cereaCall(ctx, tc, "create", args)
	if err != nil {
		return "", ref, err
	}
	return withAutoApproved(raw, auto), ref, nil
}

// scheduleUpdate implements schedule_update.
func (at *agentTools) scheduleUpdate(ctx context.Context, tc *toolCaller, call backend.ToolCall) (string, string, error) {
	m, err := decodeObject(call.Args, "the arguments", "id", "changes")
	if err != nil {
		return "", "", err
	}
	var id string
	if v, ok := m["id"]; !ok || json.Unmarshal(v, &id) != nil || strings.TrimSpace(id) == "" {
		return "", "", refuse("id is required (a schedule id from schedule_list)")
	}
	cm, err := decodeObject(m["changes"], "changes",
		"name", "prompt", "recurrence", "timezone", "workspaceId", "permissionMode", "agentMode", "coordination", "paused")
	if err != nil {
		return "", id, err
	}
	f, err := readFields(cm)
	if err != nil {
		return "", id, err
	}
	changes := map[string]any{}
	fields := at.cardFields(tc, f)
	for k, v := range fields {
		if k == "recurrenceText" {
			continue
		}
		if k == "workspace" {
			changes["workspaceId"] = *f.WorkspaceID
			continue
		}
		changes[k] = v
	}
	if len(changes) == 0 {
		return "", id, refuse("changes is empty: give at least one field to change (or paused)")
	}
	facts := at.scheduleFactsFor(ctx, tc, call.Tool)
	if err := earlyRefusal(facts); err != nil {
		return "", id, err
	}
	target, err := at.findSchedule(ctx, tc, id)
	if err != nil {
		return "", id, err
	}
	facts.selfStop = target.Self && len(changes) == 1 && f.Paused != nil && *f.Paused
	auto, err := at.scheduleGate(ctx, tc, call, facts, id, backend.PermissionRequest{
		Title: "Change the schedule: " + target.Name,
		Metadata: map[string]any{
			"schedule": map[string]any{"id": id, "name": target.Name, "recurrenceText": target.RecurrenceText, "self": target.Self},
			"changes":  fields,
		},
	})
	if err != nil {
		return "", id, err
	}
	changes["id"] = id
	raw, err := at.cereaCall(ctx, tc, "update", changes)
	if err != nil {
		return "", id, err
	}
	return withAutoApproved(raw, auto), id, nil
}

// scheduleDelete implements schedule_delete.
func (at *agentTools) scheduleDelete(ctx context.Context, tc *toolCaller, call backend.ToolCall) (string, string, error) {
	args, err := decodeArgs(call.Args, "id")
	if err != nil {
		return "", "", err
	}
	id := strings.TrimSpace(args["id"])
	if id == "" {
		return "", "", refuse("id is required (a schedule id from schedule_list)")
	}
	facts := at.scheduleFactsFor(ctx, tc, call.Tool)
	if err := earlyRefusal(facts); err != nil {
		return "", id, err
	}
	target, err := at.findSchedule(ctx, tc, id)
	if err != nil {
		return "", id, err
	}
	facts.selfStop = target.Self
	auto, err := at.scheduleGate(ctx, tc, call, facts, id, backend.PermissionRequest{
		Title:    "Delete the schedule: " + target.Name,
		Metadata: map[string]any{"schedule": map[string]any{"id": id, "name": target.Name, "recurrenceText": target.RecurrenceText, "self": target.Self}},
	})
	if err != nil {
		return "", id, err
	}
	raw, err := at.cereaCall(ctx, tc, "delete", map[string]any{"id": id})
	if err != nil {
		return "", id, err
	}
	return withAutoApproved(raw, auto), id, nil
}

// withAutoApproved adds autoApproved:true to a result that went through
// without a card, as the session tools do.
func withAutoApproved(raw json.RawMessage, auto bool) string {
	if !auto {
		return string(raw)
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil || m == nil {
		m = map[string]any{}
	}
	m["autoApproved"] = true
	body, _ := json.Marshal(m)
	return string(body)
}
