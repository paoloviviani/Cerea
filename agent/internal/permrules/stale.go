package permrules

// Stale blanket denies: opencode's session rules are append-only (Permission.merge
// concatenates), so a Deny block written before deny-as-ask stays in the
// session forever — and opencode seeds every task child with its parent's deny
// rules only, so that block keeps poisoning each new child's first turn long
// after the root moved on to Ask or Allow. New blocks carry no blanket deny
// (see ComposeParts), which is what makes an old one detectable: a deny the
// current composition no longer contains.

// FindStaleBlanketDeny reports whether stored — a session's rules as opencode
// keeps them — carries a blanket deny the current composition does not
// contain: any deny with pattern `*` for `*` or a Blanket name. The tool-
// visibility sentinel is not one (its pattern is never `*`), and neither is a
// deny the composition still carries (a machine or ceiling deny in force).
func FindStaleBlanketDeny(stored, composed []Rule) bool {
	if len(stored) == 0 {
		return false
	}
	have := make(map[Rule]bool, len(composed))
	for _, r := range composed {
		have[r] = true
	}
	for _, r := range stored {
		if r.Action != Deny || r.Pattern != "*" || IsToolVisibilitySentinel(r) {
			continue
		}
		if r.Permission != "*" && !isBlanketName(r.Permission) {
			continue
		}
		if !have[r] {
			return true
		}
	}
	return false
}

func isBlanketName(key string) bool {
	for _, k := range Blanket {
		if k == key {
			return true
		}
	}
	return false
}
