package main

import (
	"fmt"
	"sort"
	"strings"

	"galopin/internal/decide"
	"galopin/internal/permrules"
	"galopin/internal/policy"
)

// The permission flags shared by `enroll` and `policy set` (PROTOCOL.md §4
// "Permission"). A permission KEY is opencode's own name for a tool class —
// edit, bash, webfetch, … — or one of galopin's coordination tools:
// session_read, session_send and session_spawn.

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

// parseLimitFlags reads repeated CLASS=VALUE values (--limit command=ask):
// the class must be one of the eight and the value one that class takes.
func parseLimitFlags(values []string) (map[decide.Class]decide.Limit, error) {
	out := map[decide.Class]decide.Limit{}
	for _, v := range values {
		k, w, ok := strings.Cut(v, "=")
		k, w = strings.TrimSpace(k), strings.TrimSpace(w)
		if !ok || k == "" || w == "" {
			return nil, fmt.Errorf("--limit %q: want CLASS=VALUE (for example command=ask)", v)
		}
		c, err := decide.ParseClass(k)
		if err != nil {
			return nil, fmt.Errorf("--limit %q: %w", v, err)
		}
		l, ok := decide.ParseLimit(w)
		if !ok || w == "deny" || w == "allow" || !c.Allows(l) {
			return nil, fmt.Errorf("--limit %q: the %s class takes %s", v, c, c.AllowedWords())
		}
		out[c] = l
	}
	return out, nil
}

// legacyLimits maps the old --permission-max / --permission-rule values onto
// classes (the one-release alias): a class named through any of its keys takes
// the most cautious word given for them; an own allow rule is carried only by
// the same rule as a migrated one. The notices say what was mapped or dropped.
func legacyLimits(maxFlags, ruleFlags []string) (map[decide.Class]decide.Limit, map[string]string, []string, error) {
	max, err := parseKeyActions("permission-max", maxFlags)
	if err != nil {
		return nil, nil, nil, err
	}
	rules, err := parseKeyActions("permission-rule", ruleFlags)
	if err != nil {
		return nil, nil, nil, err
	}
	out := map[decide.Class]decide.Limit{}
	var notices []string
	named := map[decide.Class]bool{}
	note := func(flag, key, word string, c decide.Class, ok bool) {
		if !ok {
			notices = append(notices, fmt.Sprintf("--%s %s=%s has no class and was ignored", flag, key, word))
			return
		}
		notices = append(notices, fmt.Sprintf("--%s %s=%s is now the %s class", flag, key, word, c))
	}
	for _, src := range []struct {
		flag string
		m    map[string]string
	}{{"permission-max", max}, {"permission-rule", rules}} {
		for k, w := range src.m {
			c, ok := decide.KeyClass(k)
			if src.flag == "permission-rule" && permrules.Action(w) == permrules.Allow {
				continue // an own allow rule: handled by the migration below
			}
			note(src.flag, k, w, c, ok)
			if !ok {
				continue
			}
			l := map[permrules.Action]decide.Limit{permrules.Deny: decide.Never, permrules.Ask: decide.AskLimit, permrules.Allow: decide.Run}[permrules.Action(w)]
			if c == decide.ClassLoop {
				l = map[bool]decide.Limit{true: decide.Stop, false: decide.AskLimit}[l == decide.Never]
			}
			if cur, seen := out[c]; seen {
				l = decide.Stricter(cur, l)
			}
			if !c.Allows(l) {
				notices = append(notices, fmt.Sprintf("--%s %s=%s cannot apply: the %s class takes %s", src.flag, k, w, c, c.AllowedWords()))
				continue
			}
			out[c], named[c] = l, true
		}
	}
	// Own allow rules go through the migration's agreement rule.
	carried := map[string]string{}
	if len(rules) > 0 {
		legacy := policy.Permission{Rules: rules}
		legacy.Normalize()
		for k, v := range legacy.Rules {
			carried[k] = v
		}
		for _, n := range legacy.Notices {
			notices = append(notices, n)
		}
		// An allow on external_directory lifts the outside class to run.
		if permrules.Action(rules["external_directory"]) == permrules.Allow {
			if _, set := out[decide.ClassOutside]; !set {
				out[decide.ClassOutside] = decide.Run
			}
		}
	}
	if len(maxFlags) > 0 || len(ruleFlags) > 0 {
		notices = append([]string{"--permission-max and --permission-rule are deprecated and will be removed next release: use --limit CLASS=never|ask|run (galopin policy show lists the classes)"}, notices...)
	}
	return out, carried, notices, nil
}

// permissionPolicySummary says, in plain words, what the machine decides
// about permissions: the class table, then the safe directories.
func permissionPolicySummary(pol policy.Policy) string {
	p := pol.Permission
	var b strings.Builder
	b.WriteString("Permissions — what this machine allows, per class (galopin's own state and config are never allowed, whatever the table says):\n")
	b.WriteString(strings.Join(p.Table(), "\n"))
	b.WriteString("\n  'ask' means judged before it happens, by whoever Cerea routes it to; 'run' leaves it to the session's word (Plan, Ask or Allow).")
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
		b.WriteString("\n  This machine's own allow rules (carried over): " + strings.Join(rs, ", ") + ".")
	}
	if dirs := p.EffectiveSafeDirs(); len(dirs) > 0 {
		b.WriteString("\n  Safe directories (outside the project, never ask): " + strings.Join(policy.DisplaySafeDirs(dirs), ", ") + ".")
	} else {
		b.WriteString("\n  No safe directories: everything outside the project is the outside class.")
	}
	b.WriteString("\n  Sessions start on Ask; a person moves a session to Plan or Allow in the /code composer, and the limits cap both.")
	for _, n := range p.Notices {
		b.WriteString("\n  Note: " + n)
	}
	return b.String()
}
