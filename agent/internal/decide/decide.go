// Package decide is galopin's one permission decision (ADR 0097): every
// permission request an agent raises, from any backend, is answered here with
// reject, once or card. It performs no I/O and knows nothing of opencode's rule
// algebra; adapters normalise their agent's request into a Request and send the
// Result back as the agent's own reply. galopin never answers "always".
package decide

import (
	"path/filepath"
	"strings"

	"galopin/internal/permrules"
)

// Verdict is what to do with one request, ordered by how much it permits.
type Verdict int

const (
	// Reject refuses the request (galopin answers the agent, no card).
	Reject Verdict = iota
	// Card shows the request to a person.
	Card
	// Once answers "once" at once.
	Once
)

func (v Verdict) String() string {
	switch v {
	case Reject:
		return "reject"
	case Card:
		return "card"
	default:
		return "once"
	}
}

// stricter is the less permissive of two verdicts.
func stricter(a, b Verdict) Verdict {
	if a < b {
		return a
	}
	return b
}

// Category is the kind of call a permission key stands for.
type Category string

const (
	Read         Category = "read"
	Edit         Category = "edit"
	Bash         Category = "bash"
	Web          Category = "web"
	Outside      Category = "outside-workspace"
	Spawn        Category = "spawn"
	Internal     Category = "internal"
	Brake        Category = "brake"
	MCP          Category = "mcp"
	Coordination Category = "coordination"
)

// Request is one permission request, normalised. Key is the agent's own
// permission name (opencode's: read, edit, bash, external_directory, ...).
type Request struct {
	Key      string
	Patterns []string
	// Workspace is the root directory of the session's workspace.
	Workspace string
}

// State is the ROOT session's state: a subagent is decided by its root's.
type State struct {
	Mode         permrules.Action
	Exceptions   []permrules.Exception
	Coordination []string
}

// Policy is the machine's, never a session's.
type Policy struct {
	Ceiling permrules.Ceiling
	// Own is the machine's own rules (policy.json permission.rules).
	Own []permrules.Rule
	// SafeDirs are the safe external directories: their contents never ask.
	SafeDirs []string
	// PlanDirs are directories the plan agent writes its plans into.
	PlanDirs []string
}

// Result is a verdict with the step that produced it and a refusal text.
type Result struct {
	Verdict  Verdict
	Step     string
	Category Category
	Reason   string
}

// Refusal texts, which the agent shows its model.
const (
	PlanReason = "This session is set to Plan: running commands, editing files, fetching from the web and other changes are switched off. Reading and searching the project still work. Say what you would run or change and ask the person to switch the session to Ask or Allow."
)

func ceilingReason(key string) string {
	return "This machine's policy does not allow " + key + "."
}

// Classify maps a request to its category. sensitive is set for a read that
// opencode keeps behind a card on its own (*.env files).
func Classify(p Policy, r Request) (cat Category, sensitive bool) {
	switch r.Key {
	case "read":
		for _, pat := range r.Patterns {
			if strings.HasPrefix(pat, "mcp:") {
				return MCP, false
			}
		}
		for _, pat := range r.Patterns {
			if isSensitive(pat) {
				sensitive = true
			}
			if filepath.IsAbs(pat) && !p.within(r.Workspace, pat) {
				return Outside, sensitive
			}
		}
		return Read, sensitive
	case "glob", "grep", "list", "lsp", "skill":
		return Read, false
	case "edit":
		for _, pat := range r.Patterns {
			if filepath.IsAbs(pat) && !p.within(r.Workspace, pat) {
				return Outside, false
			}
		}
		return Edit, false
	case "bash":
		return Bash, false
	case "webfetch", "websearch", "codesearch":
		return Web, false
	case "external_directory":
		return Outside, false
	case "task":
		return Spawn, false
	case "todowrite", "todoread", "question", "plan_enter", "plan_exit":
		return Internal, false
	case "doom_loop":
		return Brake, false
	case "session_list", "session_read", "session_send", "session_spawn", "schedule":
		return Coordination, false
	}
	return MCP, false
}

// Known reports whether key is a permission name the function classifies on
// purpose, as opposed to the cautious default every other name gets (MCP: an
// effectful tool). The live canary fails when opencode adds a name that is not
// known here, so each new name is decided by a person.
func Known(key string) bool {
	switch key {
	case "read", "glob", "grep", "list", "lsp", "skill", "edit", "bash", "webfetch", "websearch",
		"codesearch", "external_directory", "task", "todowrite", "todoread", "question", "plan_enter",
		"plan_exit", "doom_loop", "session_list", "session_read", "session_send", "session_spawn", "schedule":
		return true
	}
	return false
}

func isSensitive(path string) bool {
	base := filepath.Base(path)
	if strings.HasSuffix(base, ".env.example") {
		return false
	}
	return strings.HasSuffix(base, ".env") || strings.Contains(base, ".env.")
}

// within reports whether path is inside the workspace or a safe directory.
func (p Policy) within(workspace, path string) bool {
	if workspace != "" && under(workspace, path) {
		return true
	}
	for _, d := range p.SafeDirs {
		if under(d, path) {
			return true
		}
	}
	return false
}

func under(dir, path string) bool {
	dir = strings.TrimSuffix(filepath.Clean(dir), "/")
	path = filepath.Clean(strings.TrimSuffix(path, "/*"))
	return path == dir || strings.HasPrefix(path, dir+"/")
}

func (p Policy) planPath(workspace, pat string) bool {
	if permrules.Match(pat, ".opencode/plans/*.md") {
		return true
	}
	if workspace != "" && filepath.IsAbs(pat) && permrules.Match(pat, filepath.Join(workspace, ".opencode", "plans", "*.md")) {
		return true
	}
	for _, d := range p.PlanDirs {
		if filepath.IsAbs(pat) && under(d, pat) {
			return true
		}
	}
	return false
}

// ownRule is the machine's own rule for key: the last one naming it exactly.
func (p Policy) ownRule(key string) (permrules.Action, bool) {
	for i := len(p.Own) - 1; i >= 0; i-- {
		if p.Own[i].Permission == key && p.Own[i].Pattern == "*" {
			return p.Own[i].Action, true
		}
	}
	return "", false
}

// cap is the machine's own ceiling for a key as a verdict ceiling: the
// ceiling and the machine's own deny or ask rules, never exceptions.
func (p Policy) cap(key string) (Verdict, string) {
	c := p.Ceiling.Of(key)
	if own, ok := p.ownRule(key); ok {
		c = permrules.Min(c, own)
	}
	switch c {
	case permrules.Deny:
		return Reject, ceilingReason(key)
	case permrules.Ask:
		return Card, ""
	}
	return Once, ""
}

func excepted(exs []permrules.Exception, r Request) bool {
	pats := r.Patterns
	if len(pats) == 0 {
		pats = []string{"*"}
	}
	for _, e := range exs {
		if e.Permission != r.Key {
			continue
		}
		covered := true
		for _, pat := range pats {
			ok := false
			for _, ep := range e.Patterns {
				if ep == "*" || permrules.Match(pat, ep) {
					ok = true
					break
				}
			}
			if !ok {
				covered = false
				break
			}
		}
		if covered {
			return true
		}
	}
	return false
}

// Decide answers one request from a session whose ROOT is in state s. The
// machine's ceiling (and its own deny/ask rules) is a cap no step can lift:
// the result is the stricter of the cap and the mode's answer.
func Decide(p Policy, s State, r Request) Result {
	cat, sensitive := Classify(p, r)
	cap, creason := p.cap(r.Key)
	if cat == Outside && r.Key != "external_directory" {
		// An outside read or edit is the external_directory ask's business too.
		if c2, why := p.cap("external_directory"); c2 < cap {
			cap, creason = c2, why
		}
	}
	res := modeAnswer(p, s, r, cat, sensitive)
	if cap < res.Verdict {
		res.Verdict = cap
		if cap == Reject {
			res.Step, res.Reason = "ceiling", creason
		} else {
			res.Step, res.Reason = "ceiling", ""
		}
	}
	res.Category = cat
	return res
}

func modeAnswer(p Policy, s State, r Request, cat Category, sensitive bool) Result {
	mode := s.Mode
	if !mode.Valid() {
		mode = permrules.Ask
	}
	once := func(step string) Result { return Result{Verdict: Once, Step: step} }
	card := func(step string) Result { return Result{Verdict: Card, Step: step} }
	reject := func(step string) Result { return Result{Verdict: Reject, Step: step, Reason: PlanReason} }

	// Never an effect on the machine: no mode refuses or asks for these.
	if cat == Internal || cat == Spawn {
		return once("internal")
	}
	if mode == permrules.Deny { // Plan
		switch {
		case cat == Read && !sensitive:
			return once("plan-read")
		case cat == Edit && allMatch(r.Patterns, func(pt string) bool { return p.planPath(r.Workspace, pt) }):
			return once("plan-file")
		case cat == Outside && allMatch(r.Patterns, func(pt string) bool { return p.safeOrPlan(pt) }):
			return once("plan-safe-dir")
		}
		return reject("plan")
	}
	if cat == Outside && allMatch(r.Patterns, func(pt string) bool { return p.safeDirGlob(pt) }) {
		return once("safe-dir")
	}
	if excepted(s.Exceptions, r) {
		return once("exception")
	}
	if own, ok := p.ownRule(r.Key); ok && own == permrules.Allow {
		return once("machine-rule")
	}
	// Asks that protect a person survive Allow.
	if sensitive || cat == Brake || cat == Outside {
		return card("protected")
	}
	if mode == permrules.Allow {
		return once("allow")
	}
	if cat == Read {
		return once("ask-read")
	}
	return card("ask")
}

func allMatch(pats []string, f func(string) bool) bool {
	if len(pats) == 0 {
		return false
	}
	for _, p := range pats {
		if !f(p) {
			return false
		}
	}
	return true
}

func (p Policy) safeDirGlob(pat string) bool {
	for _, d := range p.SafeDirs {
		if under(d, pat) {
			return true
		}
	}
	return false
}

func (p Policy) safeOrPlan(pat string) bool {
	if p.safeDirGlob(pat) {
		return true
	}
	for _, d := range p.PlanDirs {
		if under(d, pat) {
			return true
		}
	}
	return false
}

// DelegateHook reports whether caller and target are a spawner and the session
// it spawned (in either direction). The delegation agent implements it from the
// persisted spawn marks; nil means false.
type DelegateHook func(caller, target string) bool

// CoordinationTool decides one call of galopin's own coordination tools (and
// `schedule`) before any card is raised: allow means no card, ask a card,
// deny a refusal the model reads. delegate says the call is between a spawner
// and the session it spawned.
func CoordinationTool(p Policy, s State, key string, delegate bool) (permrules.Action, string) {
	ceiling := p.Ceiling.Of(key)
	own, hasOwn := p.ownRule(key)
	if ceiling == permrules.Deny || (hasOwn && own == permrules.Deny) {
		return permrules.Deny, "this machine's rules do not allow " + key
	}
	capAsk := ceiling == permrules.Ask || (hasOwn && own == permrules.Ask)
	answer := permrules.Ask
	switch {
	case delegate:
		answer = permrules.Allow
	case s.Mode == permrules.Deny:
		return permrules.Deny, PlanReason
	case hasOwn && own == permrules.Allow:
		answer = permrules.Allow
	case contains(s.Coordination, key):
		answer = permrules.Allow
	case key == "session_list":
		answer = permrules.Allow
	case s.Mode == permrules.Allow && key != "session_read":
		answer = permrules.Allow
	}
	if capAsk {
		answer = permrules.Ask
	}
	return answer, ""
}

func contains(l []string, k string) bool {
	for _, x := range l {
		if x == k {
			return true
		}
	}
	return false
}
