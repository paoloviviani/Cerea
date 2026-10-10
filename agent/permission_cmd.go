package main

import (
	"fmt"
	"sort"
	"strings"

	"galopin/internal/permrules"
	"galopin/internal/policy"
)

// The permission flags shared by `enroll` and `policy set` (PROTOCOL.md §4
// "Permission"). A permission KEY is opencode's own name for a tool class —
// edit, bash, webfetch, … — or one of galopin's coordination tools:
// session_read, session_send and session_spawn.

// defaultEnrollMax is the ceiling a fresh enroll writes: bash asks. It is the
// one default that is not about convenience. If the ceiling let bash run, the
// agent could read opencode's server password out of its own environment and
// widen its own session's rules past the ceiling; an ask in front of bash is
// what keeps that off by default (the honest gap, PROTOCOL.md §6).
//
// session_spawn is deliberately NOT capped by default: a spawn is bounded
// (depth, live count, rate), audited with both sessions named, and the child
// is capped by the same ceiling as its caller — so an Allow session spawns
// with no card out of the box, while bash still asks per command. Machines
// enrolled before this default carry session_spawn=ask in their own file and
// keep it; re-enroll (or an explicit --permission-max list) adopts the new one.
func defaultEnrollMax() map[string]string {
	return map[string]string{"bash": string(permrules.Ask)}
}

// staticPermission is what a fresh enroll writes into the opencode.json it
// owns: the tool classes that change files or reach out ask. Existing machines
// are not migrated — their file is whatever they have — and galopin's own
// rules and ceiling (policy.json) sit above this file either way.
func staticPermission() map[string]string {
	return map[string]string{"edit": "ask", "bash": "ask", "webfetch": "ask"}
}

// parseKeyActions turns repeated KEY=ACTION flag values into a map, refusing
// a pattern where a key belongs and a word that is not allow, ask or deny.
func parseKeyActions(flag string, values []string) (map[string]string, error) {
	out := map[string]string{}
	for _, v := range values {
		k, a, ok := strings.Cut(v, "=")
		k, a = strings.TrimSpace(k), strings.TrimSpace(a)
		if !ok || k == "" {
			return nil, fmt.Errorf("--%s %q: want KEY=ACTION (for example bash=ask)", flag, v)
		}
		if permrules.IsWildcard(k) {
			return nil, fmt.Errorf("--%s %q: %q is a pattern; use a literal permission key such as bash", flag, v, k)
		}
		if !permrules.Action(a).Valid() {
			return nil, fmt.Errorf("--%s %q: %q is not allow, ask or deny", flag, v, a)
		}
		out[k] = a
	}
	return out, nil
}

// tighten merges want into have, accepting only values that restrict. A key
// not in have reads as allow: for a ceiling that is no cap, and for a rule it
// means setting "allow" where there was nothing is a loosening too (it would
// beat the static file). It returns the first refusal so the caller can name
// the `enroll` re-run that does what was asked.
func tighten(flag string, have, want map[string]string) (map[string]string, error) {
	out := map[string]string{}
	for k, v := range have {
		out[k] = v
	}
	keys := make([]string, 0, len(want))
	for k := range want {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		cur := permrules.Allow
		if v, ok := have[k]; ok {
			cur = permrules.Action(v)
		}
		next := permrules.Action(want[k])
		if next == cur {
			continue
		}
		if permrules.Min(cur, next) != next {
			return nil, fmt.Errorf("--%s %s=%s does not tighten the current %s: re-run enroll to loosen it", flag, k, next, cur)
		}
		out[k] = string(next)
	}
	return out, nil
}

// permissionPolicySummary says, in plain words, what the machine decides
// about permissions.
func permissionPolicySummary(pol policy.Policy) string {
	p := pol.Permission
	var parts []string
	if len(p.Max) == 0 {
		parts = append(parts, "no ceiling (opencode's own rules decide what asks)")
	} else {
		keys := make([]string, 0, len(p.Max))
		for k := range p.Max {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var caps []string
		for _, k := range keys {
			caps = append(caps, k+"≤"+p.Max[k])
		}
		parts = append(parts, "ceiling "+strings.Join(caps, ", ")+" — no rule, selector or \"always allow\" goes past it")
	}
	if len(p.Rules) > 0 {
		keys := make([]string, 0, len(p.Rules))
		for k := range p.Rules {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var rs []string
		for _, k := range keys {
			rs = append(rs, k+"="+p.Rules[k])
		}
		parts = append(parts, "this machine's own rules "+strings.Join(rs, ", "))
	}
	if dirs := pol.Permission.EffectiveSafeDirs(); len(dirs) > 0 {
		parts = append(parts, "safe directories "+strings.Join(policy.DisplaySafeDirs(dirs), ", ")+
			" never ask (the ceiling on external_directory still caps them)")
	} else {
		parts = append(parts, "no safe directories: every external_directory asks")
	}
	parts = append(parts, "sessions start on Ask; a person moves a session to Deny or Allow in the /code composer, and the ceiling caps both")
	return "Permissions: " + strings.Join(parts, "; ") + "."
}
