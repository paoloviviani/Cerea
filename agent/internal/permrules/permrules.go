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
	Own []Rule
	// Ceiling is the machine's cap.
	Ceiling Ceiling
	// SafeDirs are the machine's safe external directories (policy.json's
	// permission.safeDirs): absolute paths whose contents never ask, under
	// every selector word. They are not the word's to move and not part of
	// Own — see SafeDirRules for where they sit and what still caps them.
	SafeDirs []string
}

// The permission selector (PROTOCOL.md §6 "Permissions"): a session carries ONE
// blanket word, deny, ask or allow, and a short list of exceptions a person made
// with "always allow". Both are galopin's own state, composed into the session's
// opencode rules; opencode itself never learns a blanket from a person.

// Blanket is the permission names the blanket does move. Every MCP tool and
// every custom tool follows it too, by name; these are the built-in ones.
var Blanket = []string{"edit", "bash", "webfetch", "websearch", "codesearch", "task"}

// CoordinationKeys are the permission keys session.grantCoordination accepts:
// the four coordination tools and nothing else. A grant is the one way a
// caller can make a galopin tool's rule allow, and only for these.
var CoordinationKeys = []string{"session_list", "session_read", "session_send", "session_spawn"}

// IsCoordinationKey reports whether key may be granted.
func IsCoordinationKey(key string) bool {
	for _, k := range CoordinationKeys {
		if k == key {
			return true
		}
	}
	return false
}

// NormalizeCoordination validates a grant's keys and returns them de-duplicated
// and sorted (so equal grants compose to equal rules). When a key is not a
// coordination key, ok is false and bad is the first such key.
func NormalizeCoordination(keys []string) (out []string, bad string, ok bool) {
	seen := map[string]bool{}
	for _, k := range keys {
		if !IsCoordinationKey(k) {
			return nil, k, false
		}
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out, "", true
}

// Exception is one "always allow" a person gave, kept per root session: a
// permission and the patterns it covers, allowed on top of the blanket.
type Exception struct {
	ID         string   `json:"id"`
	Permission string   `json:"permission"`
	Patterns   []string `json:"patterns"`
	GrantedAt  string   `json:"grantedAt,omitempty"`
}

// Selector is a root session's whole permission choice. The zero value is Ask:
// a session nobody has set, an existing session on upgrade, a new one, a
// spawned one and every session of a machine whose policy predates permissions
// all start there.
type Selector struct {
	Mode       Action      `json:"mode,omitempty"`
	Exceptions []Exception `json:"exceptions,omitempty"`
	// Coordination is the grant session.grantCoordination recorded: coordination
	// tools (CoordinationKeys) whose rule reads `allow` for this session, where
	// the machine's own rules and the ceiling say nothing stricter. It is part of
	// the selector so it persists with it, and a subagent follows its root's.
	Coordination []string `json:"coordination,omitempty"`
}

// Effective is the mode in force: what was set, else ask.
func (s Selector) Effective() Action {
	if s.Mode.Valid() {
		return s.Mode
	}
	return Ask
}

// Find is the exception with this id.
func (s Selector) Find(id string) (Exception, bool) {
	for _, e := range s.Exceptions {
		if e.ID == id {
			return e, true
		}
	}
	return Exception{}, false
}

// With adds an exception, or returns the selector unchanged when one with the
// same permission and patterns is already there (the stored one is kept, so an
// "always" given twice is one entry).
func (s Selector) With(e Exception) (Selector, Exception) {
	for _, have := range s.Exceptions {
		if have.Permission == e.Permission && equalStrings(have.Patterns, e.Patterns) {
			return s, have
		}
	}
	out := s
	out.Exceptions = append(append([]Exception(nil), s.Exceptions...), e)
	return out, e
}

// Without drops the exception with this id.
func (s Selector) Without(id string) (Selector, bool) {
	var kept []Exception
	found := false
	for _, e := range s.Exceptions {
		if e.ID == id {
			found = true
			continue
		}
		kept = append(kept, e)
	}
	out := s
	out.Exceptions = kept
	return out, found
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
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
