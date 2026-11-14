package opencode

// The constant "everything asks" floor (ADR 0097), the permission part of
// OPENCODE_CONFIG_CONTENT. It is written once per start of the process, from
// nothing a person can change per session, and it is what makes every tool
// call of every agent, from its first call and in every child session, reach
// galopin as a permission.asked.
//
// Read from opencode v1.18.34 (agent/agent.ts) and re-run green on the pinned
// release (agent/packaging/opencode-version, 1.19.3; floor_it_test.go and the
// upgrade canaries, 2026-11-07), so the pin and the floor agree: the global `permission`
// config ("user") is merged LAST inside every built-in agent, so a bare `*: ask`
// also turns plan's `edit: deny`, explore's `"*": deny` and the hidden agents'
// `"*": deny` into asks (and un-hides their tools). A per-agent config block is
// merged after `user`, so the floor restates those denies there. The same block
// closes a custom agent's own allows (see customAgentPatch).
//
// The floor never names `task` or `todowrite` at the top level and never gives
// a subagent a literal `task` rule: task.ts only adds a child's own task and
// todowrite denies when the agent has no rule literally named so.

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"strings"
	"time"

	"galopin/internal/permrules"
)

// rule is one entry of 2.x's ordered `permissions` array (last match wins).
type rule = map[string]string

func mk(action, resource, effect string) rule {
	return rule{"action": v2Action(action), "resource": resource, "effect": effect}
}

// floorKeys are the opencode permission keys the floor names at the top level
// besides `*`, so a lower config source that lists one of them after its own
// `*` cannot leave it allowed (mergeDeep keeps a key's first position).
var floorKeys = []string{
	"bash", "codesearch", "edit", "external_directory", "glob", "grep", "list",
	"lsp", "read", "skill", "webfetch", "websearch",
}

// probeKeys are what the live check evaluates for every agent: the floor's
// keys, galopin-visible internals and a made-up MCP tool key.
var probeKeys = append(append([]string(nil), floorKeys...), "task", "todowrite", "doom_loop", "galopin_probe_tool")

// builtinAgentFloor restates the denies of the built-in agents, by the shape
// their rules have in 2.3.0 (GET /api/agent; floor_it_test.go compares the two).
// A global `*: ask` is appended AFTER an agent's own default rules, so without
// this block it would turn plan's edit deny, explore's `*` deny and the hidden
// agents' denies into asks. Agent blocks come last.
func (b *Backend) builtinAgentFloor(denies map[string]bool) map[string]any {
	ask := func(k string) string {
		if denies[k] {
			return "deny"
		}
		return "ask"
	}
	hidden := map[string]any{"permissions": []rule{mk("*", "*", "deny")}}
	// The owner's own file denies are restated in every agent block too: the
	// global `*: ask` would otherwise beat a lower layer's deny.
	var denyBlock []rule
	for _, k := range floorKeys {
		if denies[k] {
			denyBlock = append(denyBlock, mk(k, "*", "deny"))
		}
	}
	planRules := []rule{mk("edit", "*", "deny")}
	for _, d := range b.PlanDirs() {
		// galopin lets the plan file through on Plan (it asks).
		planRules = append(planRules, mk("edit", d+"/*", "ask"))
	}
	out := map[string]any{
		"plan": map[string]any{"permissions": planRules},
		"explore": map[string]any{"permissions": []rule{
			mk("*", "*", "deny"),
			mk("bash", "*", ask("bash")), mk("glob", "*", ask("glob")), mk("grep", "*", ask("grep")),
			mk("read", "*", ask("read")), mk("webfetch", "*", ask("webfetch")), mk("websearch", "*", ask("websearch")),
			mk("external_directory", "*", "ask"),
		}},
		// a general-purpose subagent neither asks the person questions nor
		// starts subagents of its own
		"general":    map[string]any{"permissions": []rule{mk("question", "*", "deny"), mk("task", "*", "deny")}},
		"compaction": hidden,
		"title":      hidden,
		"summary":    hidden,
	}
	if len(denyBlock) > 0 {
		out["build"] = map[string]any{"permissions": denyBlock}
		for _, name := range []string{"plan", "explore", "general"} {
			blk := out[name].(map[string]any)["permissions"].([]rule)
			for _, d := range denyBlock {
				if name == "plan" && d["action"] == "edit" {
					continue
				}
				blk = append(blk, d)
			}
			out[name] = map[string]any{"permissions": blk}
		}
	}
	return out
}

// floorContent is the OPENCODE_CONFIG_CONTENT permission part: the constant
// floor plus patch, the per-agent entries for agents that are not built in
// (see customAgentPatch).
func (b *Backend) floorContent(patch map[string]any, denies map[string]bool) map[string]any {
	top := []rule{mk("*", "*", "ask")}
	for _, k := range floorKeys {
		if denies[k] {
			top = append(top, mk(k, "*", "deny"))
		} else {
			top = append(top, mk(k, "*", "ask"))
		}
	}
	// Code Mode (`execute`) would run the other tools from a script behind one
	// card; denying it lists them directly, so every call is its own ask.
	top = append(top, mk("execute", "*", "deny"))
	// opencode 2.3 runs every subagent in the background and has no switch for
	// it: a machine that does not allow background subagents gets no subagents
	// at all (fail closed).
	if !b.cfg.BackgroundSubagents {
		top = append(top, mk("task", "*", "deny"))
	}
	agents := b.builtinAgentFloor(denies)
	for name, v := range patch {
		if _, builtin := agents[name]; !builtin {
			agents[name] = v
		}
	}
	return map[string]any{"permissions": top, "agents": agents}
}

var builtinNames = map[string]bool{
	"build": true, "plan": true, "general": true, "explore": true,
	"compaction": true, "title": true, "summary": true,
}

// agentInfo is one agent as GET /api/agent reports it, rules in 1.x key names.
type agentInfo struct {
	Name       string
	Native     bool
	Permission []permrules.Rule
}

// evalExact is opencode's evaluation for one key and pattern "*": the last rule
// that matches both, ask when none does.
func evalExact(rules []permrules.Rule, key string) permrules.Action {
	return permrules.Evaluate(rules, key, "*")
}

// Breach is one native allow found in an agent after the floor: a call the
// agent would run without asking galopin.
type Breach struct {
	Agent, Key string
}

// findBreaches evaluates every agent for the probe keys and reports each
// native allow, with an allow-listed exception for opencode's own truncation
// directory (which is pattern-level and never pattern "*").
func findBreaches(agents []agentInfo) []Breach {
	var out []Breach
	for _, a := range agents {
		for _, k := range probeKeys {
			if evalExact(a.Permission, k) == permrules.Allow {
				out = append(out, Breach{a.Name, k})
			}
		}
		// A pattern-level allow that is still the last word for its own
		// pattern (bash: {"git *": allow}) is a breach too. opencode's own
		// safe directories (external_directory, added after config) are not.
		for _, r := range a.Permission {
			if r.Action != permrules.Allow || r.Pattern == "*" || r.Permission == "external_directory" {
				continue
			}
			if permrules.Evaluate(a.Permission, r.Permission, r.Pattern) == permrules.Allow {
				out = append(out, Breach{a.Name, r.Permission + " " + r.Pattern})
			}
		}
	}
	return out
}

// customAgentPatch builds the per-agent floor entries for agents that are not
// built in and carry a native allow. For every key the agent names, and for `*`,
// it restates the agent's own rules for that key in order with each allow taken
// to ask (denies and asks are kept), so the agent block — merged after the
// global floor — cannot leave anything allowed. The machine's policy rules are
// the place for a standing allow (decision step 7).
func customAgentPatch(agents []agentInfo) map[string]any {
	patch := map[string]any{}
	for _, a := range agents {
		if a.Native || builtinNames[a.Name] {
			continue
		}
		if len(findBreaches([]agentInfo{a})) == 0 {
			continue
		}
		// Existing keys keep their position in opencode's merge and a key the
		// agent block does not have yet lands after them, so a restated `*`
		// would beat the agent's own later denies: it is written only when the
		// agent's own blanket allows (an unknown key evaluates to allow).
		keys := map[string]bool{}
		for _, k := range probeKeys {
			keys[k] = true
		}
		for _, r := range a.Permission {
			if r.Permission != "*" {
				keys[r.Permission] = true
			}
		}
		if evalExact(a.Permission, "galopin_probe_tool") == permrules.Allow {
			keys["*"] = true
		}
		names := make([]string, 0, len(keys))
		for k := range keys {
			names = append(names, k)
		}
		sort.Strings(names)
		// `*` first so a named key restated after it wins, as in the agent.
		sort.SliceStable(names, func(i, j int) bool { return names[i] == "*" && names[j] != "*" })
		var block []rule
		for _, k := range names {
			block = append(block, restate(a.Permission, k)...)
		}
		patch[a.Name] = map[string]any{"permissions": block}
	}
	return patch
}

// restate is the agent's rules for exactly key, allow taken to ask, led by a
// catch-all ask so "no rule matched" stays an ask. A key the agent does not
// mention is just that ask.
func restate(rules []permrules.Rule, key string) []rule {
	out := []rule{mk(key, "*", "ask")}
	for _, r := range rules {
		if r.Permission != key {
			continue
		}
		act := r.Action
		if act == permrules.Allow {
			act = permrules.Ask
		}
		out = append(out, mk(key, r.Pattern, string(act)))
	}
	return out
}

// floorConfig is OPENCODE_CONFIG_CONTENT: the floor merged over base (the
// pinned project-config content, or nothing), plus the per-agent patch.
//
// A 1.x `permission` object in base (the static block enroll wrote) is turned
// into 2.x rules and put BEFORE the floor's: the two spellings in one layer
// would otherwise leave their relative order to opencode's normaliser, and the
// floor must be the last word.
func (b *Backend) floorConfig(base map[string]any, patch map[string]any, denies map[string]bool) (string, error) {
	if base == nil {
		base = map[string]any{}
	}
	floor := b.floorContent(patch, denies)
	var before []rule
	if p, ok := base["permission"].(map[string]any); ok {
		before = append(before, rulesFromV1Object(p)...)
		cp := make(map[string]any, len(base))
		for k, v := range base {
			if k != "permission" {
				cp[k] = v
			}
		}
		base = cp
	}
	if len(before) > 0 {
		floor["permissions"] = append(before, floor["permissions"].([]rule)...)
	}
	out := mergeConfig(base, floor)
	body, err := json.Marshal(out)
	return string(body), err
}

// rulesFromV1Object reads a 1.x permission object ({tool: "allow"} or
// {tool: {pattern: "allow"}}, keys in file order lost: sorted, with a tool's
// own `*` first) as 2.x rules.
func rulesFromV1Object(p map[string]any) []rule {
	keys := make([]string, 0, len(p))
	for k := range p {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var out []rule
	for _, k := range keys {
		switch v := p[k].(type) {
		case string:
			out = append(out, mk(k, "*", v))
		case map[string]any:
			pats := make([]string, 0, len(v))
			for pat := range v {
				pats = append(pats, pat)
			}
			sort.SliceStable(pats, func(i, j int) bool { return pats[i] == "*" && pats[j] != "*" })
			for _, pat := range pats {
				if eff, ok := v[pat].(string); ok {
					out = append(out, mk(k, pat, eff))
				}
			}
		}
	}
	return out
}

// checkFloor reads every agent opencode reports and looks for a call that
// would run without asking galopin. A custom agent's own allows are closed with
// a per-agent patch and one more start; a built-in agent that still allows
// something (a release that changed one) is only reported, because the floor
// table is what the live test compares against the binary.
func (b *Backend) checkFloor(ctx context.Context) {
	// The agents list is partial while the location loads: read until the floor's own
	// marker (Code Mode denied, written only by floorContent) shows on the build agent.
	var entries []map[string]any
	var err error
	for attempt := 0; attempt < 40; attempt++ {
		entries, err = b.agentEntries(ctx, "")
		if err != nil || hasFloorMarker(entries) {
			break
		}
		b.forgetAgentRules()
		select {
		case <-ctx.Done():
			attempt = 40
		case <-time.After(250 * time.Millisecond):
		}
	}
	if err != nil {
		b.cfg.Logf("opencode: could not read the agents to check the permission floor: %v", err)
		return
	}
	var agents []agentInfo
	for _, e := range entries {
		agents = append(agents, agentInfo{Name: getStr(e, "id", "name"), Permission: rulesFromV2(getSlice(e, "permissions"))})
	}
	breaches := findBreaches(agents)
	names := make([]string, 0, len(breaches))
	for _, br := range breaches {
		names = append(names, br.Agent+":"+br.Key)
	}
	b.perm.floorMu.Lock()
	b.perm.floorBreaches = names
	have := b.perm.floorPatch
	b.perm.floorMu.Unlock()
	if len(breaches) == 0 {
		return
	}
	patch := customAgentPatch(agents)
	b.cfg.Logf("opencode: floor breach: %s allow without asking galopin", strings.Join(names, ", "))
	if len(patch) == 0 || reflect.DeepEqual(patchKeys(patch), patchKeys(have)) {
		return
	}
	b.perm.floorMu.Lock()
	b.perm.floorPatch = patch
	b.perm.floorMu.Unlock()
	b.cfg.Logf("opencode: restarting once to close custom agents' own allows (the machine's policy rules are the place for standing allows)")
	if err := b.RestartForPolicy(ctx); err != nil {
		b.cfg.Logf("opencode: restart for the floor patch failed: %v", err)
		return
	}
	b.checkFloor(ctx)
}

func patchKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// FloorBreaches is the last check's findings, "agent:key" each: calls an agent
// runs without asking galopin. Empty when the floor holds.
func (b *Backend) FloorBreaches() []string {
	b.perm.floorMu.Lock()
	defer b.perm.floorMu.Unlock()
	return append([]string(nil), b.perm.floorBreaches...)
}

// fileDenies are the keys the galopin-owned opencode.json (OPENCODE_CONFIG)
// denies outright: the owner's own deny stands under the floor, which would
// otherwise turn it into an ask.
func fileDenies(path string) map[string]bool {
	out := map[string]bool{}
	if path == "" {
		return out
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	var cfg struct {
		Permission  map[string]any   `json:"permission"`
		Permissions []map[string]any `json:"permissions"`
	}
	if json.Unmarshal(raw, &cfg) != nil {
		return out
	}
	for _, k := range floorKeys {
		if v, ok := cfg.Permission[k].(string); ok && v == "deny" {
			out[k] = true
		}
	}
	for _, r := range cfg.Permissions {
		if getStr(r, "effect") == "deny" && getStr(r, "resource") == "*" {
			if k := v1Name(getStr(r, "action")); k != "*" {
				out[k] = true
			}
		}
	}
	return out
}

// floorConfigFor is floorConfig for a Config without a running Backend
// (childEnv also serves `galopin launch opencode`).
func floorConfigFor(cfg Config, base map[string]any, patch map[string]any, denies map[string]bool) (string, error) {
	return (&Backend{cfg: cfg}).floorConfig(base, patch, denies)
}

// hasFloorMarker reports whether the build agent carries the floor's execute deny.
func hasFloorMarker(entries []map[string]any) bool {
	for _, e := range entries {
		if getStr(e, "id", "name") != "build" {
			continue
		}
		for _, r := range asMaps(getSlice(e, "permissions")) {
			if getStr(r, "action") == "execute" && getStr(r, "effect") == "deny" {
				return true
			}
		}
	}
	return false
}
