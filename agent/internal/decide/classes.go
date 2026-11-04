package decide

import (
	"fmt"

	"galopin/internal/permrules"
)

// Class is one of the eight permission classes of ADR 0107: what a machine's
// owner limits, in words a person reads. Every request that is not an
// in-project read belongs to at least one class.
type Class string

const (
	ClassEdit    Class = "edit"
	ClassCommand Class = "command"
	ClassWeb     Class = "web"
	ClassOutside Class = "outside"
	ClassSecrets Class = "secrets"
	ClassAgents  Class = "agents"
	ClassTools   Class = "tools"
	ClassLoop    Class = "loop"
)

// Classes is every class, in the order a person reads them.
var Classes = []Class{ClassEdit, ClassCommand, ClassWeb, ClassOutside, ClassSecrets, ClassAgents, ClassTools, ClassLoop}

// Limit is what the machine says about a class: never allowed, always
// asked, or free to run (the session's word then decides). On the wire the
// three are deny, ask and allow; for the loop class the wire word for Stop is
// "stop" (see Wire).
type Limit int

const (
	// Never refuses the action (wire "deny").
	Never Limit = iota
	// AskLimit raises a card every time (wire "ask"), whatever the session's word.
	AskLimit
	// Run leaves the decision to the session's word (wire "allow"): uncapped.
	Run
	// Stop is the loop class's refusal: end the turn and notify, never run
	// (wire "stop"). It is stricter than a card.
	Stop
)

// Word is the limit as a person writes it on the command line and in
// policy.json.
func (l Limit) Word() string {
	switch l {
	case Never:
		return "never"
	case AskLimit:
		return "ask"
	case Stop:
		return "stop"
	}
	return "run"
}

// Wire is the limit as the hello's `limits` carries it.
func (l Limit) Wire() string {
	switch l {
	case Never:
		return "deny"
	case AskLimit:
		return "ask"
	case Stop:
		return "stop"
	}
	return "allow"
}

// ParseLimit reads a command-line or file word (never|ask|run|stop) or a wire
// word (deny|ask|allow|stop).
func ParseLimit(s string) (Limit, bool) {
	switch s {
	case "never", "deny":
		return Never, true
	case "ask":
		return AskLimit, true
	case "run", "allow":
		return Run, true
	case "stop":
		return Stop, true
	}
	return 0, false
}

// Strictness orders limits by how much they permit: Stop and Never refuse,
// Ask is a card, Run is free. Used to take the more cautious of two.
func (l Limit) permits() int {
	switch l {
	case Never, Stop:
		return 0
	case AskLimit:
		return 1
	}
	return 2
}

// Stricter is the less permissive of two limits of the same class.
func Stricter(a, b Limit) Limit {
	if a.permits() <= b.permits() {
		return a
	}
	return b
}

// DefaultLimit is the class's limit on a machine that says nothing: today's
// behaviour for anyone not on Auto (ADR 0107 §1).
func DefaultLimit(c Class) Limit {
	switch c {
	case ClassCommand, ClassOutside, ClassSecrets, ClassLoop:
		return AskLimit
	}
	return Run
}

// Allows reports whether l is a value the class accepts: secrets never runs,
// and loop is ask or stop only.
func (c Class) Allows(l Limit) bool {
	switch c {
	case ClassSecrets:
		return l == Never || l == AskLimit
	case ClassLoop:
		return l == AskLimit || l == Stop
	}
	return l == Never || l == AskLimit || l == Run
}

// AllowedWords says which words the class accepts, for an error message.
func (c Class) AllowedWords() string {
	switch c {
	case ClassSecrets:
		return "never or ask"
	case ClassLoop:
		return "ask or stop"
	}
	return "never, ask or run"
}

// ParseClass reads a class name.
func ParseClass(s string) (Class, error) {
	for _, c := range Classes {
		if string(c) == s {
			return c, nil
		}
	}
	return "", fmt.Errorf("%q is not a permission class (edit, command, web, outside, secrets, agents, tools, loop)", s)
}

// Meaning is one plain line about a class, for `galopin policy show`.
func (c Class) Meaning() string {
	switch c {
	case ClassEdit:
		return "editing files inside the project"
	case ClassCommand:
		return "running shell commands"
	case ClassWeb:
		return "fetching and searching the web"
	case ClassOutside:
		return "reading or writing outside the project and the safe directories"
	case ClassSecrets:
		return ".env files and credential stores"
	case ClassAgents:
		return "starting and talking to other agent sessions, and scheduling"
	case ClassTools:
		return "connector (MCP) and other tools galopin does not know"
	case ClassLoop:
		return "an agent repeating the same call"
	}
	return ""
}

// ClassKeys are the permission keys a class covers, for the opencode rule
// layer (the ceiling): classes decided only by what a request touches
// (secrets) or by "every other key" (tools) name none.
func ClassKeys(c Class) []string {
	switch c {
	case ClassEdit:
		return []string{"edit"}
	case ClassCommand:
		return []string{"bash"}
	case ClassWeb:
		return []string{"webfetch", "websearch", "codesearch"}
	case ClassOutside:
		return []string{"external_directory"}
	case ClassAgents:
		return []string{"task", "session_list", "session_read", "session_send", "session_spawn", "schedule"}
	case ClassLoop:
		return []string{"doom_loop"}
	}
	return nil
}

// KeyClass is the class a permission key belonged to as a single ceiling or
// rule key (migration, and the --permission-max alias). A key with no class
// ("read", which no class covers on its own) is not ok; any other key is an
// MCP or unknown tool.
func KeyClass(key string) (Class, bool) {
	for _, c := range Classes {
		for _, k := range ClassKeys(c) {
			if k == key {
				return c, true
			}
		}
	}
	switch key {
	case "read", "glob", "grep", "list", "lsp", "skill", "todowrite", "todoread", "question", "plan_enter", "plan_exit":
		return "", false
	}
	return ClassTools, true
}

// Action is the limit as an opencode action for the ceiling (Run is allow).
func (l Limit) Action() permrules.Action {
	switch l {
	case Never:
		return permrules.Deny
	case AskLimit, Stop:
		return permrules.Ask
	}
	return permrules.Allow
}

// LimitsFromWords reads limits kept as words; an unknown class or a word the
// class does not allow is left to its default.
func LimitsFromWords(m map[string]string) map[Class]Limit {
	out := map[Class]Limit{}
	for k, w := range m {
		c, err := ParseClass(k)
		if err != nil {
			continue
		}
		if l, ok := ParseLimit(w); ok && c.Allows(l) {
			out[c] = l
		}
	}
	return out
}

// LimitsFromCeiling derives limits from a per-key ceiling alone: each class
// takes the most cautious cap among its keys (tests that build layers by hand).
func LimitsFromCeiling(c permrules.Ceiling) map[Class]Limit {
	out := map[Class]Limit{}
	for _, cl := range Classes {
		lim := DefaultLimit(cl)
		for _, k := range ClassKeys(cl) {
			if a := c.Of(k); a != permrules.Allow {
				lim = Stricter(lim, map[bool]Limit{true: Never, false: AskLimit}[a == permrules.Deny])
			}
		}
		out[cl] = lim
	}
	return out
}
