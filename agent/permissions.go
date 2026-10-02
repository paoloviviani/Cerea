package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"galopin/internal/backend"
	"galopin/internal/link"
	"galopin/internal/permrules"
	"galopin/internal/policy"
)

// The machine's half of the permission pass-through (PROTOCOL.md §6
// "Permissions"): what is decided here rather than in opencode or the
// materializer — whether a reply may be "always", what the panel may read of
// the rules, the one thing it may withdraw, and what a tightened policy sets in
// motion.

// ruleHost is the backend's permission surface, when it has one.
func (mc *machine) ruleHost() (backend.RuleHost, bool) {
	rh, ok := mc.back.(backend.RuleHost)
	return rh, ok
}

// installPermissions wires what runs on its own: the ceiling onto each subagent
// opencode creates, and the audit of what the responder answers.
func (mc *machine) installPermissions() {
	mc.mat.OnResponder(func(sessionID string, req backend.PermissionRequest, err error) {
		decision := string(backend.DecisionOnce)
		if err != nil {
			decision = "failed"
		}
		mc.audit.permission(sessionID, req.ID, req.Tool, decision, "responder", false)
	})
	if _, ok := mc.ruleHost(); !ok {
		return
	}
	mc.mat.OnChild(func(dir, childID string) { go mc.giveChildTheCeiling(dir, childID) })
}

// giveChildTheCeiling applies the ceiling to a subagent session as soon as the
// machine hears of it. It waits briefly for the parent's task call to say which
// agent the child is (the call's input arrives a moment after the session
// does); without that it applies denies only. Best effort by nature — a first
// tool call can beat it — which is what the agent-level floor is for.
func (mc *machine) giveChildTheCeiling(dir, childID string) {
	rh, ok := mc.ruleHost()
	if !ok {
		return
	}
	agent := ""
	for deadline := time.Now().Add(childAgentWait); time.Now().Before(deadline); time.Sleep(25 * time.Millisecond) {
		if agent = mc.mat.ChildAgent(childID); agent != "" {
			break
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := rh.ApplyChildRules(ctx, dir, childID, agent); err != nil {
		logf("permissions: could not give subagent session %s the ceiling (the agent-level floor still stands): %v", childID, err)
	}
}

// childAgentWait is how long a new subagent waits to learn its type.
const childAgentWait = 2 * time.Second

// capDecision lowers an "always" the ceiling does not let stand. An "always"
// is a rule opencode keeps in memory for every session in the workspace and
// checks after all the others, so one click on a key capped below allow would
// otherwise exceed the ceiling for all of them. tool is the ask's permission
// key; "" (the ask is not known to the machine) is capped whenever any key is,
// because what the "always" would cover cannot be told.
func (mc *machine) capDecision(tool string, d backend.Decision) (backend.Decision, bool) {
	if d != backend.DecisionAlways {
		return d, false
	}
	c := mc.live.Layers().Ceiling
	if tool == "" {
		if len(c.Keys()) == 0 {
			return d, false
		}
		return backend.DecisionOnce, true
	}
	if c.Limits(tool) {
		return backend.DecisionOnce, true
	}
	return d, false
}

// askedTool is the permission key of a pending ask the machine holds.
func (mc *machine) askedTool(sessionID, requestID string) string {
	for _, req := range mc.mat.PendingPermissionRequests(sessionID) {
		if req.ID == requestID {
			return req.Tool
		}
	}
	return ""
}

type ruleView struct {
	Permission string `json:"permission"`
	Pattern    string `json:"pattern"`
	Action     string `json:"action"`
	// Source says whose the rule is: "opencode" (its defaults, the opencode.json
	// that enroll wrote, the agent's own config), "machine" (this machine's own
	// rules, which beat the file) or "ceiling" (the cap that comes last).
	Source string `json:"source"`
}

// opPermissionRules answers permission.rules: the rules in force for a
// session, taken apart by source, and the approvals opencode has saved. A read
// of live state; nothing here writes anything.
func (mc *machine) opPermissionRules(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(args, &a); err != nil || a.SessionID == "" {
		return nil, opErrf("invalid", "permission.rules needs a sessionId")
	}
	dir, _, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	rh, ok := mc.ruleHost()
	if !ok {
		return nil, opErrf("unsupported", "this backend has no permission rules to show")
	}
	layers, err := rh.RuleLayers(ctx, dir, a.SessionID)
	if err != nil {
		return nil, backendErr(err)
	}
	saved, err := rh.SavedApprovals(ctx)
	if err != nil {
		return nil, backendErr(err)
	}
	rules := []ruleView{}
	add := func(src string, rs []permrules.Rule) {
		for _, r := range rs {
			rules = append(rules, ruleView{r.Permission, r.Pattern, string(r.Action), src})
		}
	}
	add("opencode", layers.OpencodeSide)
	add("machine", layers.Own)
	add("ceiling", layers.Ceiling)
	max := map[string]string{}
	for _, k := range mc.live.Layers().Ceiling.Keys() {
		max[k] = string(mc.live.Layers().Ceiling.Of(k))
	}
	if saved == nil {
		saved = []backend.SavedApproval{}
	}
	return map[string]any{"agent": layers.Agent, "rules": rules, "savedApprovals": saved, "ceiling": max}, nil
}

// opPermissionSavedRemove answers permission.saved.remove: withdraw one saved
// "always". The only write the link can make to permissions, and it can only
// tighten: a removed approval means the next matching call asks again.
func (mc *machine) opPermissionSavedRemove(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &a); err != nil || a.ID == "" {
		return nil, opErrf("invalid", "permission.saved.remove needs an id")
	}
	rh, ok := mc.ruleHost()
	if !ok {
		return nil, opErrf("unsupported", "this backend has no saved approvals")
	}
	if err := rh.RemoveSavedApproval(ctx, a.ID); err != nil {
		return nil, backendErr(err)
	}
	mc.audit.permissionSavedRemove(a.ID)
	return map[string]any{}, nil
}

// policyTightened applies a permission policy that just got stricter: opencode
// is restarted (its in-memory "always" approvals outrank every rule and are
// cleared only that way), the asks that died with it are withdrawn from every
// client, and every session is brought under the new rules before its next
// prompt would do it anyway.
func (mc *machine) policyTightened(ctx context.Context, ch policy.Change) {
	if !ch.Tightened {
		return
	}
	rh, ok := mc.ruleHost()
	if !ok {
		return
	}
	if err := rh.RestartForPolicy(ctx); err != nil {
		logf("permissions: restarting the agent for a tightened policy failed: %v", err)
		mc.audit.permissionTightened(false)
		return
	}
	mc.audit.permissionTightened(true)
	mc.mat.WithdrawPending()
	for _, id := range mc.mat.TrackedIDs() {
		dir, ok := mc.mat.WorkspaceDir(id)
		if !ok || dir == "" {
			continue
		}
		if err := rh.EnsureRules(ctx, dir, id); err != nil {
			logf("permissions: re-applying the rules to session %s: %v", id, err)
		}
	}
}

// policyPollEvery is how often a running agent looks at policy.json.
const policyPollEvery = 2 * time.Second

// watchPolicy follows policy.json for tightening, until ctx ends. It re-reads
// the file when its mtime or size moves, takes in only what is stricter
// (policy.Live), and calls apply with what changed. A file that does not parse
// is ignored with a log line — a half-written edit must not loosen or break
// anything — and one that loosens is ignored outright.
func watchPolicy(ctx context.Context, path string, live *policy.Live, every time.Duration, apply func(policy.Change)) {
	var lastMod time.Time
	var lastSize int64 = -1
	if info, err := os.Stat(path); err == nil {
		lastMod, lastSize = info.ModTime(), info.Size()
	}
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		info, err := os.Stat(path)
		if err != nil || (info.ModTime().Equal(lastMod) && info.Size() == lastSize) {
			continue
		}
		lastMod, lastSize = info.ModTime(), info.Size()
		pol, err := policy.Load(path)
		if err != nil {
			logf("permissions: ignoring %s: %v", filepath.Base(path), err)
			continue
		}
		if ch := live.Tighten(pol.Permission); ch.Any() {
			apply(ch)
		}
	}
}
