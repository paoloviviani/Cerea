package opencode

// The constant "everything asks" floor (ADR 0097), the permission part of
// OPENCODE_CONFIG_CONTENT. It is written once per start of the process, from
// nothing a person can change per session, and it is what makes every tool
// call of every agent, from its first call and in every child session, reach
// galopin as a permission.asked.
//
// Verified against opencode v1.18.34 (agent/agent.ts): the global `permission`
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
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"sort"
	"strings"

	"galopin/internal/permrules"
)

// kv is one entry of an ordered JSON object: opencode reads a permission
// object's keys in order (last match wins), which a Go map would lose.
type kv struct {
	K string
	V any
}

// ordered is a JSON object that keeps its entries' order.
type ordered []kv

func (o ordered) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, e := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(e.K)
		v, err := json.Marshal(e.V)
		if err != nil {
			return nil, err
		}
		b.Write(k)
		b.WriteByte(':')
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
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

// builtinAgents are the agents whose own denies the floor restates, by the
// shape their rules have in 1.18.34.
func builtinAgentFloor() map[string]any {
	hidden := map[string]any{"permission": ordered{{"*", "deny"}}}
	return map[string]any{
		"plan": map[string]any{"permission": ordered{
			// plan's own edit rule, with the plan file asking (galopin lets
			// it through on Plan), and its general-subagent deny.
			{"edit", ordered{{"*", "deny"}, {".opencode/plans/*.md", "ask"}}},
			{"task", ordered{{"*", "ask"}, {"general", "deny"}}},
		}},
		"explore": map[string]any{"permission": ordered{
			{"*", "deny"},
			{"bash", "ask"}, {"glob", "ask"}, {"grep", "ask"}, {"list", "ask"},
			{"read", "ask"}, {"webfetch", "ask"}, {"websearch", "ask"},
			{"external_directory", ordered{{"*", "ask"}}},
		}},
		"compaction": hidden,
		"title":      hidden,
		"summary":    hidden,
	}
}

// floorContent is the OPENCODE_CONFIG_CONTENT permission part: the constant
// floor plus patch, the per-agent entries for agents that are not built in
// (see customAgentPatch).
func floorContent(patch map[string]any) map[string]any {
	top := ordered{{"*", "ask"}}
	for _, k := range floorKeys {
		top = append(top, kv{k, "ask"})
	}
	agents := builtinAgentFloor()
	for name, v := range patch {
		if _, builtin := agents[name]; !builtin {
			agents[name] = v
		}
	}
	return map[string]any{"permission": top, "agent": agents}
}

var builtinNames = map[string]bool{
	"build": true, "plan": true, "general": true, "explore": true,
	"compaction": true, "title": true, "summary": true,
}

// agentInfo is one agent as GET /agent reports it.
type agentInfo struct {
	Name       string           `json:"name"`
	Native     bool             `json:"native"`
	Permission []permrules.Rule `json:"permission"`
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
		var block ordered
		for _, k := range names {
			block = append(block, kv{k, restate(a.Permission, k)})
		}
		patch[a.Name] = map[string]any{"permission": block}
	}
	return patch
}

// restate is the agent's rules for exactly key, allow taken to ask. A key the
// agent does not mention asks.
func restate(rules []permrules.Rule, key string) any {
	var o ordered
	for _, r := range rules {
		if r.Permission != key {
			continue
		}
		act := r.Action
		if act == permrules.Allow {
			act = permrules.Ask
		}
		// A later rule for the same pattern replaces an earlier one (last match
		// wins), and a JSON object cannot repeat a key.
		for i := range o {
			if o[i].K == r.Pattern {
				o = append(o[:i:i], o[i+1:]...)
				break
			}
		}
		o = append(o, kv{r.Pattern, string(act)})
	}
	if len(o) == 0 {
		return "ask"
	}
	if len(o) == 1 && o[0].K == "*" {
		return o[0].V
	}
	// opencode reads the object in order and the last match wins; a catch-all
	// ask first keeps "no rule matched" at ask.
	if o[0].K != "*" {
		o = append(ordered{{"*", "ask"}}, o...)
	}
	return o
}

// floorConfig is OPENCODE_CONFIG_CONTENT: the floor merged over base (the
// pinned project-config content, or nothing), plus the per-agent patch.
func floorConfig(base map[string]any, patch map[string]any) (string, error) {
	if base == nil {
		base = map[string]any{}
	}
	out := mergeConfig(base, floorContent(patch))
	body, err := json.Marshal(out)
	return string(body), err
}

// checkFloor reads every agent opencode reports and looks for a call that
// would run without asking galopin. A custom agent's own allows are closed with
// a per-agent patch and one more start; a built-in agent that still allows
// something (a release that changed one) is only reported, because the floor
// table is what the live test compares against the binary.
func (b *Backend) checkFloor(ctx context.Context) {
	var agents []agentInfo
	if err := b.doJSON(ctx, http.MethodGet, "/agent", nil, &agents); err != nil {
		b.cfg.Logf("opencode: could not read the agents to check the permission floor: %v", err)
		return
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
