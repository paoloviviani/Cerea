package opencode

// The permission pass-through's opencode half (PROTOCOL.md §6 "Permissions").
// opencode owns every tool permission; this file is where galopin puts what
// opencode cannot know — the machine's own rules and its ceiling, and the
// Deny/Ask/Allow selector a person set on the session with the exceptions they
// made — into the rules a session carries, and takes the one liberty the
// pass-through needs, restarting the process, when the ceiling tightens.
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
	"regexp"
	"sort"
	"strings"
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
	// parentOf is each subagent session's parent, as the session records said,
	// so a session's root (the one that carries the selector) and the
	// subagents under a root can be found without asking opencode.
	parentOf map[string]string
}

// layers is the machine's current inputs (empty when none are configured).
func (b *Backend) layers() permrules.Layers {
	if b.cfg.Permissions == nil {
		return permrules.Layers{}
	}
	return b.cfg.Permissions()
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
	if b.perm.parentOf == nil {
		b.perm.parentOf = map[string]string{}
	}
	b.perm.parentOf[s.ID] = s.ParentID
	if _, known := b.perm.childAgent[s.ID]; !known {
		b.perm.childAgent[s.ID] = ""
	}
	if b.perm.childAgent[s.ID] == "" {
		b.perm.childAgent[s.ID] = agentFromTitle(s.Title)
	}
}

// childTitleAgent matches the suffix opencode puts on a subagent session's title
// when its task tool creates it: "<description> (@<agent> subagent)". Anchored at
// the end, so only opencode's own suffix counts, not anything the model wrote
// into the description.
var childTitleAgent = regexp.MustCompile(`\(@([A-Za-z0-9_.-]+) subagent\)$`)

// agentFromTitle is the agent a subagent session's title names, "" when it
// names none. It is a hint, available from the session's first event, for the
// moment before the parent's task call says the same thing; a name that is not
// one of opencode's agents is not applied (composeFor fails on it, and
// applyChildLocked falls back to denies only).
func agentFromTitle(title string) string {
	if m := childTitleAgent.FindStringSubmatch(strings.TrimSpace(title)); m != nil {
		return m[1]
	}
	return ""
}

// RootOf is the top-level session a session belongs to as far as this backend
// has learned (itself when it is one, or when its parent is not known yet).
func (b *Backend) RootOf(sessionID string) string { return b.rootOf(sessionID) }

// rootOf is the top-level session a session belongs to (itself when it is one).
func (b *Backend) rootOf(sessionID string) string {
	b.perm.childMu.Lock()
	defer b.perm.childMu.Unlock()
	seen := map[string]bool{sessionID: true}
	current := sessionID
	for {
		parent := b.perm.parentOf[current]
		if parent == "" || seen[parent] {
			return current
		}
		seen[parent] = true
		current = parent
	}
}

// descendantsOf is every subagent session known under root, at any depth.
func (b *Backend) descendantsOf(root string) []string {
	b.perm.childMu.Lock()
	ids := make([]string, 0, len(b.perm.parentOf))
	for id := range b.perm.parentOf {
		ids = append(ids, id)
	}
	b.perm.childMu.Unlock()
	var out []string
	for _, id := range ids {
		if id != root && b.rootOf(id) == root {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

// selectorOf is the selector in force for a session: its root's.
func (b *Backend) selectorOf(sessionID string) permrules.Selector {
	return b.getOverlay(b.rootOf(sessionID)).Selector
}

// composeFor is the rules a session running agent gets now. It always
// composes: a session nobody set is on Ask, so even a machine whose policy
// predates permissions (no rules, no ceiling) asks before it writes. The
// agent's rules are what the blanket is restated over (permrules.Compose), so
// when they cannot be read it fails: a blanket applied blind could soften a
// deny, and an unapplied one is no selector.
func (b *Backend) composeFor(ctx context.Context, dir, agent, sessionID string) ([]permrules.Rule, error) {
	l := b.layers()
	agentRules, err := b.agentRuleset(ctx, dir, agent)
	if err != nil {
		return nil, fmt.Errorf("galopin could not read opencode's rules for agent %q, so it cannot apply this machine's permission rules: %w", agent, err)
	}
	sel := b.selectorOf(sessionID)
	if b.isChild(sessionID) {
		return permrules.ChildRules(l, sel, agentRules), nil
	}
	return permrules.Compose(l, sel, agentRules), nil
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

// ApplyChildRules gives a subagent session opencode created its root's selector
// and the ceiling. The child already has its parent's denies; what it lacks is
// the root's mode block and exceptions and the ceiling's caps, and none of the
// machine's own rules reach it (an allow must not) — only their restrictions, as
// caps. agent is the subagent type read from the parent's task call, "" when it
// is not known yet: then only denies are applied, since a blanket restated blind
// could soften a read-only agent. Best effort by nature — a first tool call can
// win the race — which is what the agent-level floor is for.
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
	if agent != "" {
		b.perm.childAgent[sessionID] = agent
	}
	// Not told: the title's hint, if there is one.
	agent = b.perm.childAgent[sessionID]
	b.perm.childMu.Unlock()
	return b.applyChildLocked(ctx, workspaceDir, sessionID, agent)
}

// applyChildLocked composes and sends a child's rules. Caller holds perm.mu.
func (b *Backend) applyChildLocked(ctx context.Context, dir, sessionID, agent string) error {
	l := b.layers()
	sel := b.selectorOf(sessionID)
	var rules []permrules.Rule
	known := agent != ""
	if known {
		agentRules, err := b.agentRuleset(ctx, dir, agent)
		if err != nil {
			known = false
		} else {
			rules = permrules.ChildRules(l, sel, agentRules)
		}
	}
	if !known {
		rules = denyOnly(l.ChildCeiling())
		if sel.Effective() == permrules.Deny {
			// Deny restricts whatever the agent is: the blanket's own names are
			// refused outright until the agent is known and the whole block lands.
			for _, k := range permrules.Blanket {
				rules = append(rules, permrules.Rule{Permission: k, Pattern: "*", Action: permrules.Deny})
			}
		}
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

// denyNote rides on every prompt of a session on Deny, as a synthetic part.
// opencode does not refuse a tool whose every pattern is denied: it removes
// the tool from the model's tool list. A model asked to curl a site then has
// no bash, is not told why, and reaches for what is left (list, read), then
// apologises for "the wrong tool". Told, it says what it would run and asks
// for the setting to change instead.
const denyNote = "The person has set this session to Deny. Running commands, " +
	"editing or writing files, fetching from the web and starting subagents are " +
	"switched off, so those tools are missing from your tool list on purpose. " +
	"Reading and searching the project still work. If the request needs a " +
	"switched-off tool, do not substitute another tool for it: say what you would " +
	"run or change, and ask the person to switch the session to Ask or Allow."

// PermissionMode implements backend.RuleHost.
func (b *Backend) PermissionMode(sessionID string) permrules.Action {
	return b.selectorOf(sessionID).Effective()
}

// Exceptions implements backend.RuleHost.
func (b *Backend) Exceptions(sessionID string) []permrules.Exception {
	return append([]permrules.Exception(nil), b.selectorOf(sessionID).Exceptions...)
}

// SetPermissionMode implements backend.RuleHost.
func (b *Backend) SetPermissionMode(ctx context.Context, workspaceDir, sessionID string, mode permrules.Action) error {
	return b.updateSelector(ctx, workspaceDir, sessionID, func(s permrules.Selector) (permrules.Selector, error) {
		s.Mode = mode
		return s, nil
	})
}

// AddException implements backend.RuleHost.
func (b *Backend) AddException(ctx context.Context, workspaceDir, sessionID string, e permrules.Exception) (permrules.Exception, error) {
	var stored permrules.Exception
	err := b.updateSelector(ctx, workspaceDir, sessionID, func(s permrules.Selector) (permrules.Selector, error) {
		next, kept := s.With(e)
		stored = kept
		return next, nil
	})
	return stored, err
}

// RemoveException implements backend.RuleHost.
func (b *Backend) RemoveException(ctx context.Context, workspaceDir, sessionID, id string) (bool, error) {
	found := false
	err := b.updateSelector(ctx, workspaceDir, sessionID, func(s permrules.Selector) (permrules.Selector, error) {
		next, ok := s.Without(id)
		found = ok
		return next, nil
	})
	return found, err
}

// updateSelector changes the ROOT session's selector and re-applies the rules to
// the root and to every subagent under it, so a change reaches a child that is
// already running and not only the ones that appear later. A root that cannot
// be given its new rules keeps its old selector: what is shown must be what is
// enforced. A subagent that cannot be reached keeps the change (the root already
// carries it, and the next re-application retries the child, its fingerprint
// being stale) but the error is returned, because a Deny that did not land on a
// running child must not be reported as done.
func (b *Backend) updateSelector(ctx context.Context, dir, sessionID string, change func(permrules.Selector) (permrules.Selector, error)) error {
	b.perm.mu.Lock()
	defer b.perm.mu.Unlock()
	root := b.rootOf(sessionID)
	ov := b.getOverlay(root)
	prev := ov.Selector
	next, err := change(prev)
	if err != nil {
		return err
	}
	ov.Selector = next
	if err := b.setOverlay(root, ov); err != nil {
		return err
	}
	if b.cfg.Permissions == nil {
		return nil
	}
	if err := b.ensureRulesLocked(ctx, dir, root, b.agentFor(root)); err != nil {
		ov = b.getOverlay(root)
		ov.Selector = prev
		_ = b.setOverlay(root, ov)
		return err
	}
	var failed []string
	for _, child := range b.descendantsOf(root) {
		b.perm.childMu.Lock()
		agent := b.perm.childAgent[child]
		b.perm.childMu.Unlock()
		if err := b.applyChildLocked(ctx, dir, child, agent); err != nil {
			failed = append(failed, fmt.Sprintf("%s: %v", child, err))
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("the session's rules changed, but a subagent under it could not be given them (%s)", strings.Join(failed, "; "))
	}
	return nil
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

	sel := b.selectorOf(sessionID)
	out.Mode = string(sel.Effective())
	ownLayers, nOwn := l, len(l.Own)
	if b.isChild(sessionID) {
		// A child gets no rule of the machine's as such: its restricting ones
		// travel inside the cap (permrules.Layers.ChildCeiling).
		ownLayers, nOwn = permrules.Layers{Ceiling: l.ChildCeiling()}, 0
	}
	cerea, tail := permrules.ComposeParts(ownLayers, sel, agentRules)
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
// agent rules it cached belong to the old one, and the machine is told that
// whatever the old one held in memory — its pending asks — is gone.
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

// RestartForPolicy restarts the opencode process on purpose, so that nothing the
// old one kept in memory outlives a ceiling that has just tightened (galopin no
// longer forwards an "always" to opencode, but an older process or a session
// from before the selector may still hold one, and they are checked after every
// rule). It returns once the new process is healthy. Sessions persist in
// opencode's own store; asks pending in the old process do not, and the caller
// withdraws them.
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
