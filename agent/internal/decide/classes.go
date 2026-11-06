package decide

import "fmt"

// Class is one of the eight permission classes of ADR 0107: what a request is
// labelled with for routing, review and audit, and what a machine owner may
// refuse locally (--deny). Every request that is not an
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

// Denyable reports whether the class may be refused locally: the loop alert is
// always a card, never a refusal.
func (c Class) Denyable() bool { return c != ClassLoop }

// ParseDeny reads a --deny class name.
func ParseDeny(s string) (Class, error) {
	c, err := ParseClass(s)
	if err != nil {
		return "", err
	}
	if !c.Denyable() {
		return "", fmt.Errorf("the loop class cannot be denied: a repeating agent is always a card")
	}
	return c, nil
}

// AutoWord is one class's word in an Auto session's map: run or ask.
const (
	AutoRun = "run"
	AutoAsk = "ask"
)

// AutoRunSet reads an Auto session's per-class map (PROTOCOL.md §6): only a
// known class whose word is "run" runs; everything else asks (fail closed). The
// secrets and loop classes never run (the floor's cards).
func AutoRunSet(m map[string]string) map[Class]bool {
	out := map[Class]bool{}
	for k, v := range m {
		c, err := ParseClass(k)
		if err != nil || v != AutoRun || c == ClassSecrets || c == ClassLoop {
			continue
		}
		out[c] = true
	}
	return out
}
