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

// The permission selector (PROTOCOL.md §6 "Permissions"): a session carries ONE
// blanket word, deny, ask or allow, and a short list of exceptions a person made
// with "always allow". Both are galopin's own state, composed into the session's
// opencode rules; opencode itself never learns a blanket from a person.

// Untouched is the permission names the blanket never moves: they keep the
// agent's own rules, so reading stays allowed under all three words (its
// `*.env` asks included), the question tool works without a card, and the two
// asks that exist to protect a person — writing outside the project folder and
// the stuck-agent brake — survive Allow. A name here is one of opencode
// 1.18.32's own; the live canary lists the binary's names and fails on a new
// one that is in neither set.
var Untouched = []string{
	"read", "glob", "grep", "list", "lsp", "question", "todowrite", "todoread",
	"plan_enter", "plan_exit", "skill", "external_directory", "doom_loop",
}

// Blanket is the permission names the blanket does move. Every MCP tool and
// every custom tool follows it too, by name; these are the built-in ones.
var Blanket = []string{"edit", "bash", "webfetch", "websearch", "codesearch", "task"}

// IsUntouched reports whether a literal permission name is in the untouched set.
func IsUntouched(key string) bool {
	for _, k := range Untouched {
		if k == key {
			return true
		}
	}
	return false
}

// GalopinTools are galopin's own coordination tools. They have no opencode
// permission of their own: galopin reads the machine's rules for their names
// (Grant), so the blanket must not bury a rule the machine wrote for one. Under
// Ask or Allow the machine's own rules for them are re-appended after the mode
// block; under Deny they are not, because the person said Deny.
var GalopinTools = []string{"session_list", "session_read", "session_spawn", "session_send"}

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

func isGalopinTool(key string) bool {
	for _, k := range GalopinTools {
		if k == key {
			return true
		}
	}
	return false
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

// coordinationRules is one `allow` per granted coordination tool.
func (s Selector) coordinationRules() []Rule {
	var out []Rule
	for _, k := range s.Coordination {
		if IsCoordinationKey(k) {
			out = append(out, Rule{k, "*", Allow})
		}
	}
	return out
}

// exceptionRules is one allow rule per pattern, in the order given.
func (s Selector) exceptionRules() []Rule {
	var out []Rule
	for _, e := range s.Exceptions {
		pats := e.Patterns
		if len(pats) == 0 {
			pats = []string{"*"}
		}
		for _, p := range pats {
			out = append(out, Rule{e.Permission, p, Allow})
		}
	}
	return out
}

// blanketBlock is the mode block for a session whose agent and machine rules
// are base, in evaluation order beneath it.
//
// The blanket is `* : mode`, but opencode takes the LAST match, so a bare
// `* : ask` would also turn the plan agent's `edit: deny` into an ask and a
// read-only subagent's `*: deny` into a question — the same trap the ceiling's
// Tail guards. A deny is the one thing the blanket does not move: every rule
// beneath that is not about an untouched name is restated after it with an
// allow or ask taken to the mode and a deny left as it is, so the last match
// for any input is the agent's own, brought to the mode only where it was
// not a refusal. An untouched name is restated verbatim, after an `ask` base
// for the case nothing beneath matches it (opencode's own default).
func blanketBlock(mode Action, base []Rule) []Rule {
	out := []Rule{{"*", "*", mode}}
	for _, r := range base {
		if !IsWildcard(r.Permission) && IsUntouched(r.Permission) {
			continue
		}
		a := mode
		if r.Action == Deny {
			a = Deny
		}
		restated := Rule{r.Permission, r.Pattern, a}
		if n := len(out); out[n-1] == restated {
			continue
		}
		out = append(out, restated)
	}
	for _, k := range Untouched {
		out = append(out, Rule{k, "*", Ask})
		for _, r := range base {
			if !Match(k, r.Permission) {
				continue
			}
			restated := Rule{k, r.Pattern, r.Action}
			if n := len(out); out[n-1] == restated {
				continue
			}
			out = append(out, restated)
		}
	}
	return out
}

// Compose is the rules a top-level session carries: the machine's own, then the
// selector's — the mode block, and the exceptions on whichever side of it makes
// them mean what they should — and the ceiling's tail over all of it, last.
// agent is the session's agent's effective rules (opencode's GET /agent).
func Compose(l Layers, sel Selector, agent []Rule) []Rule {
	cerea, tail := ComposeParts(l, sel, agent)
	return append(cerea, tail...)
}

// ComposeParts is Compose taken apart: the machine's rules and the selector's
// (own first, so len(l.Own) of them are the machine's), then the ceiling's tail.
//
//   - Ask and Allow: the exceptions sit after the mode block, so they win over
//     it (under Allow they are redundant and harmless);
//   - Deny: the exceptions sit BEFORE it, so Deny wins. They are kept all the
//     same, and come back into force when the mode does.
func ComposeParts(l Layers, sel Selector, agent []Rule) (cerea, tail []Rule) {
	base := append(append([]Rule(nil), agent...), l.Own...)
	mode := sel.Effective()
	cerea = append([]Rule(nil), l.Own...)
	if mode == Deny {
		cerea = append(cerea, sel.exceptionRules()...)
	}
	cerea = append(cerea, blanketBlock(mode, base)...)
	if mode != Deny {
		// A grant sits BEFORE the machine's own rules for these tools, so an
		// owner's explicit ask or deny for one still beats it, and the ceiling's
		// tail (below) caps it like every other rule. Under Deny it is kept but
		// not applied: Deny wins, as it does over an exception.
		cerea = append(cerea, sel.coordinationRules()...)
		for _, r := range l.Own {
			if isGalopinTool(r.Permission) {
				cerea = append(cerea, r)
			}
		}
		cerea = append(cerea, sel.exceptionRules()...)
	}
	in := append(append([]Rule(nil), agent...), cerea...)
	return cerea, l.Ceiling.Tail(in)
}

// ChildCeiling is the cap a subagent is held to: the machine's ceiling, lowered
// by the machine's own rules that RESTRICT (ask or deny). opencode hands a child
// only its parent's denies, so without this a machine rule of `edit: ask` would
// stop at the parent and a subagent would write freely. The rules travel as
// caps, never as rules of their own: applied through Ceiling.Tail they are
// restated over the child agent's rules, lowered, so they can tighten a child
// and can never soften a deny the child's agent already has. An allow is not
// carried at all: it never reaches a child.
func (l Layers) ChildCeiling() Ceiling {
	own := Ceiling{Max: map[string]Action{}}
	for _, r := range l.Own {
		if r.Action != Allow && r.Pattern == "*" && !IsWildcard(r.Permission) {
			own.Max[r.Permission] = Min(own.Of(r.Permission), r.Action)
		}
	}
	return l.Ceiling.Meet(own)
}

// ChildRules is what a subagent session gets: its ROOT's selector (the mode
// block and the root's exceptions — a subagent has no selector of its own)
// over the child agent's rules, and the child ceiling's tail. Never the
// machine's own allows: only their restrictions, as caps.
func ChildRules(l Layers, root Selector, agent []Rule) []Rule {
	return Compose(Layers{Ceiling: l.ChildCeiling()}, root, agent)
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

// FromConfig reads an opencode `permission` config block into rules: a string
// value is a rule for the key with pattern `*`, an object is one rule per
// pattern. Keys and patterns are sorted so equal blocks read equal.
func FromConfig(block map[string]any) []Rule {
	keys := make([]string, 0, len(block))
	for k := range block {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var out []Rule
	for _, k := range keys {
		switch v := block[k].(type) {
		case string:
			out = append(out, Rule{k, "*", Action(v)})
		case map[string]any:
			pats := make([]string, 0, len(v))
			for pat := range v {
				pats = append(pats, pat)
			}
			sort.Strings(pats)
			for _, pat := range pats {
				if a, ok := v[pat].(string); ok {
					out = append(out, Rule{k, pat, Action(a)})
				}
			}
		}
	}
	return out
}

// FloorRules is the floor for agent as rules: what the OPENCODE_CONFIG_CONTENT
// built from this ceiling adds to that agent's ruleset, top-level block first.
func (c Ceiling) FloorRules(agent string) []Rule { return floorRules(c.Floor(), agent) }

func floorRules(f map[string]any, agent string) []Rule {
	var out []Rule
	if top, ok := f["permission"].(map[string]any); ok {
		out = append(out, FromConfig(top)...)
	}
	if agents, ok := f["agent"].(map[string]any); ok {
		if a, ok := agents[agent].(map[string]any); ok {
			if perm, ok := a["permission"].(map[string]any); ok {
				out = append(out, FromConfig(perm)...)
			}
		}
	}
	return out
}
