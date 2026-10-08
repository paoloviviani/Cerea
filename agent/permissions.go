package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"galopin/internal/backend"
	"galopin/internal/link"
	"galopin/internal/permrules"
	"galopin/internal/policy"
)

// The machine's half of the permission pass-through (PROTOCOL.md §6
// "Permissions"): what is decided here rather than in opencode or the
// materializer — the Deny / Ask / Allow selector and the exceptions a person
// makes with "always allow", what the panel may read of the rules, the one
// thing it may withdraw (an exception), and what a tightened policy sets in
// motion.

// ruleHost is the backend's permission surface, when it has one.
func (mc *machine) ruleHost() (backend.RuleHost, bool) {
	rh, ok := mc.back.(backend.RuleHost)
	return rh, ok
}

// installPermissions wires what runs on its own: the root's selector and the
// ceiling onto each subagent opencode creates.
func (mc *machine) installPermissions() {
	rh, ok := mc.ruleHost()
	if !ok {
		return
	}
	// Whatever the process held in memory dies with it, however it ended (a
	// crash restart as much as a tightened policy): the asks it was waiting on
	// are gone, and a card for one would answer into nothing. A session's
	// exceptions are not among what dies: they are galopin's own, kept in its
	// overlay and composed into the rules again.
	rh.OnProcessStart(func() {
		mc.mat.WithdrawPending()
	})
	mc.mat.OnChild(func(dir, childID string) { go mc.giveChildTheCeiling(dir, childID) })
	mc.mat.OnChildAsk(func(dir string, req backend.PermissionRequest) { go mc.answerChildAsk(dir, req) })
}

// answerChildAsk answers a subagent's ask that its root's selector allows. A
// child's first tool call is judged by the agent-level floor, which asks for the
// blanket's names whatever the root's mode is (opencode takes a session's rules
// when its turn starts, and a task starts the child's turn in the same breath
// it creates it); the rules galopin then applies land too late for that call. So
// the ask is read against the rules the child is entitled to — the root's mode
// and exceptions under the ceiling, as ChildRules composes them — and answered
// "once" when those allow it. An ask they do not allow (a root on Ask, or a key
// the ceiling caps) is left for a person.
func (mc *machine) answerChildAsk(dir string, req backend.PermissionRequest) {
	rh, ok := mc.ruleHost()
	if !ok || strings.HasPrefix(req.ID, "gp_") {
		return
	}
	agent := ""
	for deadline := time.Now().Add(childAgentWait); time.Now().Before(deadline); time.Sleep(25 * time.Millisecond) {
		if agent = mc.mat.ChildAgent(req.SessionID); agent != "" {
			break
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if rh.ChildAskAction(ctx, dir, req.SessionID, agent, req.Tool, req.Patterns) != permrules.Allow {
		return
	}
	if mc.askedRequest(req.SessionID, req.ID) == nil {
		return
	}
	if err := mc.back.ReplyPermission(ctx, dir, req.SessionID, req.ID, backend.DecisionOnce, ""); err != nil {
		if !backend.IsNotFound(err) {
			logf("permissions: could not answer subagent ask %s that its root allows: %v", req.ID, err)
		}
		return
	}
	mc.audit.permission(req.SessionID, req.ID, req.Tool, string(backend.DecisionOnce), "galopin", false)
}

// giveChildTheCeiling applies the root's selector and the ceiling to a subagent
// session as soon as the machine hears of it, then again when the parent's task
// call says which agent the child is (the call's input is attached to the call
// a moment after the session exists, and on 1.18.32 that moment can be most of a
// second). The first application uses the agent opencode names in the child's own
// title when the backend can read it, and applies denies only when it cannot; the
// second is the authoritative one and changes nothing when the first was right.
// Best effort by nature — a first tool call can still beat both — which is what
// the agent-level floor is for.
func (mc *machine) giveChildTheCeiling(dir, childID string) {
	rh, ok := mc.ruleHost()
	if !ok {
		return
	}
	apply := func(agent string) {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := rh.ApplyChildRules(ctx, dir, childID, agent); err != nil {
			logf("permissions: could not give subagent session %s the ceiling (the agent-level floor still stands): %v", childID, err)
		}
	}
	apply("")
	agent := ""
	for deadline := time.Now().Add(childAgentWait); time.Now().Before(deadline); time.Sleep(25 * time.Millisecond) {
		if agent = mc.mat.ChildAgent(childID); agent != "" {
			break
		}
	}
	if agent != "" {
		apply(agent)
	}
}

// childAgentWait is how long a new subagent waits to learn its type.
const childAgentWait = 2 * time.Second

// capDecision lowers an "always" the ceiling does not let stand. An "always
// allow" becomes an exception that is composed under the ceiling's tail like
// every other rule, so on a key capped below allow it could never take effect:
// it is answered "once" and nothing is stored, rather than shown to a person
// as a standing permission that does nothing. tool is the ask's permission key;
// "" (the ask is not known to the machine) is capped whenever any key is,
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

// askedRequest is a pending ask the machine holds, nil when it holds none by
// that id.
func (mc *machine) askedRequest(sessionID, requestID string) *backend.PermissionRequest {
	for _, req := range mc.mat.PendingPermissionRequests(sessionID) {
		if req.ID == requestID {
			r := req
			return &r
		}
	}
	return nil
}

type ruleView struct {
	Permission string `json:"permission"`
	Pattern    string `json:"pattern"`
	Action     string `json:"action"`
	// Source says whose the rule is: "default" (opencode's built-ins and each
	// built-in agent's rules), "file" (the opencode.json enroll wrote), "floor"
	// (galopin's own agent-level ask defaults), "machine" (this machine's own
	// rules, which beat the file), "cerea" (what a person set on this session)
	// or "ceiling" (the cap, last).
	Source string `json:"source"`
}

// opPermissionRules answers permission.rules: the rules in force for a session,
// each tagged with its source, the selector's mode, and the exceptions (as
// savedApprovals). A read of live state; nothing here writes anything. Re-read it
// after session.setPermissionMode or an "always allow": it is how a person finds
// out what a change came to.
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
	rules := make([]ruleView, 0, len(layers.Rules))
	for _, r := range layers.Rules {
		rules = append(rules, ruleView{r.Permission, r.Pattern, string(r.Action), r.Source})
	}
	ceiling := mc.live.Layers().Ceiling
	max := map[string]string{}
	for _, k := range ceiling.Keys() {
		max[k] = string(ceiling.Of(k))
	}
	return map[string]any{
		"agent": layers.Agent, "mode": layers.Mode, "rules": rules,
		"savedApprovals": mc.exceptionViews(rh, a.SessionID), "ceiling": max,
		"coordination": orEmptyStrings(rh.Coordination(mc.mat.RootOf(a.SessionID))),
	}, nil
}

// exceptionViews is the root's exceptions as permission.rules lists them. They
// belong to the ROOT session, so a subagent's view shows its root's, under the
// root's id.
func (mc *machine) exceptionViews(rh backend.RuleHost, sessionID string) []backend.SavedApproval {
	root := mc.mat.RootOf(sessionID)
	out := []backend.SavedApproval{}
	for _, e := range rh.Exceptions(root) {
		out = append(out, backend.SavedApproval{
			ID: e.ID, SessionID: root, Permission: e.Permission, Patterns: e.Patterns,
			Removable: true, GrantedAt: e.GrantedAt,
		})
	}
	return out
}

// opSessionSetPermissionMode answers session.setPermissionMode {sessionId,
// mode}: the Deny / Ask / Allow selector, which covers the whole session until
// it is changed. An unknown session is `not_found`, a mode that is not one of
// the three words `invalid`, and a subagent `invalid` too: it has no selector
// of its own and follows its root. The change reaches the root and every
// subagent under it, including ones already running. It applies from the
// session's NEXT turn: opencode takes a session's rules when a turn starts, and
// nothing here stops, cancels or withdraws a turn that is running. The answer is `{}`; read
// the mode back from the session. Audited as permission.mode.
func (mc *machine) opSessionSetPermissionMode(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string `json:"sessionId"`
		Mode      string `json:"mode"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	dir, _, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	mode := permrules.Action(a.Mode)
	if !mode.Valid() {
		return nil, opErrf("invalid", "mode must be deny, ask or allow, got %q", a.Mode)
	}
	if mc.mat.RootOf(a.SessionID) != a.SessionID {
		return nil, opErrf("invalid", "a subagent follows its root: set the mode on session %s", mc.mat.RootOf(a.SessionID))
	}
	rh, ok := mc.ruleHost()
	if !ok {
		return nil, opErrf("unsupported", "this backend has no permission selector")
	}
	if err := rh.SetPermissionMode(ctx, dir, a.SessionID, mode); err != nil {
		return nil, backendErr(err)
	}
	mc.audit.permissionMode(a.SessionID, string(mode))
	return map[string]any{}, nil
}

// opSessionGrantCoordination answers session.grantCoordination {sessionId,
// keys}: the narrow grant that lets a session's coordination tools run without
// a card. Only the four coordination keys are accepted (anything else is
// `invalid`, and nothing is recorded); an empty list clears the grant. It is
// kept on the ROOT session's selector, so it persists with it and follows to
// its subagents, and it is composed as an `allow` beneath the machine's own
// rules and the ceiling: it never lifts a ceiling cap, the cross-workspace
// rule, the hop limit or the rate limits. A subagent is `invalid` (it follows
// its root), an unknown session `not_found`, a machine without agent tools or
// a backend without galopin's rules `unsupported`. The answer is
// `{keys}` — the grant now in force. Audited with the keys and the outcome.
func (mc *machine) opSessionGrantCoordination(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string    `json:"sessionId"`
		Keys      *[]string `json:"keys"`
	}
	if err := json.Unmarshal(args, &a); err != nil || a.SessionID == "" || a.Keys == nil {
		return nil, opErrf("invalid", "session.grantCoordination needs a sessionId and keys (an empty list clears the grant)")
	}
	keys, bad, ok := permrules.NormalizeCoordination(*a.Keys)
	if !ok {
		mc.audit.coordinationGrant(a.SessionID, *a.Keys, "invalid")
		return nil, opErrf("invalid", "%q cannot be granted: only %s are accepted", bad, strings.Join(permrules.CoordinationKeys, ", "))
	}
	dir, _, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		mc.audit.coordinationGrant(a.SessionID, keys, "not_found")
		return nil, operr
	}
	rh, ok := mc.ruleHost()
	if !ok || mc.agentTools == nil {
		mc.audit.coordinationGrant(a.SessionID, keys, "unsupported")
		return nil, opErrf("unsupported", "this machine has no agent tools to grant (they are off, or the backend has none)")
	}
	if mc.mat.RootOf(a.SessionID) != a.SessionID {
		mc.audit.coordinationGrant(a.SessionID, keys, "invalid")
		return nil, opErrf("invalid", "a subagent follows its root: grant on session %s", mc.mat.RootOf(a.SessionID))
	}
	if err := rh.SetCoordination(ctx, dir, a.SessionID, keys); err != nil {
		mc.audit.coordinationGrant(a.SessionID, keys, "failed")
		return nil, backendErr(err)
	}
	mc.audit.coordinationGrant(a.SessionID, keys, "ok")
	return map[string]any{"keys": orEmptyStrings(keys)}, nil
}

// opPermissionSavedRemove answers permission.saved.remove {sessionId, id}:
// withdraw one exception from the session's root, after which the rules are
// applied again to the root and every subagent under it and the command asks
// again. An id the root does not hold is `not_found`. Audited without patterns.
func (mc *machine) opPermissionSavedRemove(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string `json:"sessionId"`
		ID        string `json:"id"`
	}
	if err := json.Unmarshal(args, &a); err != nil || a.ID == "" || a.SessionID == "" {
		return nil, opErrf("invalid", "permission.saved.remove needs a sessionId and an id")
	}
	dir, _, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	rh, ok := mc.ruleHost()
	if !ok {
		return nil, opErrf("unsupported", "this backend has no exceptions")
	}
	found, err := rh.RemoveException(ctx, dir, mc.mat.RootOf(a.SessionID), a.ID)
	if !found {
		if err != nil {
			return nil, backendErr(err)
		}
		return nil, notFound("saved approval")
	}
	if err != nil {
		return nil, backendErr(err)
	}
	mc.audit.permissionSavedRemove(a.SessionID, a.ID)
	return map[string]any{}, nil
}

// newExceptionID mints an exception's id.
func newExceptionID() string {
	raw := make([]byte, 6)
	_, _ = rand.Read(raw)
	return "ex_" + hex.EncodeToString(raw)
}

// grantException records the "always allow" a person gave on an ask as an
// exception on its ROOT session: the permission and the patterns opencode said
// the approval would cover (its `always`, else the ask's own). The caller has
// checked the ceiling does not cap the key.
func (mc *machine) grantException(ctx context.Context, rh backend.RuleHost, dir, sessionID string, asked *backend.PermissionRequest) error {
	patterns := asked.Always
	if len(patterns) == 0 {
		patterns = asked.Patterns
	}
	if len(patterns) == 0 {
		patterns = []string{"*"}
	}
	_, err := rh.AddException(ctx, dir, mc.mat.RootOf(sessionID), permrules.Exception{
		ID: newExceptionID(), Permission: asked.Tool, Patterns: append([]string(nil), patterns...),
		GrantedAt: time.Now().UTC().Format(time.RFC3339),
	})
	return err
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
