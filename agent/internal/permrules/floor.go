package permrules

// The agent-level floor: the ceiling restated as opencode CONFIG, handed over
// as OPENCODE_CONFIG_CONTENT at every start. A session's rules (Compose) are
// what normally enforce the ceiling, but a subagent's session is created by
// opencode itself — it inherits its parent's denies and nothing else — so
// between its creation and the moment galopin PATCHes it, and for any agent
// galopin could not read, only the agent's own rules stand. The floor puts the
// ceiling there.
//
// The same last-match-wins trap as Tail applies, and here there is no agent
// ruleset to read before the process starts: a config `edit: ask` after the
// plan agent's `edit: deny` would turn the deny into an ask. So a floor entry
// is written only for an agent that GRANTS the key by default, from a table
// of opencode 1.18.32's built-in agents; floor_it_test.go compares the table
// against the live binary's GET /agent for every capped key, so a release that
// changes a built-in agent fails there instead of loosening a machine.

import "sort"

// builtinAgents are the agents the floor covers: the two primaries a person
// picks and the two subagents the task tool starts. compaction, summary and
// title deny every tool, so a floor has nothing to say to them.
var builtinAgents = []string{"build", "plan", "general", "explore"}

// exploreKeys is what explore's own rules allow (everything else is denied by
// its `"*": deny`); a floor `ask` is written only for these.
var exploreKeys = map[string]bool{
	"bash": true, "webfetch": true, "websearch": true, "grep": true, "glob": true, "list": true, "read": true,
}

// agentGrants reports whether a built-in agent allows key by default, which is
// the only case in which an `ask` floor tightens rather than loosens.
func agentGrants(agent, key string) bool {
	switch agent {
	case "build", "general":
		return true
	case "plan":
		// plan denies edit outright and carries a per-pattern deny on task.
		return key != "edit" && key != "task"
	case "explore":
		return exploreKeys[key]
	}
	return false
}

// planEdit and exploreEdit re-state the two built-in read-only agents' edit
// rules. A static `edit: ask` in opencode.json (what `enroll` now writes) sits
// after them in the merge and would soften both; the floor puts them back on
// top. plan keeps its project plan file, as the built-in does.
var (
	planEdit    = map[string]any{"*": "deny", ".opencode/plans/*.md": "allow"}
	exploreEdit = "deny"
)

// subagents are the built-in agents the task tool starts. Their sessions are
// created by opencode, before galopin can give them rules, so they are the ones
// the floor also holds to the machine's own restricting rules (ChildCeiling).
var subagents = map[string]bool{"general": true, "explore": true}

// Floor is the permission part of OPENCODE_CONFIG_CONTENT for ceiling c:
// {"permission": {...}, "agent": {name: {"permission": {...}}}}.
func (c Ceiling) Floor() map[string]any { return floorFor(c, c) }

// subagentAsk is what the floor holds a subagent to before its session has its
// root's selector: the blanket's own names ask. A subagent starts its first tool
// call as soon as opencode creates it, and the selector's rules land a moment
// later (the root's mode, which is Ask unless a person said otherwise), so a
// default that allowed would let the first call through on every machine,
// ceiling or none. Asking here is the safe side of that window; the session's own
// rules, which sit above config, then say what the root's mode really is.
var subagentAsk = Ceiling{Max: map[string]Action{
	"edit": Ask, "bash": Ask, "webfetch": Ask, "websearch": Ask, "codesearch": Ask, "task": Ask,
}}

// Floor is the floor for these layers: the ceiling for every built-in agent,
// and for the subagents also the machine's own ask/deny rules, restated as caps
// the way ChildCeiling does, and the blanket's names asking by default
// (subagentAsk) — a subagent's first tool call can beat the rules galopin
// applies to its session, and this is what holds that window.
func (l Layers) Floor() map[string]any {
	return floorFor(l.Ceiling, l.ChildCeiling().Meet(subagentAsk))
}

// FloorRules is the floor for agent as rules.
func (l Layers) FloorRules(agent string) []Rule { return floorRules(l.Floor(), agent) }

func floorFor(top, sub Ceiling) map[string]any {
	topCfg := map[string]any{}
	agents := map[string]map[string]any{}
	for _, name := range builtinAgents {
		agents[name] = map[string]any{}
	}
	agents["plan"]["edit"] = planEdit
	agents["explore"]["edit"] = exploreEdit
	for _, name := range builtinAgents {
		c := top
		if subagents[name] {
			c = sub
		}
		for _, k := range c.Keys() {
			switch c.Of(k) {
			case Deny:
				agents[name][k] = string(Deny)
			case Ask:
				if agentGrants(name, k) {
					agents[name][k] = string(Ask)
				}
			}
		}
	}
	for _, k := range top.Keys() {
		if top.Of(k) == Deny {
			topCfg[k] = string(Deny)
		}
	}
	names := make([]string, 0, len(agents))
	for n := range agents {
		names = append(names, n)
	}
	sort.Strings(names)
	agentCfg := map[string]any{}
	for _, n := range names {
		if len(agents[n]) > 0 {
			agentCfg[n] = map[string]any{"permission": agents[n]}
		}
	}
	out := map[string]any{"agent": agentCfg}
	if len(topCfg) > 0 {
		out["permission"] = topCfg
	}
	return out
}
