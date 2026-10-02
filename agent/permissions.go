package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
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
	rh, ok := mc.ruleHost()
	if !ok {
		return
	}
	// Whatever the process held in memory dies with it, however it ended (a
	// crash restart as much as a tightened policy): its saved "always"
	// approvals are gone, and so are the asks it was waiting on. Keeping either
	// would show a person a stale list and cards that answer into nothing.
	rh.OnProcessStart(func() {
		mc.saved.clear()
		mc.mat.WithdrawPending()
	})
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

// savedLedger is the "always" approvals this machine relayed. opencode keeps
// its own in memory with no ids and no way to list or withdraw them (1.18.32),
// so galopin records each one it passed on, mints an id for it, and groups it
// by the reply that created it: one entry per reply, however many patterns
// opencode stored for it. It is cleared when opencode restarts, which is also
// when opencode forgets them.
type savedLedger struct {
	mu      sync.Mutex
	entries []backend.SavedApproval
}

func (l *savedLedger) add(sessionID, workspaceDir, tool string, resources []string) {
	raw := make([]byte, 6)
	_, _ = rand.Read(raw)
	if len(resources) == 0 {
		resources = []string{"*"}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, backend.SavedApproval{
		ID: "sa_" + hex.EncodeToString(raw), SessionID: sessionID, Permission: tool,
		Patterns: resources, Removable: false, WorkspaceDir: workspaceDir,
		GrantedAt: time.Now().UTC().Format(time.RFC3339),
	})
}

// list is every entry; inDir only the ones granted in one workspace — the
// scope of an opencode "always", which every session of the workspace shares.
func (l *savedLedger) list() []backend.SavedApproval {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]backend.SavedApproval(nil), l.entries...)
}

func (l *savedLedger) inDir(dir string) []backend.SavedApproval {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []backend.SavedApproval
	for _, e := range l.entries {
		if e.WorkspaceDir == dir {
			out = append(out, e)
		}
	}
	return out
}

func (l *savedLedger) find(id string) (backend.SavedApproval, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, e := range l.entries {
		if e.ID == id {
			return e, true
		}
	}
	return backend.SavedApproval{}, false
}

func (l *savedLedger) clear() {
	l.mu.Lock()
	l.entries = nil
	l.mu.Unlock()
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

// opPermissionRules answers permission.rules: the rules in force for a
// session, each tagged with its source, and the approvals saved. A read of live
// state; nothing here writes anything. Re-read it after session.setRules: it is
// how a person finds out what a write came to.
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
	// Scoped to this session's workspace, like the approvals themselves. The
	// list is galopin's own record: opencode has none to read (SavedApproval).
	saved := mc.saved.inDir(dir)
	if saved == nil {
		saved = []backend.SavedApproval{}
	}
	return map[string]any{"agent": layers.Agent, "rules": rules, "savedApprovals": saved, "ceiling": max}, nil
}

// maxSetRules and maxPatternLen bound a session.setRules write.
const (
	maxSetRules   = 200
	maxPatternLen = 512
)

// opSessionSetRules answers session.setRules {sessionId, rules}: a person's
// rules for one session. EVERY rule is capped to the machine's ceiling first —
// one above its max is applied at the max, never as requested — and the capped
// set becomes the session's "cerea" rules, composed after the machine's own and
// before the ceiling (permrules.ComposeFor), replacing the person's earlier
// set. Only a malformed rule or an unknown session is refused; the answer is
// `{}`, and what was actually applied is read back with permission.rules, so a
// clamp is never hidden behind a success. Audited without patterns.
func (mc *machine) opSessionSetRules(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string           `json:"sessionId"`
		Rules     []permrules.Rule `json:"rules"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	dir, _, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	rh, ok := mc.ruleHost()
	if !ok {
		return nil, opErrf("unsupported", "this backend has no permission rules to set")
	}
	if len(a.Rules) > maxSetRules {
		return nil, opErrf("invalid", "at most %d rules per write", maxSetRules)
	}
	for i, r := range a.Rules {
		switch {
		case r.Permission == "":
			return nil, opErrf("invalid", "rule %d has no permission", i)
		case !r.Action.Valid():
			return nil, opErrf("invalid", "rule %d: %q is not allow, ask or deny", i, r.Action)
		case len(r.Pattern) > maxPatternLen:
			return nil, opErrf("invalid", "rule %d: pattern longer than %d bytes", i, maxPatternLen)
		}
	}
	capped, clamped := mc.live.Layers().Ceiling.Clamp(a.Rules)
	if err := rh.SetSessionRules(ctx, dir, a.SessionID, capped); err != nil {
		return nil, backendErr(err)
	}
	mc.audit.permissionSetRules(a.SessionID, len(a.Rules), len(capped), clamped, ruleTools(capped))
	return map[string]any{}, nil
}

// ruleTools is the distinct permission keys of a set of rules, sorted — what
// the audit may say about a write; the patterns are not it.
func ruleTools(rs []permrules.Rule) []string {
	seen := map[string]bool{}
	var out []string
	for _, r := range rs {
		if !seen[r.Permission] {
			seen[r.Permission] = true
			out = append(out, r.Permission)
		}
	}
	sort.Strings(out)
	return out
}

// opPermissionSavedRemove answers permission.saved.remove {sessionId, id}:
// withdraw one saved "always". It can only tighten, and on opencode 1.18.32 it
// cannot do even that: the approvals opencode keeps in memory have no id and no
// call removes one, so an id galopin minted for one answers `unsupported`.
// What clears them is a restart of opencode, which a tightened ceiling causes.
// An id the machine does not hold (or one granted in another workspace than the
// session's) is `not_found`.
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
	if _, ok := mc.ruleHost(); !ok {
		return nil, opErrf("unsupported", "this backend has no saved approvals")
	}
	e, ok := mc.saved.find(a.ID)
	if !ok || e.WorkspaceDir != dir {
		return nil, notFound("saved approval")
	}
	return nil, opErrf("unsupported", "opencode cannot withdraw one saved approval: it keeps them in memory with no way to remove one; they are all cleared when it restarts (a tightened ceiling does that)")
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
