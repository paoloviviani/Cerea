package opencode

// The permission pass-through's opencode half (PROTOCOL.md §6 "Permissions",
// ADR 0097). galopin answers opencode's permission asks and writes no rules
// into its sessions: the selector, the exceptions and the coordination grant
// live in the overlay and are read by the decision function (internal/decide),
// and opencode's own config carries one constant "everything asks" floor
// (floor.go). The only thing ever written to a session's stored rules is ONE
// neutralising rule on a session that already had rules from an older galopin
// (prepareSession), because opencode's rules are append-only and a stored
// allow would otherwise let a call through unasked.
//
// What opencode does, read from the 1.18.34 source: a session's rules sit after
// the agent's and the LAST matching rule wins; a subagent inherits only its
// parent's denies and external_directory rules; PATCH /session/:id APPENDS.

import (
	"context"
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
	// mu serializes selector changes and the one-time legacy check, so two
	// prompts racing on one session do not both PATCH.
	mu sync.Mutex

	agentMu    sync.Mutex
	agentCache map[string]agentRulesEntry // by workspace directory

	// staleMu guards stale, separately from mu: detection runs under mu (it
	// does I/O like the PATCH beside it) while StaleDeny reads the cache
	// from anywhere.
	staleMu sync.Mutex
	stale   map[string]staleEntry // by root session id

	// floorMu guards the floor's start-time state: the per-agent patch that
	// closes custom agents' own allows, and the last check's findings.
	// checked is the roots prepareSession has looked at in this process.
	checked map[string]bool

	floorMu       sync.Mutex
	floorPatch    map[string]any
	floorBreaches []string

	// childAgent remembers which agent a subagent session runs, once the
	// materializer has read it from the parent's task call.
	childMu    sync.Mutex
	childAgent map[string]string
	// parentOf is each subagent session's parent, as the session records said,
	// so a session's root (the one that carries the selector) and the
	// subagents under a root can be found without asking opencode.
	parentOf map[string]string
}

// staleEntry is the cached stale-deny verdict for one legacy root: whether
// the rules opencode keeps for it carry a blanket deny from an old galopin
// (stale) or a deny the ceiling no longer imposes (policy). Computed once per
// process from the stored rules; new sessions never have any.
type staleEntry struct {
	stale  bool
	policy bool
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

// forgetChild drops a subagent session from the child maps: opencode has
// answered 404 for it (the session was deleted), and keeping it would make
// every later updateSelector retry a PATCH that can only fail again. Its
// persisted overlay is left alone — harmless, and cleanup there is not
// worth the write.
func (b *Backend) forgetChild(sessionID string) {
	b.perm.childMu.Lock()
	delete(b.perm.childAgent, sessionID)
	delete(b.perm.parentOf, sessionID)
	b.perm.childMu.Unlock()
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

// StoredRules reads the session's rules as opencode keeps them (GET
// /session/{id} → permission). opencode only appends, so what it returns is
// the whole history of composed blocks, including ones from before a
// deny-as-ask-style change.
func (b *Backend) StoredRules(ctx context.Context, sessionID string) ([]permrules.Rule, error) {
	var m struct {
		Permission []permrules.Rule `json:"permission"`
	}
	if err := b.doJSON(ctx, http.MethodGet, "/session/"+url.PathEscape(sessionID), nil, &m); err != nil {
		return nil, err
	}
	return m.Permission, nil
}

// StaleDeny implements backend.RuleHost: the cached verdict for sessionID's
// root (false until the first prompt after this process learned the session
// refreshed it). A read of the cache — never I/O.
func (b *Backend) StaleDeny(sessionID string) bool {
	root := b.rootOf(sessionID)
	b.perm.staleMu.Lock()
	defer b.perm.staleMu.Unlock()
	return b.perm.stale[root].stale
}

// StalePolicy implements backend.RuleHost: like StaleDeny, for a deny the
// ceiling no longer imposes (an earlier machine policy).
func (b *Backend) StalePolicy(sessionID string) bool {
	root := b.rootOf(sessionID)
	b.perm.staleMu.Lock()
	defer b.perm.staleMu.Unlock()
	return b.perm.stale[root].policy
}

// PermissionMode implements backend.RuleHost.
func (b *Backend) PermissionMode(sessionID string) permrules.Action {
	return b.selectorOf(sessionID).Effective()
}

// Exceptions implements backend.RuleHost.
func (b *Backend) Exceptions(sessionID string) []permrules.Exception {
	return append([]permrules.Exception(nil), b.selectorOf(sessionID).Exceptions...)
}

// Coordination implements backend.RuleHost.
func (b *Backend) Coordination(sessionID string) []string {
	return append([]string(nil), b.selectorOf(sessionID).Coordination...)
}

// SetCoordination implements backend.RuleHost: the grant is kept in the root's
// selector (so it is persisted with it and survives a restart) and the rules are
// re-applied to the root and every subagent under it.
func (b *Backend) SetCoordination(ctx context.Context, workspaceDir, sessionID string, keys []string) error {
	return b.updateSelector(ctx, workspaceDir, sessionID, func(s permrules.Selector) (permrules.Selector, error) {
		s.Coordination = append([]string(nil), keys...)
		return s, nil
	})
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

// updateSelector changes the ROOT session's selector. It is galopin's own state
// (the overlay): nothing is written to opencode, so a change takes effect at
// the session's next ask, mid-turn included.
func (b *Backend) updateSelector(_ context.Context, _, sessionID string, change func(permrules.Selector) (permrules.Selector, error)) error {
	b.perm.mu.Lock()
	defer b.perm.mu.Unlock()
	root := b.rootOf(sessionID)
	ov := b.getOverlay(root)
	next, err := change(ov.Selector)
	if err != nil {
		return err
	}
	ov.Selector = next
	return b.setOverlay(root, ov)
}

// prepareSession runs before a prompt or command on a session. For a session
// whose stored rules came from an older galopin it writes ONE neutralising
// rule ("everything asks", last) and never writes again, records that in the
// overlay, and caches the stale-deny verdict for the banner. A session with no
// stored rules (every session this galopin created) is only noted as clean.
//
// What it cannot fix: stale denies already stored still seed every future
// opencode child of this session (deriveSubagentSessionPermission copies all
// parent denies and external_directory rules), so the banner stays for these
// legacy sessions only, and the way out is a new session.
func (b *Backend) prepareSession(ctx context.Context, dir, sessionID string) {
	if b.cfg.Permissions == nil {
		return
	}
	root := b.rootOf(sessionID)
	b.perm.mu.Lock()
	defer b.perm.mu.Unlock()
	if b.perm.checked == nil {
		b.perm.checked = map[string]bool{}
	}
	if b.perm.checked[root] {
		return
	}
	stored, err := b.StoredRules(ctx, root)
	if err != nil {
		b.cfg.Logf("opencode: reading the stored rules of %s: %v", root, err)
		return
	}
	b.perm.checked[root] = true
	ov := b.getOverlay(root)
	if len(stored) == 0 {
		return
	}
	composed := denyOnlyRules(b.layers().Ceiling)
	stale := permrules.FindStaleBlanketDeny(stored, composed)
	policy := permrules.FindStalePolicyDenies(stored, composed, b.layers().Ceiling)
	b.perm.staleMu.Lock()
	if b.perm.stale == nil {
		b.perm.stale = map[string]staleEntry{}
	}
	b.perm.stale[root] = staleEntry{stale: stale, policy: policy}
	b.perm.staleMu.Unlock()
	if ov.Neutralised {
		return
	}
	rule := []permrules.Rule{{Permission: "*", Pattern: "*", Action: permrules.Ask}}
	if err := b.doJSON(ctx, http.MethodPatch, "/session/"+url.PathEscape(root), map[string]any{"permission": rule}, nil); err != nil {
		b.cfg.Logf("opencode: could not neutralise the stored rules of %s (it still asks through the floor, but an old allow may let a call through): %v", root, err)
		return
	}
	ov.Neutralised = true
	if err := b.setOverlay(root, ov); err != nil {
		b.cfg.Logf("opencode: recording the neutralised rules of %s: %v", root, err)
	}
}

// PrepareSession runs the legacy check now (prompts do it themselves); tests
// and the machine use it to refresh a session's stale-deny verdict.
func (b *Backend) PrepareSession(ctx context.Context, dir, sessionID string) {
	b.prepareSession(ctx, dir, sessionID)
}

// denyOnlyRules is the ceiling's denies as rules, the one thing a stored deny
// may legitimately still be.
func denyOnlyRules(c permrules.Ceiling) []permrules.Rule {
	var out []permrules.Rule
	for _, k := range c.Keys() {
		if c.Of(k) == permrules.Deny {
			out = append(out, permrules.Rule{Permission: k, Pattern: "*", Action: permrules.Deny})
		}
	}
	return out
}

// PendingAsks is every permission ask opencode still holds (GET /permission).
// galopin answers them on start: an ask raised while galopin was down stays
// pending (opencode waits for a reply with no timeout) and is decided by the
// same function as a live one.
func (b *Backend) PendingAsks(ctx context.Context) ([]backend.PermissionRequest, error) {
	var raw []any
	if err := b.doJSON(ctx, http.MethodGet, "/permission", nil, &raw); err != nil {
		return nil, err
	}
	var out []backend.PermissionRequest
	for _, m := range asMaps(raw) {
		out = append(out, permissionFromMap(m))
	}
	return out, nil
}

// PlanDirs is where opencode's plan agent keeps its plans outside the project.
func (b *Backend) PlanDirs() []string {
	data := ""
	home := ""
	for _, kv := range b.cfg.Env {
		switch {
		case strings.HasPrefix(kv, "XDG_DATA_HOME="):
			data = strings.TrimPrefix(kv, "XDG_DATA_HOME=")
		case strings.HasPrefix(kv, "HOME="):
			home = strings.TrimPrefix(kv, "HOME=")
		}
	}
	if b.cfg.Env == nil {
		data, home = os.Getenv("XDG_DATA_HOME"), os.Getenv("HOME")
	}
	if data == "" && home != "" {
		data = home + "/.local/share"
	}
	if data == "" {
		return nil
	}
	return []string{data + "/opencode/plans"}
}

// AgentRules is the session's agent and its rules as opencode reports them
// (display only: galopin's decisions are made by internal/decide, not from
// these), each marked with whether the floor wrote it.
func (b *Backend) AgentRules(ctx context.Context, workspaceDir, sessionID string) (backend.RuleLayers, error) {
	agent := b.agentFor(sessionID)
	agentRules, err := b.agentRuleset(ctx, workspaceDir, agent)
	if err != nil {
		return backend.RuleLayers{}, err
	}
	out := backend.RuleLayers{Agent: agent, Mode: string(b.selectorOf(sessionID).Effective())}
	for _, r := range agentRules {
		out.Rules = append(out.Rules, backend.SourcedRule{Rule: r, Source: backend.SourceDefault})
	}
	return out, nil
}

// planNote rides on every prompt of a session on Plan whose agent is not the
// plan agent (a scheduled or granted run keeps its agent): the turn's extra
// system prompt (prompt_async's `system`). Plan refuses every call that would
// change something, so a model told that says what it would do instead of
// burning calls on refusals.
const planNote = "The person has set this session to Plan. Running commands, " +
	"editing or writing files, fetching from the web and other changes are " +
	"switched off: every such call is refused, so do not make any. " +
	"Reading and searching the project, and starting read-only subagents, still work. " +
	"If the request needs a switched-off tool, do not substitute another tool for it: " +
	"say what you would run or change, and ask the person to switch the session to Ask or Allow."
