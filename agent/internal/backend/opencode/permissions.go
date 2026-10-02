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
	"os"
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
func (b *Backend) composeFor(ctx context.Context, dir, agent, sessionID string) ([]permrules.Rule, error) {
	l := b.layers()
	panel := b.getOverlay(sessionID).Panel
	if len(l.Own) == 0 && len(l.Ceiling.Keys()) == 0 && len(panel.Touched) == 0 {
		return nil, nil
	}
	agentRules, err := b.agentRuleset(ctx, dir, agent)
	if err != nil && (hasAskCeiling(l.Ceiling) || len(panel.Touched) > 0) {
		return nil, fmt.Errorf("galopin could not read opencode's rules for agent %q, so it cannot apply this machine's ceiling: %w", agent, err)
	}
	if b.isChild(sessionID) {
		return permrules.ChildRulesFor(l, panel, agentRules), nil
	}
	return permrules.ComposeFor(l, panel, agentRules), nil
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
	return b.ensureRulesLocked(ctx, dir, sessionID, agent)
}

// ensureRulesLocked is ensureRules with perm.mu held.
func (b *Backend) ensureRulesLocked(ctx context.Context, dir, sessionID, agent string) error {
	rules, err := b.composeFor(ctx, dir, agent, sessionID)
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
// and none of the machine's own rules reach it (an allow must not) — only what a
// person set on the child itself. agent is the subagent type read from the
// parent's task call, "" when it is not known yet: then only denies are
// applied, since an ask cap restated blind could soften a read-only agent.
// Best effort by nature — a first tool call can win the race — which is what
// the agent-level floor is for.
func (b *Backend) ApplyChildRules(ctx context.Context, workspaceDir, sessionID, agent string) error {
	if b.cfg.Permissions == nil {
		return nil
	}
	b.perm.mu.Lock()
	defer b.perm.mu.Unlock()
	b.perm.childMu.Lock()
	if b.perm.childAgent == nil {
		b.perm.childAgent = map[string]string{}
	}
	if agent != "" || b.perm.childAgent[sessionID] == "" {
		b.perm.childAgent[sessionID] = agent
	}
	b.perm.childMu.Unlock()
	return b.applyChildLocked(ctx, workspaceDir, sessionID, agent)
}

// applyChildLocked composes and sends a child's rules. Caller holds perm.mu.
func (b *Backend) applyChildLocked(ctx context.Context, dir, sessionID, agent string) error {
	l := b.layers()
	panel := b.getOverlay(sessionID).Panel
	var rules []permrules.Rule
	known := agent != ""
	if known {
		agentRules, err := b.agentRuleset(ctx, dir, agent)
		if err != nil {
			known = false
		} else {
			rules = permrules.ChildRulesFor(l, panel, agentRules)
		}
	}
	if !known {
		rules = append(denyOnly(l.ChildCeiling()), panelDenies(panel)...)
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

// panelDenies is the part of a person's rules that is safe to apply without
// knowing the agent: its denies.
func panelDenies(p permrules.Panel) []permrules.Rule {
	var out []permrules.Rule
	for _, r := range p.Rules {
		if r.Action == permrules.Deny {
			out = append(out, r)
		}
	}
	return out
}

// SetSessionRules implements backend.RuleHost: the rules a person set on one
// session, replacing their earlier ones. The caller has clamped them to the
// ceiling; composeFor lowers them again under the ceiling's tail regardless, so
// what is applied can never exceed it. opencode only ever appends a session's
// rules, so a rule an earlier write set and this one drops is restored to what
// the base says rather than left standing (permrules.ComposeFor).
func (b *Backend) SetSessionRules(ctx context.Context, workspaceDir, sessionID string, rules []permrules.Rule) error {
	b.perm.mu.Lock()
	defer b.perm.mu.Unlock()
	ov := b.getOverlay(sessionID)
	ov.Panel = ov.Panel.With(rules)
	if err := b.setOverlay(sessionID, ov); err != nil {
		return err
	}
	if b.isChild(sessionID) {
		b.perm.childMu.Lock()
		agent := b.perm.childAgent[sessionID]
		b.perm.childMu.Unlock()
		return b.applyChildLocked(ctx, workspaceDir, sessionID, agent)
	}
	return b.ensureRulesLocked(ctx, workspaceDir, sessionID, b.agentFor(sessionID))
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
	return l.Plain(), nil
}

// RuleLayers implements backend.RuleHost. opencode hands back an agent's
// ruleset merged, with no record of which layer a rule came from, so the
// sources are attributed here: walking the list from its end, a rule that is
// one galopin's floor wrote for this agent is "floor", one the static
// opencode.json holds is "file", and the rest are opencode's own ("default").
func (b *Backend) RuleLayers(ctx context.Context, workspaceDir, sessionID string) (backend.RuleLayers, error) {
	agent := b.agentFor(sessionID)
	agentRules, err := b.agentRuleset(ctx, workspaceDir, agent)
	if err != nil {
		return backend.RuleLayers{}, err
	}
	l := b.layers()
	out := backend.RuleLayers{Agent: agent}

	floor := l.FloorRules(agent)
	file := b.fileRules()
	sources := make([]string, len(agentRules))
	for i := len(agentRules) - 1; i >= 0; i-- {
		sources[i] = backend.SourceDefault
		if k := indexRule(floor, agentRules[i]); k >= 0 {
			floor = append(floor[:k:k], floor[k+1:]...)
			sources[i] = backend.SourceFloor
		} else if k := indexRule(file, agentRules[i]); k >= 0 {
			file = append(file[:k:k], file[k+1:]...)
			sources[i] = backend.SourceFile
		}
	}
	for i, r := range agentRules {
		out.Rules = append(out.Rules, backend.SourcedRule{Rule: r, Source: sources[i]})
	}

	panel := b.getOverlay(sessionID).Panel
	ownLayers, nOwn := l, len(l.Own)
	if b.isChild(sessionID) {
		// A child gets no rule of the machine's as such: its restricting ones
		// travel inside the cap (permrules.Layers.ChildCeiling).
		ownLayers, nOwn = permrules.Layers{Ceiling: l.ChildCeiling()}, 0
	}
	cerea, tail := permrules.ComposeParts(ownLayers, panel, agentRules)
	for i, r := range cerea {
		src := backend.SourceCerea
		if i < nOwn {
			src = backend.SourceMachine
		}
		out.Rules = append(out.Rules, backend.SourcedRule{Rule: r, Source: src})
	}
	for _, r := range tail {
		out.Rules = append(out.Rules, backend.SourcedRule{Rule: r, Source: backend.SourceCeiling})
	}
	return out, nil
}

func (b *Backend) isChild(sessionID string) bool {
	b.perm.childMu.Lock()
	defer b.perm.childMu.Unlock()
	_, ok := b.perm.childAgent[sessionID]
	return ok
}

// OnProcessStart implements backend.RuleHost.
func (b *Backend) OnProcessStart(fn func()) {
	b.mu.Lock()
	b.onStart = fn
	b.mu.Unlock()
}

// processStarted is what runOnce calls once a new opencode process exists: the
// agent rules it cached belong to the old one, and the machine is told to forget
// what the old one held in memory.
func (b *Backend) processStarted() {
	b.forgetAgentRules()
	b.mu.Lock()
	fn := b.onStart
	b.mu.Unlock()
	if fn != nil {
		fn()
	}
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
	running := cmd != nil && cmd.Process != nil
	if running && !stopped {
		// Only a process this call is about to end earns the supervisor's
		// immediate restart; set otherwise it would wave through the next
		// unrelated crash.
		b.deliberate = true
	}
	b.mu.Unlock()
	if stopped {
		return fmt.Errorf("opencode is stopping")
	}
	if !running {
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
	// The old process's port is closed once it has exited, so a health check
	// that passes is the new one's.
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
func floorConfig(base map[string]any, l permrules.Layers) (string, error) {
	if base == nil {
		base = map[string]any{}
	}
	out := mergeConfig(base, l.Floor())
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

// indexRule finds r in rs (-1 when absent).
func indexRule(rs []permrules.Rule, r permrules.Rule) int {
	for i, x := range rs {
		if x == r {
			return i
		}
	}
	return -1
}

// fileRules reads the `permission` block of the static opencode.json galopin
// owns, as rules. An unreadable file or one with no block is no rules.
func (b *Backend) fileRules() []permrules.Rule {
	if b.cfg.ConfigPath == "" {
		return nil
	}
	raw, err := os.ReadFile(b.cfg.ConfigPath)
	if err != nil {
		return nil
	}
	var cfg struct {
		Permission map[string]any `json:"permission"`
	}
	if json.Unmarshal(raw, &cfg) != nil {
		return nil
	}
	return permrules.FromConfig(cfg.Permission)
}
