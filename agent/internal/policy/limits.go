package policy

import (
	"fmt"
	"sort"
	"strings"

	"galopin/internal/decide"
	"galopin/internal/permrules"
)

// Limits are kept as words: "never", "ask", "run" (and "stop" for loop).

// DefaultLimits is the full default table as words.
func DefaultLimits() map[string]string {
	out := map[string]string{}
	for _, c := range decide.Classes {
		out[string(c)] = decide.DefaultLimit(c).Word()
	}
	return out
}

// DecideLimits is the limits in force as the decision function takes them.
func (p Permission) DecideLimits() map[decide.Class]decide.Limit { return p.EffectiveLimits() }

// SetLimit validates and sets one class's limit (the enroll flag's work).
func (p *Permission) SetLimit(class, word string) error {
	c, err := decide.ParseClass(class)
	if err != nil {
		return err
	}
	l, ok := decide.ParseLimit(word)
	if !ok || word == "deny" || word == "allow" || !c.Allows(l) {
		return fmt.Errorf("%s=%s: the %s class takes %s", class, word, c, c.AllowedWords())
	}
	p.materialize()
	p.Limits[string(c)] = l.Word()
	return nil
}

// materialize writes every class's effective limit into Limits.
func (p *Permission) materialize() {
	eff := p.EffectiveLimits()
	p.Limits = map[string]string{}
	for c, l := range eff {
		p.Limits[string(c)] = l.Word()
	}
}

// Normalize brings a permission block to the class form: a block with Limits is
// validated and kept (any leftover Max is dropped); one without is migrated from
// the per-key ceiling and rules it carries (ADR 0107 §1). It returns the
// notices the migration owes the owner, which are also kept in p.Notices.
func (p *Permission) Normalize() []string {
	if p.Limits != nil {
		p.Max = nil
		return p.Notices
	}
	return p.migrate()
}

// migrate folds the legacy per-key ceiling (Max) and own rules (Rules) into
// classes: each class takes the most cautious value among its keys (a key
// absent from Max is uncapped), tighten-only, and what the session-level
// "protected" step asked for (outside the project, .env, a repeating agent)
// becomes outside, secrets and loop at ask. An own allow rule is kept only when
// every key of its class has one; otherwise it is dropped and said so.
func (p *Permission) migrate() []string {
	var notices []string
	capOf := func(key string) permrules.Action {
		a := permrules.Allow
		if v, ok := p.Max[key]; ok && permrules.Action(v).Valid() {
			a = permrules.Min(a, permrules.Action(v))
		}
		if v, ok := p.Rules[key]; ok && permrules.Action(v).Valid() && permrules.Action(v) != permrules.Allow {
			a = permrules.Min(a, permrules.Action(v))
		}
		return a
	}
	ownAllow := func(key string) bool { return permrules.Action(p.Rules[key]) == permrules.Allow }
	limits := map[string]string{}
	kept := map[string]string{}
	for _, c := range decide.Classes {
		keys := decide.ClassKeys(c)
		lim := decide.Run
		for _, k := range keys {
			lim = decide.Stricter(lim, limitOf(capOf(k)))
		}
		switch c {
		case decide.ClassTools:
			for _, k := range sortedKeys(p.Max, p.Rules) {
				if kc, ok := decide.KeyClass(k); ok && kc == decide.ClassTools {
					lim = decide.Stricter(lim, limitOf(capOf(k)))
					if ownAllow(k) {
						notices = append(notices, fmt.Sprintf("your own allow rule for %s was dropped: a tools limit covers every connector and unknown tool, so one tool's allow does not carry over", k))
					}
				}
			}
		case decide.ClassOutside:
			// The protected step always asked; only an own allow on the key lifted it.
			base := decide.AskLimit
			if ownAllow("external_directory") && capOf("external_directory") == permrules.Allow {
				base = decide.Run
			}
			lim = decide.Stricter(lim, base)
		case decide.ClassSecrets:
			lim = decide.Stricter(lim, decide.AskLimit)
			if ownAllow("read") {
				notices = append(notices, "your own allow rule for read was dropped: the secrets class never runs (.env files and credential stores always ask)")
			}
		case decide.ClassLoop:
			lim = decide.AskLimit
			if capOf("doom_loop") == permrules.Deny {
				lim = decide.Stop
			}
			if ownAllow("doom_loop") {
				notices = append(notices, "your own allow rule for doom_loop was dropped: the loop class never runs (a repeating agent asks, or stops)")
			}
		}
		limits[string(c)] = lim.Word()
		// Own allow rules: carried only when every key of the class has one.
		if len(keys) > 0 && c != decide.ClassOutside && c != decide.ClassLoop {
			n := 0
			for _, k := range keys {
				if ownAllow(k) {
					n++
				}
			}
			switch {
			case n == len(keys):
				for _, k := range keys {
					kept[k] = string(permrules.Allow)
				}
			case n > 0:
				notices = append(notices, fmt.Sprintf("your own allow rules for the %s class were dropped: they covered %d of its %d keys (%s), and a class takes one value for all of them", c, n, len(keys), strings.Join(keys, ", ")))
			}
		}
	}
	if v, ok := p.Max["read"]; ok && permrules.Action(v) != permrules.Allow {
		notices = append(notices, fmt.Sprintf("a ceiling of read=%s has no class and was dropped (in-project reads always run; .env files and credentials are the secrets class)", v))
	}
	for _, k := range []string{"glob", "grep", "list", "lsp", "skill"} {
		if v, ok := p.Max[k]; ok && permrules.Action(v) != permrules.Allow {
			notices = append(notices, fmt.Sprintf("a ceiling of %s=%s has no class and was dropped", k, v))
		}
	}
	p.Limits = limits
	p.Max = nil
	p.Rules = nil
	if len(kept) > 0 {
		p.Rules = kept
	}
	p.Notices = notices
	return notices
}

func limitOf(a permrules.Action) decide.Limit {
	switch a {
	case permrules.Deny:
		return decide.Never
	case permrules.Ask:
		return decide.AskLimit
	}
	return decide.Run
}

func sortedKeys(ms ...map[string]string) []string {
	seen := map[string]bool{}
	for _, m := range ms {
		for k := range m {
			seen[k] = true
		}
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Table is the class table in plain words, one line per class: name, limit,
// what it means. `galopin policy show` prints it.
func (p Permission) Table() []string {
	eff := p.EffectiveLimits()
	var out []string
	for _, c := range decide.Classes {
		l := eff[c]
		out = append(out, fmt.Sprintf("  %-8s %-6s %s — %s", c, l.Word(), c.Meaning(), limitMeaning(c, l)))
	}
	return out
}

func limitMeaning(c decide.Class, l decide.Limit) string {
	switch l {
	case decide.Never:
		return "never allowed"
	case decide.AskLimit:
		return "always asked, whatever the session's word"
	case decide.Stop:
		return "the turn ends and you are told"
	}
	if c == decide.ClassAgents {
		return "free between sessions of the same or a more cautious word, otherwise the session's word decides"
	}
	return "runs as the session's word decides"
}

// TightenLimit lowers class to l, refusing a value that does not tighten (the
// error names the way up: enroll). It reports whether anything changed.
func (p *Permission) TightenLimit(c decide.Class, l decide.Limit) (bool, error) {
	cur := p.EffectiveLimits()[c]
	if cur == l {
		return false, nil
	}
	if decide.Stricter(cur, l) != l {
		return false, fmt.Errorf("--limit %s=%s does not tighten the current %s: re-run enroll with --limit %s=%s to loosen it", c, l.Word(), cur.Word(), c, l.Word())
	}
	p.materialize()
	p.Limits[string(c)] = l.Word()
	return true, nil
}

// SetLimitTo sets class to l with no direction check (enroll's work).
func (p *Permission) SetLimitTo(c decide.Class, l decide.Limit) {
	p.materialize()
	p.Limits[string(c)] = l.Word()
}
