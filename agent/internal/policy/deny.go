package policy

import (
	"fmt"
	"sort"

	"galopin/internal/decide"
	"galopin/internal/permrules"
)

// ADR 0109: a machine has no class limits; the session's word decides. What is
// left of the permission block is the owner's optional local deny (refuse-only,
// never settable over the link), the safe directories, and the deprecated
// fields an older policy.json carries (limits, max, rules), which are read,
// reported and ignored for one release.

// LimitsIgnoredNotice is what a policy.json that still carries limits, a
// ceiling or own rules is told.
const LimitsIgnoredNotice = "policy.json carries permission limits, a ceiling or own rules (limits, max, rules): they are ignored since ADR 0109 — galopin no longer has machine limits; the session's word (Plan, Ask, Allow, Auto) decides, and the next write of the file drops them. To refuse a class on this machine use --deny CLASS."

// DeprecatedFlagNotice names a flag that is accepted and ignored.
func DeprecatedFlagNotice(flag string) string {
	return fmt.Sprintf("--%s is ignored: galopin no longer has machine limits (ADR 0109); the session's word decides. To refuse a class on this machine use --deny CLASS (%s).", flag, classNames())
}

func classNames() string {
	s := ""
	for _, c := range decide.Classes {
		if !c.Denyable() {
			continue
		}
		if s != "" {
			s += ", "
		}
		s += string(c)
	}
	return s
}

// Normalize drops what ADR 0109 retired (limits, ceiling, own rules), keeping
// a notice when there was any, and tidies the deny list (sorted, no duplicate,
// only classes that can be denied; an unknown name is dropped). It returns the
// notices, also kept in p.Notices.
func (p *Permission) Normalize() []string {
	var notices []string
	if p.Limits != nil || p.Max != nil || p.Rules != nil {
		notices = append(notices, LimitsIgnoredNotice)
		p.Limits, p.Max, p.Rules = nil, nil, nil
	}
	seen := map[string]bool{}
	var deny []string
	for _, d := range p.Deny {
		if c, err := decide.ParseDeny(d); err == nil && !seen[string(c)] {
			seen[string(c)] = true
			deny = append(deny, string(c))
		}
	}
	sort.Strings(deny)
	p.Deny = deny
	p.Notices = notices
	return notices
}

// DenySet is the denied classes as the decision function takes them.
func (p Permission) DenySet() map[decide.Class]bool {
	out := map[decide.Class]bool{}
	for _, d := range p.Deny {
		if c, err := decide.ParseDeny(d); err == nil {
			out[c] = true
		}
	}
	return out
}

// Denied reports whether class c is denied locally.
func (p Permission) Denied(c decide.Class) bool { return p.DenySet()[c] }

// AddDeny adds classes to the deny list; it reports whether anything was new.
func (p *Permission) AddDeny(classes ...decide.Class) bool {
	have := p.DenySet()
	changed := false
	for _, c := range classes {
		if !have[c] {
			p.Deny = append(p.Deny, string(c))
			have[c] = true
			changed = true
		}
	}
	p.Normalize2()
	return changed
}

// RemoveDeny removes classes from the deny list (`policy set --no-deny`).
func (p *Permission) RemoveDeny(classes ...decide.Class) bool {
	drop := map[string]bool{}
	for _, c := range classes {
		drop[string(c)] = true
	}
	var kept []string
	changed := false
	for _, d := range p.Deny {
		if drop[d] {
			changed = true
			continue
		}
		kept = append(kept, d)
	}
	p.Deny = kept
	return changed
}

// Normalize2 tidies the deny list only, leaving notices alone.
func (p *Permission) Normalize2() {
	notices := p.Notices
	p.Normalize()
	p.Notices = notices
}

// Ceiling is the deny list as the rule package's per-key cap: a denied class
// caps its keys at deny (the stale-deny check reads it). Nothing else is capped.
func (p Permission) Ceiling() permrules.Ceiling {
	c := permrules.Ceiling{Max: map[string]permrules.Action{}}
	for cl := range p.DenySet() {
		for _, k := range decide.ClassKeys(cl) {
			c.Max[k] = permrules.Deny
		}
	}
	return c
}

// DenyLine is the one line `policy show` prints about the local deny.
func (p Permission) DenyLine() string {
	if len(p.Deny) == 0 {
		return "Local deny: none (--deny CLASS refuses a class on this machine whatever the session's word)."
	}
	return "Local deny: " + joinStrings(p.Deny) + " — refused on this machine whatever the session's word (galopin policy set --no-deny CLASS lifts one)."
}

func joinStrings(l []string) string {
	out := ""
	for i, s := range l {
		if i > 0 {
			out += ", "
		}
		out += s
	}
	return out
}
