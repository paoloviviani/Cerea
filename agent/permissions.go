package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"galopin/internal/backend"
	"galopin/internal/decide"
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

// decidePolicy is the machine's half of every decision: the ceiling, its own
// rules and its safe directories, read live (they only ever tighten).
func (mc *machine) decidePolicy(rh backend.RuleHost) decide.Policy {
	layers := mc.live.Layers
	if mc.layersFn != nil {
		layers = mc.layersFn
	}
	l := layers()
	return decide.Policy{Ceiling: l.Ceiling, Own: l.Own, SafeDirs: l.SafeDirs, PlanDirs: rh.PlanDirs()}
}

// rootState is the ROOT session's selector, which every ask from the root and
// from its subagents is decided by.
func (mc *machine) rootState(rh backend.RuleHost, sessionID string) decide.State {
	root := mc.mat.RootOf(sessionID)
	return decide.State{Mode: rh.PermissionMode(root), Exceptions: rh.Exceptions(root), Coordination: rh.Coordination(root)}
}

// decideAsk is the one decision for an ask the backend raised (ADR 0097).
// galopin's own gp_ asks were already decided before they were raised, so
// they are a card unless the root is on Plan.
func (mc *machine) decideAsk(rh backend.RuleHost, dir string, req backend.PermissionRequest) decide.Result {
	st := mc.rootState(rh, req.SessionID)
	if strings.HasPrefix(req.ID, "gp_") {
		if st.Mode == permrules.Deny {
			return decide.Result{Verdict: decide.Reject, Step: "plan", Reason: decide.PlanReason}
		}
		return decide.Result{Verdict: decide.Card, Step: "gp"}
	}
	key, patterns := req.Tool, req.Patterns
	if n, ok := mc.back.(backend.AskNormalizer); ok {
		key, patterns = n.NormalizeAsk(req)
	}
	return decide.Decide(mc.decidePolicy(rh), st, decide.Request{Key: key, Patterns: patterns, Workspace: dir})
}

// installPermissions wires what runs on its own: every permission ask is
// decided by the one function before any card is shown. reject and once are
// answered here (from a goroutine: the filter runs inside event application
// and must not do I/O) and the ask is consumed — never materialised, so no
// client sees it; card lets it through to the person.
func (mc *machine) installPermissions() {
	rh, ok := mc.ruleHost()
	if !ok {
		return
	}
	// Whatever the process held in memory dies with it, however it ended: the
	// asks it was waiting on are gone, and a card for one would answer into
	// nothing. A session's exceptions are not among what dies: they are
	// galopin's own, kept in its overlay.
	rh.OnProcessStart(func() {
		mc.mat.WithdrawPending()
	})
	mc.mat.OnAskFilter(func(dir string, req backend.PermissionRequest) bool {
		rh, ok := mc.ruleHost()
		if !ok {
			return false
		}
		// A child whose parent edge is not known yet resolves to itself and
		// reads Ask: its ask shows a card instead of running, which fails
		// toward a person.
		res := mc.decideAsk(rh, dir, req)
		if res.Verdict == decide.Card {
			return false
		}
		go mc.answerAsk(dir, req, res)
		return true
	})
}

// answerAsk sends a decided ask's reply, audited as a galopin answer. The ask
// was never materialised, so there is no card to withdraw.
func (mc *machine) answerAsk(dir string, req backend.PermissionRequest, res decide.Result) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	d, msg := backend.DecisionOnce, ""
	if res.Verdict == decide.Reject {
		d, msg = backend.DecisionReject, res.Reason
	}
	if err := mc.back.ReplyPermission(ctx, dir, req.SessionID, req.ID, d, msg); err != nil {
		if !backend.IsNotFound(err) && !errors.Is(err, backend.ErrPermissionGone) {
			logf("permissions: could not answer ask %s (%s): %v", req.ID, d, err)
		}
		return
	}
	if mc.audit != nil {
		mc.audit.permission(req.SessionID, req.ID, req.Tool, string(d), "galopin", false, msg)
	}
}

// answerPending decides what opencode still holds when galopin starts: an ask
// raised while galopin was down stayed pending (the agent waits with no
// timeout), and a card for it is shown or it is answered like a live one.
func (mc *machine) answerPending(ctx context.Context) {
	rh, ok := mc.ruleHost()
	if !ok {
		return
	}
	pending, err := rh.PendingAsks(ctx)
	if err != nil {
		logf("permissions: could not list the asks opencode still holds: %v", err)
		return
	}
	for _, req := range pending {
		dir, ok := mc.mat.WorkspaceDir(req.SessionID)
		if !ok || dir == "" {
			continue
		}
		if res := mc.decideAsk(rh, dir, req); res.Verdict != decide.Card {
			mc.answerAsk(dir, req, res)
		}
	}
}

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
	layers, err := rh.AgentRules(ctx, dir, a.SessionID)
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
		// The machine's safe external directories, as a person reads them
		// (home-relative entries shortened). Optional on the wire: a galopin
		// older than the field omits it, and the panel shows no line.
		"safeDirs": orEmptyStrings(policy.DisplaySafeDirs(mc.live.Layers().SafeDirs)),
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
// subagent under it, including ones already running. A Deny takes effect at
// once: every ask from a Deny root is rejected before any card, even mid-turn,
// and asks already showing for the root and its subagents are rejected at once
// with the Deny message (their cards resolve like any answered ask). Any other change applies from the session's NEXT turn:
// opencode takes a session's rules when a turn starts, and nothing here stops,
// cancels or withdraws a turn that is running. The answer is `{}`; read
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
	if a.Mode == "plan" {
		// Plan is the selector's first word; "deny" is its wire spelling.
		a.Mode = "deny"
	}
	mode := permrules.Action(a.Mode)
	if !mode.Valid() {
		return nil, opErrf("invalid", "mode must be deny (Plan), ask or allow, got %q", a.Mode)
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
	if mode == permrules.Deny {
		// A Plan chosen while asks are showing must not leave cards that
		// answer into the old word: every ask the materializer still holds
		// for the root and its subagents that Plan refuses is rejected at once.
		mc.rejectTreePending(dir, a.SessionID)
	}
	return map[string]any{}, nil
}

// rejectTreePending decides again every permission ask the materializer still
// holds for root and its subagents and rejects the ones the new word refuses
// (asks that are still a card stay one: switching to Plan never approves
// anything). The reply releases the tool call waiting in the agent; the card
// is then withdrawn and the materializer drops its own copy.
func (mc *machine) rejectTreePending(dir, root string) {
	rh, ok := mc.ruleHost()
	if !ok {
		return
	}
	for _, id := range mc.mat.TrackedIDs() {
		if mc.mat.RootOf(id) != root {
			continue
		}
		for _, req := range mc.mat.PendingPermissionRequests(id) {
			if res := mc.decideAsk(rh, dir, req); res.Verdict == decide.Reject {
				mc.answerAsk(dir, req, res)
				mc.mat.WithdrawPermission(req.SessionID, req.ID)
			}
		}
	}
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

// policyTightened applies a permission policy that just got stricter. Nothing
// is written to the agent and nothing restarts: the next ask is decided under
// the new ceiling. What is already showing as a card is decided again, and a
// card the ceiling now refuses is rejected at once.
func (mc *machine) policyTightened(ctx context.Context, ch policy.Change) {
	if !ch.Tightened {
		return
	}
	rh, ok := mc.ruleHost()
	if !ok {
		return
	}
	mc.audit.permissionTightened(false)
	for _, id := range mc.mat.TrackedIDs() {
		dir, ok := mc.mat.WorkspaceDir(id)
		if !ok || dir == "" {
			continue
		}
		for _, req := range mc.mat.PendingPermissionRequests(id) {
			if res := mc.decideAsk(rh, dir, req); res.Verdict == decide.Reject {
				mc.answerAsk(dir, req, res)
				mc.mat.WithdrawPermission(req.SessionID, req.ID)
			}
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
