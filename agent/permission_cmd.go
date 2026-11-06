package main

import (
	"fmt"
	"strings"

	"galopin/internal/decide"
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

// parseDenyFlags reads repeated --deny CLASS values (ADR 0109).
func parseDenyFlags(flag string, values []string) ([]decide.Class, error) {
	var out []decide.Class
	for _, v := range values {
		c, err := decide.ParseDeny(strings.TrimSpace(v))
		if err != nil {
			return nil, fmt.Errorf("--%s %q: %w", flag, v, err)
		}
		out = append(out, c)
	}
	return out, nil
}

// retiredFlagNotices says, for each retired flag that was given (--limit,
// --permission-max, --permission-rule), that it is accepted and ignored. The
// values are not parsed: an old command line must keep working.
func retiredFlagNotices(limits, permMax, permRules []string) []string {
	var out []string
	if len(limits) > 0 {
		out = append(out, policy.DeprecatedFlagNotice("limit"))
	}
	if len(permMax) > 0 {
		out = append(out, policy.DeprecatedFlagNotice("permission-max"))
	}
	if len(permRules) > 0 {
		out = append(out, policy.DeprecatedFlagNotice("permission-rule"))
	}
	return out
}

// permissionPolicySummary says, in plain words, what the machine decides
// about permissions: nothing of its own except the fixed floor and the local
// deny; the session's word decides the rest.
func permissionPolicySummary(pol policy.Policy) string {
	p := pol.Permission
	var b strings.Builder
	b.WriteString("Permissions — this machine has no limits of its own (ADR 0109): the session's word decides (Plan refuses, Ask is a card, Allow runs, Auto runs the classes the user chose). Fixed, whatever the word: galopin's own state and config are never allowed; credential paths, writes into .git and CI config, and a repeating agent are always a card.")
	b.WriteString("\n  " + p.DenyLine())
	b.WriteString("\n  Limits in policy.json and --limit, --permission-max and --permission-rule are ignored.")
	if dirs := p.EffectiveSafeDirs(); len(dirs) > 0 {
		b.WriteString("\n  Safe directories (outside the project, never ask): " + strings.Join(policy.DisplaySafeDirs(dirs), ", ") + ".")
	} else {
		b.WriteString("\n  No safe directories: everything outside the project is the outside class.")
	}
	b.WriteString("\n  Sessions start on Ask; a user moves a session to Plan, Allow or Auto in the /code composer.")
	for _, n := range p.Notices {
		b.WriteString("\n  Note: " + n)
	}
	return b.String()
}
