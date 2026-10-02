// Package permrules is the pure half of the permission pass-through
// (PROTOCOL.md §6 "Permissions"): opencode's rule vocabulary, its
// last-match-wins evaluation, and the composer that turns the machine's two
// inputs — its own rules and its ceiling — into the rules a session carries.
//
// It performs no I/O. The opencode backend feeds it rulesets it read from
// the server and sends back what it returns; nothing here is a source of
// authority on its own.
//
// The one idea that is easy to get wrong: opencode evaluates by LAST MATCH,
// so "the ceiling is appended last" is not enough by itself. A ceiling of
// `edit: ask` appended as one rule would also turn the plan agent's
// `edit: deny` into an ask, because the appended rule matches last. The
// ceiling is therefore applied as a CAP: for every key it limits, the tail
// re-states the rules already in force (the agent's, then galopin's own),
// each lowered to the ceiling, so the tail's last match is always
// min(what was in force, ceiling) and never looser.
package permrules

import (
	"regexp"
	"sort"
	"strings"
)

// Action is one rule's verdict, opencode's own three words.
type Action string

const (
	Allow Action = "allow"
	Ask   Action = "ask"
	Deny  Action = "deny"
)

// Valid reports whether a is one of the three words.
func (a Action) Valid() bool { return a == Allow || a == Ask || a == Deny }

// rank orders actions by how much they permit: deny < ask < allow.
func rank(a Action) int {
	switch a {
	case Deny:
		return 0
	case Ask:
		return 1
	default:
		return 2
	}
}

// Min is the stricter of two actions.
func Min(a, b Action) Action {
	if rank(a) <= rank(b) {
		return a
	}
	return b
}

// Rule is one opencode permission rule, in opencode's wire shape (the session
// `permission` field and GET /agent's `permission` use exactly this).
type Rule struct {
	Permission string `json:"permission"`
	Pattern    string `json:"pattern"`
	Action     Action `json:"action"`
}

// IsWildcard reports whether a permission key stands for more than itself.
func IsWildcard(key string) bool { return strings.ContainsAny(key, "*?") }

// Match is opencode's Wildcard.match: `*` is any run, `?` any one character,
// the whole string must match, and a trailing " *" also matches the bare
// command ("ls *" matches "ls" and "ls -la"). Backslashes are slashes.
func Match(s, pattern string) bool {
	s = strings.ReplaceAll(s, `\`, "/")
	pattern = strings.ReplaceAll(pattern, `\`, "/")
	var b strings.Builder
	b.WriteString("(?s)^")
	trailing := strings.HasSuffix(pattern, " *")
	if trailing {
		pattern = strings.TrimSuffix(pattern, " *")
	}
	for _, r := range pattern {
		switch r {
		case '*':
			b.WriteString(".*")
		case '?':
			b.WriteString(".")
		default:
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	if trailing {
		b.WriteString("( .*)?")
	}
	b.WriteString("$")
	re, err := regexp.Compile(b.String())
	if err != nil {
		return false
	}
	return re.MatchString(s)
}

// Evaluate is opencode's rule resolution: the LAST rule whose permission and
// pattern both match wins, and no match means ask.
func Evaluate(rules []Rule, permission, pattern string) Action {
	for i := len(rules) - 1; i >= 0; i-- {
		r := rules[i]
		if Match(permission, r.Permission) && Match(pattern, r.Pattern) {
			return r.Action
		}
	}
	return Ask
}

// Ceiling is the machine's cap, per permission key: the most a key may ever
// be, whatever any rule or any approval says. A key absent from Max is not
// capped (its ceiling is allow). Keys are literal names (`edit`, `bash`,
// `session_spawn`), never patterns.
type Ceiling struct {
	Max map[string]Action
}

// Of is the ceiling for one key.
func (c Ceiling) Of(key string) Action {
	if a, ok := c.Max[key]; ok && a.Valid() {
		return a
	}
	return Allow
}

// Limits reports whether the ceiling restricts key at all.
func (c Ceiling) Limits(key string) bool { return c.Of(key) != Allow }

// Cap lowers a to the ceiling for key.
func (c Ceiling) Cap(key string, a Action) Action { return Min(a, c.Of(key)) }

// Keys is the capped keys, sorted — a stable order so equal ceilings compose
// to equal rules.
func (c Ceiling) Keys() []string {
	keys := make([]string, 0, len(c.Max))
	for k, a := range c.Max {
		if a.Valid() && a != Allow && k != "" && !IsWildcard(k) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

// Meet is the stricter of two ceilings, key by key: what a ceiling that may
// only tighten becomes when a new one is read.
func (c Ceiling) Meet(o Ceiling) Ceiling {
	out := Ceiling{Max: map[string]Action{}}
	for _, k := range c.Keys() {
		out.Max[k] = c.Of(k)
	}
	for _, k := range o.Keys() {
		out.Max[k] = Min(out.Of(k), o.Of(k))
	}
	return out
}

// TighterThan reports whether c restricts anything o does not (a key capped
// lower than o caps it, or capped where o was not).
func (c Ceiling) TighterThan(o Ceiling) bool {
	for _, k := range c.Keys() {
		if rank(c.Of(k)) < rank(o.Of(k)) {
			return true
		}
	}
	return false
}

// Equal reports whether two ceilings cap every key identically.
func (c Ceiling) Equal(o Ceiling) bool { return !c.TighterThan(o) && !o.TighterThan(c) }

// Layers are the two machine inputs to a session's rules.
type Layers struct {
	// Own is galopin's own rules for the machine (policy.json's
	// permission.rules): they beat opencode's static file, because a session's
	// rules sit above config. Never allow-rules the ceiling forbids: the tail
	// lowers them.
	Own     []Rule
	Ceiling Ceiling
}

// Tail is the ceiling expressed as rules that can only restrict. in is every
// rule already in force beneath it, in evaluation order (the agent's, then
// the session's own).
//
//   - a key capped at deny gets one `key * deny`, which nothing beneath can
//     beat;
//   - a key capped at ask gets `key * ask` as a base (for inputs nothing
//     beneath matches), then every beneath rule that applies to the key,
//     restated for that key and lowered to ask. The tail's last match for any
//     input is then the cap of the beneath rules' last match, so a deny
//     beneath stays a deny.
//
// With in == nil (the agent's rules could not be read) the ask base is all
// there is; callers log that, because it can loosen a deny it could not see.
func (c Ceiling) Tail(in []Rule) []Rule {
	var out []Rule
	for _, k := range c.Keys() {
		max := c.Of(k)
		if max == Deny {
			out = append(out, Rule{k, "*", Deny})
			continue
		}
		out = append(out, Rule{k, "*", Ask})
		for _, r := range in {
			if !Match(k, r.Permission) {
				continue
			}
			restated := Rule{k, r.Pattern, Min(r.Action, max)}
			if n := len(out); n > 0 && out[n-1] == restated {
				continue
			}
			out = append(out, restated)
		}
	}
	return out
}

// Compose is the rules a session is created with (and re-sent with when
// anything they derive from changes): the machine's own rules, then the
// ceiling's tail over everything beneath them. agent is the session's agent's
// effective rules (opencode's GET /agent). The ceiling is last, every time.
func Compose(l Layers, agent []Rule) []Rule {
	out := append([]Rule(nil), l.Own...)
	in := append(append([]Rule(nil), agent...), l.Own...)
	return append(out, l.Ceiling.Tail(in)...)
}

// ChildRules is what a subagent session gets: the ceiling's tail over the
// child agent's own rules, and nothing of the machine's own rules — opencode
// hands a child only its parent's denies, and an allow must not reach a child
// by any other road either. (Denies need no help: opencode carries them.)
func ChildRules(l Layers, agent []Rule) []Rule {
	return l.Ceiling.Tail(agent)
}

// Grant is how the two galopin coordination tools are decided from rules.
// They have no opencode permission of their own, so galopin reads the asking
// agent's rules for their names. A wildcard ALLOW says nothing about them —
// opencode's default is `"*": allow`, and reading that as consent would
// silently enable session traffic on every machine — while a wildcard deny
// refuses them like everything else it denies.
func Grant(rules []Rule, tool string) Action {
	var kept []Rule
	for _, r := range rules {
		if IsWildcard(r.Permission) && r.Action == Allow {
			continue
		}
		kept = append(kept, r)
	}
	return Evaluate(kept, tool, "*")
}

// Fingerprint is a stable identity for a ruleset, so "re-send only on
// change" compares one string.
func Fingerprint(rules []Rule) string {
	var b strings.Builder
	for _, r := range rules {
		b.WriteString(r.Permission)
		b.WriteByte(0)
		b.WriteString(r.Pattern)
		b.WriteByte(0)
		b.WriteString(string(r.Action))
		b.WriteByte('\n')
	}
	return b.String()
}

// OwnRules renders policy's key→action map as rules (pattern "*"), sorted by
// key so equal maps are equal rules.
func OwnRules(m map[string]Action) []Rule {
	keys := make([]string, 0, len(m))
	for k, a := range m {
		if k != "" && a.Valid() {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	out := make([]Rule, 0, len(keys))
	for _, k := range keys {
		out = append(out, Rule{k, "*", m[k]})
	}
	return out
}
