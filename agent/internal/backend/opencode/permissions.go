package opencode

// The permission pass-through's opencode half (PROTOCOL.md §6 "Permissions").
// opencode owns every tool permission; this file is where galopin puts the two
// things opencode cannot know — the machine's own rules and its ceiling — into
// the rules a session carries, and takes the one liberty the pass-through
// needs, restarting the process, when the ceiling tightens.
//
// What opencode does with them, read from the 1.18.32 binary: a session's
// rules sit above config and agent rules and below in-memory "always"
// approvals; the LAST matching rule wins; a subagent inherits only its
// parent's denies; PATCH /session/:id {permission} APPENDS to the session's
// rules; and the deprecated `tools` map replaces them wholesale.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"galopin/internal/backend"
	"galopin/internal/permrules"
)

// defaultAgent is the agent a session with no explicit mode runs: opencode's
// own default primary.
const defaultAgent = "build"

// defaultSubagent is the agent a subagent is taken to run when galopin has not
// learned which: opencode's general-purpose one. Used for display and for the
// two coordination tools' lookup only; nothing is applied on the strength of it.
const defaultSubagent = "general"

// agentRulesTTL bounds how long GET /agent's answer is reused. Agents change
// only with config (a project's, when the machine loads it), so a minute is
// long enough to spare a request per prompt and short enough that an edited
// agent is picked up without a restart.
const agentRulesTTL = time.Minute

type agentRulesEntry struct {
	at    time.Time
	rules map[string][]permrules.Rule
}

// permState is the Backend's permission bookkeeping.
type permState struct {
	// mu serializes applying rules, so two prompts racing on one session do
	// not both PATCH.
	mu sync.Mutex

	agentMu    sync.Mutex
	agentCache map[string]agentRulesEntry // by workspace directory

	// childAgent remembers which agent a subagent session runs, once the
	// materializer has read it from the parent's task call.
	childMu    sync.Mutex
	childAgent map[string]string
}

// layers is the machine's current inputs (empty when none are configured).
func (b *Backend) layers() permrules.Layers {
	if b.cfg.Permissions == nil {
		return permrules.Layers{}
	}
	return b.cfg.Permissions()
}

// hasAskCeiling reports whether the ceiling needs the agent's rules to be
// applied without loosening anything.
func hasAskCeiling(c permrules.Ceiling) bool {
	for _, k := range c.Keys() {
		if c.Of(k) == permrules.Ask {
			return true
		}
	}
	return false
}

// agentRuleset reads one agent's effective rules from GET /agent, cached per
// directory (opencode answers /agent per workspace: a project's own agents
// exist only there).
func (b *Backend) agentRuleset(ctx context.Context, dir, agent string) ([]permrules.Rule, error) {
	b.perm.agentMu.Lock()
	if e, ok := b.perm.agentCache[dir]; ok && time.Since(e.at) < agentRulesTTL {
		rules, found := e.rules[agent]
		b.perm.agentMu.Unlock()
		if !found {
			return nil, fmt.Errorf("opencode has no agent %q in %s", agent, dir)
		}
		return rules, nil
	}
	b.perm.agentMu.Unlock()

	var raw []struct {
		Name       string           `json:"name"`
		Permission []permrules.Rule `json:"permission"`
	}
	if err := b.doJSON(ctx, http.MethodGet, "/agent"+directoryQuery(dir), nil, &raw); err != nil {
		return nil, err
	}
	all := make(map[string][]permrules.Rule, len(raw))
	for _, a := range raw {
		all[a.Name] = a.Permission
	}
	b.perm.agentMu.Lock()
	if b.perm.agentCache == nil {
		b.perm.agentCache = map[string]agentRulesEntry{}
	}
	b.perm.agentCache[dir] = agentRulesEntry{at: time.Now(), rules: all}
	b.perm.agentMu.Unlock()
	rules, found := all[agent]
	if !found {
		return nil, fmt.Errorf("opencode has no agent %q in %s", agent, dir)
	}
	return rules, nil
}

// forgetAgentRules drops the cache: a restarted opencode has re-read its config.
func (b *Backend) forgetAgentRules() {
	b.perm.agentMu.Lock()
	b.perm.agentCache = nil
	b.perm.agentMu.Unlock()
}

// agentFor is the agent a session's next prompt runs: its mode, the agent a
// subagent was started as, else the default.
func (b *Backend) agentFor(sessionID string) string {
	if m := b.getOverlay(sessionID).ModeID; m != "" {
		return m
	}
	b.perm.childMu.Lock()
	defer b.perm.childMu.Unlock()
	if a, child := b.perm.childAgent[sessionID]; child {
		if a != "" {
			return a
		}
		return defaultSubagent
	}
	return defaultAgent
}

// noteSession learns that a session is a subagent from its record.
func (b *Backend) noteSession(s backend.Session) {
	if s.ParentID == "" {
		return
	}
	b.perm.childMu.Lock()
	defer b.perm.childMu.Unlock()
	if b.perm.childAgent == nil {
		b.perm.childAgent = map[string]string{}
	}
	if _, known := b.perm.childAgent[s.ID]; !known {
		b.perm.childAgent[s.ID] = ""
	}
}

// composeFor is the rules a session running agent gets now. When the ceiling
// needs the agent's rules and they cannot be read, it fails: a ceiling applied
// blind could soften a deny, and an unapplied one is no ceiling.
func (b *Backend) composeFor(ctx context.Context, dir, agent string) ([]permrules.Rule, error) {
	l := b.layers()
	if len(l.Own) == 0 && len(l.Ceiling.Keys()) == 0 {
		return nil, nil
	}
	agentRules, err := b.agentRuleset(ctx, dir, agent)
	if err != nil && hasAskCeiling(l.Ceiling) {
		return nil, fmt.Errorf("galopin could not read opencode's rules for agent %q, so it cannot apply this machine's ceiling: %w", agent, err)
	}
	return permrules.Compose(l, agentRules), nil
}

// patchRules appends rules to a session's own (opencode merges them in order).
func (b *Backend) patchRules(ctx context.Context, sessionID string, rules []permrules.Rule) error {
	return b.doJSON(ctx, http.MethodPatch, "/session/"+url.PathEscape(sessionID), map[string]any{"permission": rules}, nil)
}

// ensureRules makes the session carry the rules it should for the agent about
// to run, sending them only when they differ from what it was last given (the
// overlay remembers a fingerprint across restarts). It runs before every
// prompt, so a session created before the ceiling tightened, or one whose mode
// just changed, is never prompted under stale rules.
func (b *Backend) ensureRules(ctx context.Context, dir, sessionID, agent string) error {
	if b.cfg.Permissions == nil {
		return nil
	}
	b.perm.mu.Lock()
	defer b.perm.mu.Unlock()
	rules, err := b.composeFor(ctx, dir, agent)
	if err != nil {
		return err
	}
	ov := b.getOverlay(sessionID)
	fp := permrules.Fingerprint(rules)
	if ov.RulesFP == fp {
		return nil
	}
	if len(rules) > 0 {
		if err := b.patchRules(ctx, sessionID, rules); err != nil {
			return fmt.Errorf("applying this machine's permission rules to the session: %w", err)
		}
	}
	ov.RulesFP = fp
	return b.setOverlay(sessionID, ov)
}

// EnsureRules is ensureRules for the session's current agent, for the machine
// layer to re-apply after the ceiling changed.
func (b *Backend) EnsureRules(ctx context.Context, workspaceDir, sessionID string) error {
	return b.ensureRules(ctx, workspaceDir, sessionID, b.agentFor(sessionID))
}

// ApplyChildRules puts the ceiling on a subagent session opencode created. The
// child already has its parent's denies; what it lacks is the ceiling's caps,
// and none of the machine's own rules reach it (an allow must not). agent is
// the subagent type read from the parent's task call, "" when it is not known
// yet: then only denies are applied, since an ask cap restated blind could
// soften a read-only agent. Best effort by nature — a first tool call can win
// the race — which is what the agent-level floor is for.
func (b *Backend) ApplyChildRules(ctx context.Context, workspaceDir, sessionID, agent string) error {
	if b.cfg.Permissions == nil {
		return nil
	}
	b.perm.mu.Lock()
	defer b.perm.mu.Unlock()
	l := b.layers()
	var rules []permrules.Rule
	b.perm.childMu.Lock()
	if b.perm.childAgent == nil {
		b.perm.childAgent = map[string]string{}
	}
	if agent != "" || b.perm.childAgent[sessionID] == "" {
		b.perm.childAgent[sessionID] = agent
	}
	b.perm.childMu.Unlock()
	if agent != "" {
		agentRules, err := b.agentRuleset(ctx, workspaceDir, agent)
		if err != nil {
			rules = denyOnly(l.Ceiling)
		} else {
			rules = permrules.ChildRules(l, agentRules)
		}
	} else {
		rules = denyOnly(l.Ceiling)
	}
	ov := b.getOverlay(sessionID)
	fp := permrules.Fingerprint(rules)
	if ov.RulesFP == fp {
		return nil
	}
	if len(rules) > 0 {
		if err := b.patchRules(ctx, sessionID, rules); err != nil {
			return err
		}
	}
	ov.RulesFP = fp
	return b.setOverlay(sessionID, ov)
}

// denyOnly is the part of a ceiling that can be applied without knowing the
// agent: its denies.
func denyOnly(c permrules.Ceiling) []permrules.Rule {
	var out []permrules.Rule
	for _, k := range c.Keys() {
		if c.Of(k) == permrules.Deny {
			out = append(out, permrules.Rule{Permission: k, Pattern: "*", Action: permrules.Deny})
		}
	}
	return out
}

// EffectiveRules implements backend.RuleHost: the session's agent's rules,
// then the ones galopin applies on top, in the order opencode evaluates them.
func (b *Backend) EffectiveRules(ctx context.Context, workspaceDir, sessionID string) ([]permrules.Rule, error) {
	l, err := b.RuleLayers(ctx, workspaceDir, sessionID)
	if err != nil {
		return nil, err
	}
	out := append([]permrules.Rule(nil), l.OpencodeSide...)
	out = append(out, l.Own...)
	return append(out, l.Ceiling...), nil
}

// RuleLayers implements backend.RuleHost.
func (b *Backend) RuleLayers(ctx context.Context, workspaceDir, sessionID string) (backend.RuleLayers, error) {
	agent := b.agentFor(sessionID)
	agentRules, err := b.agentRuleset(ctx, workspaceDir, agent)
	if err != nil {
		return backend.RuleLayers{}, err
	}
	l := b.layers()
	out := backend.RuleLayers{Agent: agent, OpencodeSide: agentRules}
	if b.isChild(sessionID) {
		out.Ceiling = permrules.ChildRules(l, agentRules)
		return out, nil
	}
	out.Own = l.Own
	out.Ceiling = l.Ceiling.Tail(append(append([]permrules.Rule(nil), agentRules...), l.Own...))
	return out, nil
}

func (b *Backend) isChild(sessionID string) bool {
	b.perm.childMu.Lock()
	defer b.perm.childMu.Unlock()
	_, ok := b.perm.childAgent[sessionID]
	return ok
}

// savedList is GET /api/permission/saved's envelope.
type savedList struct {
	Data []struct {
		ID       string `json:"id"`
		Action   string `json:"action"`
		Resource string `json:"resource"`
	} `json:"data"`
}

// SavedApprovals implements backend.RuleHost: the "always" approvals opencode
// holds, which it checks after every rule.
func (b *Backend) SavedApprovals(ctx context.Context) ([]backend.SavedApproval, error) {
	var list savedList
	if err := b.doJSON(ctx, http.MethodGet, "/api/permission/saved", nil, &list); err != nil {
		return nil, err
	}
	out := make([]backend.SavedApproval, 0, len(list.Data))
	for _, d := range list.Data {
		out = append(out, backend.SavedApproval{ID: d.ID, Action: d.Action, Resource: d.Resource})
	}
	return out, nil
}

// RemoveSavedApproval implements backend.RuleHost. The id must be one the
// listing names: it ends up in a URL path, and a caller's string is not
// trusted to be an id.
func (b *Backend) RemoveSavedApproval(ctx context.Context, id string) error {
	saved, err := b.SavedApprovals(ctx)
	if err != nil {
		return err
	}
	for _, s := range saved {
		if s.ID == id {
			return b.doJSON(ctx, http.MethodDelete, "/api/permission/saved/"+url.PathEscape(id), nil, nil)
		}
	}
	return fmt.Errorf("no saved approval %q", id)
}

// stripForbidden removes what must never reach opencode from a request body: the
// deprecated `tools` map, which REPLACES a session's rules wholesale (and only
// knows allow/deny), so one stray field would drop the ceiling. No galopin
// call carries it; this is the guard that keeps it so.
func stripForbidden(body any) {
	if m, ok := body.(map[string]any); ok {
		delete(m, "tools")
	}
}

// RestartForPolicy restarts the opencode process on purpose: the only way to
// clear the in-memory "always" approvals it holds, which are checked after
// every rule and so outlive a ceiling that has just tightened. It returns once
// the new process is healthy. Sessions persist in opencode's own store; asks
// pending in the old process do not, and the caller withdraws them.
func (b *Backend) RestartForPolicy(ctx context.Context) error {
	b.mu.Lock()
	cmd, exited := b.cmd, b.exited
	stopped := b.stopped
	b.deliberate = true
	b.mu.Unlock()
	if stopped {
		return fmt.Errorf("opencode is stopping")
	}
	if cmd == nil || cmd.Process == nil {
		// Not running right now (it is mid-restart already): the next start
		// reads the current policy by itself.
		return b.waitHealthy(ctx, b.startTimeout())
	}
	signalGroupTerm(cmd)
	select {
	case <-exited:
	case <-time.After(stopGrace):
		signalGroupKill(cmd)
		<-exited
	case <-ctx.Done():
		return ctx.Err()
	}
	b.forgetAgentRules()
	// The new process is not healthy until the old one's port is free and the
	// new one answers, so poll until a start that happened AFTER the signal is
	// up. A start is a bump of backendGen.
	return b.waitHealthy(ctx, b.startTimeout())
}

func (b *Backend) startTimeout() time.Duration {
	if b.cfg.StartupTimeout > 0 {
		return b.cfg.StartupTimeout
	}
	return defaultStartupTimeout
}

// floorConfig renders the ceiling as the permission part of
// OPENCODE_CONFIG_CONTENT, merged over base (the pinned project-config
// content, or nothing). base's own keys survive except where the floor says
// otherwise, key by key.
func floorConfig(base map[string]any, c permrules.Ceiling) (string, error) {
	if base == nil {
		base = map[string]any{}
	}
	out := mergeConfig(base, c.Floor())
	body, err := json.Marshal(out)
	return string(body), err
}

// mergeConfig deep-merges over onto base (maps merge, anything else is replaced
// by over), returning a new map.
func mergeConfig(base, over map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(over))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range over {
		if bm, ok := out[k].(map[string]any); ok {
			if om, ok := v.(map[string]any); ok {
				out[k] = mergeConfig(bm, om)
				continue
			}
		}
		out[k] = v
	}
	return out
}
