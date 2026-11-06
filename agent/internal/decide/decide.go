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
	// Limits is the machine's limit per class (ADR 0107); a class absent is its
	// default (DefaultLimit).
	Limits map[Class]Limit
	// Own is the machine's own allow rules (policy.json permission.rules): what
	// is left of them after migration, honoured for galopin's coordination tools.
	Own []permrules.Rule
	// SafeDirs are the safe external directories: their contents never ask.
	SafeDirs []string
	// PlanDirs are directories the plan agent writes its plans into.
	PlanDirs []string
	// Protected is galopin's own paths (a fixed refusal) and the credential
	// stores (the secrets class). The zero value protects nothing.
	Protected Protected
}

// Limit is the machine's limit for one class.
func (p Policy) Limit(c Class) Limit {
	if l, ok := p.Limits[c]; ok && c.Allows(l) {
		return l
	}
	return DefaultLimit(c)
}

// Result is a verdict with the step that produced it and a refusal text.
type Result struct {
	Verdict  Verdict
	Step     string
	Category Category
	// Class is the permission class the request belongs to ("" for an
	// in-project read and the like): the label a card carries.
	Class Class
	// Stop is set on a loop refusal under the "stop" limit: the caller ends
	// the turn and notifies, in addition to refusing the call.
	Stop   bool
	Reason string
}

// Refusal texts, which the agent shows its model.
const (
	PlanReason = "This session is set to Plan: running commands, editing files, fetching from the web and other changes are switched off. Reading and searching the project still work. Say what you would run or change and ask the person to switch the session to Ask or Allow."
)

// FloorReason is the refusal for galopin's own state and configuration.
const FloorReason = "This is galopin's own configuration or state, which no session may touch."

// LoopStopReason is the refusal under the loop class's "stop" limit.
const LoopStopReason = "You are repeating the same call. This machine stops a repeating agent: the turn is ended. Report what is blocking you."

func limitReason(c Class) string {
	return "This machine's policy does not allow " + c.Meaning() + " (limit: never)."
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

func excepted(exs []permrules.Exception, r Request, overAsk bool) bool {
	pats := r.Patterns
	if len(pats) == 0 {
		pats = []string{"*"}
	}
	for _, e := range exs {
		if e.Permission != r.Key || (overAsk && !e.OverAsk) {
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

// priority orders the classes a request can belong to when more than one
// applies: the label a card carries is the first of these it is in, so a
// `.env` read outside the project is a secrets card, not an outside one.
var priority = []Class{ClassSecrets, ClassLoop, ClassOutside, ClassCommand, ClassAgents, ClassTools, ClassWeb, ClassEdit}

// classesOf is every class the request belongs to. An in-project read, galopin's
// own bookkeeping tools and a safe-directory access belong to none.
func (p Policy) classesOf(r Request, cat Category, sensitive bool) []Class {
	var cs []Class
	switch cat {
	case Edit:
		cs = append(cs, ClassEdit)
	case Bash:
		cs = append(cs, ClassCommand)
	case Web:
		cs = append(cs, ClassWeb)
	case Outside:
		if !(r.Key == "external_directory" && allMatch(r.Patterns, p.safeDirGlob)) {
			cs = append(cs, ClassOutside)
		}
	case Spawn, Coordination:
		cs = append(cs, ClassAgents)
	case MCP:
		cs = append(cs, ClassTools)
	case Brake:
		cs = append(cs, ClassLoop)
	}
	if _, hit := p.Protected.SecretHit(r); sensitive || hit {
		cs = append(cs, ClassSecrets)
	}
	return cs
}

// ClassOf is the class a request is labelled with ("" for none): what a card
// carries as `class` (PROTOCOL.md §7).
func ClassOf(p Policy, r Request) Class {
	cat, sensitive := Classify(p, r)
	return primary(p.classesOf(r, cat, sensitive))
}

func primary(cs []Class) Class {
	for _, c := range priority {
		for _, x := range cs {
			if x == c {
				return c
			}
		}
	}
	return ""
}

// Decide answers one request from a session whose ROOT is in state s. The
// machine's limits are a cap no step can lift: galopin's own state is refused
// outright; a class limited to never refuses; a class limited to ask is always
// a card; a class that runs is answered by the session's word.
func Decide(p Policy, s State, r Request) Result {
	cat, sensitive := Classify(p, r)
	classes := p.classesOf(r, cat, sensitive)
	class := primary(classes)
	if _, hit := p.Protected.OwnHit(r); hit && cat != Internal {
		return Result{Verdict: Reject, Step: "floor", Category: cat, Class: class, Reason: FloorReason}
	}
	lim, limClass := Run, class
	for _, c := range classes {
		if l := p.Limit(c); Stricter(l, lim) != lim {
			lim, limClass = Stricter(l, lim), c
		}
	}
	askLimited := lim == AskLimit
	for _, c := range classes {
		if c == ClassLoop {
			askLimited = false // an "always" on a loop ask is meaningless
		}
	}
	res := modeAnswer(p, s, r, cat, sensitive, lim == Run, askLimited)
	// A write into a repository's .git (config, hooks, info) is never answered
	// by the session's word or an exception: it is a card, so a person sees it.
	if cat == Edit && res.Verdict == Once && res.Step != "plan-file" {
		if _, hit := p.Protected.CIHit(r); hit {
			res.Verdict, res.Step = Card, "git-internals"
		}
	}
	res.Category, res.Class = cat, class
	switch {
	case lim == Stop && res.Verdict != Reject:
		res.Verdict, res.Step, res.Reason, res.Stop = Reject, "limit", LoopStopReason, true
	case lim == Stop:
		res.Stop = true
	case lim == Never && res.Verdict != Reject:
		res.Verdict, res.Step, res.Reason = Reject, "limit", limitReason(limClass)
	case lim == AskLimit && res.Verdict == Once && res.Step != "exception-ask":
		res.Verdict, res.Step = Card, "limit"
	}
	return res
}

func modeAnswer(p Policy, s State, r Request, cat Category, sensitive, free, askLimited bool) Result {
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
	// An "always allow" only stands where the machine lets a request run: a
	// class limited to ask is a card every time.
	if free && excepted(s.Exceptions, r, false) {
		return once("exception")
	}
	// ... except the "always allow" a human chose on such a card: that one
	// stands (Exception.OverAsk), and is the only one that does.
	if askLimited && excepted(s.Exceptions, r, true) {
		return once("exception-ask")
	}
	if mode == permrules.Allow {
		return once("allow")
	}
	if cat == Read && !sensitive {
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
// and the session it spawned. See CoordinationFor for the target's word.
func CoordinationTool(p Policy, s State, key string, delegate bool) (permrules.Action, string) {
	return CoordinationFor(p, s, key, delegate, "")
}

// wordRank orders the session words by how cautious they are: Plan is the
// most cautious.
func wordRank(a permrules.Action) int {
	switch a {
	case permrules.Deny:
		return 0
	case permrules.Allow:
		return 2
	}
	return 1
}

// askCallersAreFree says whether the agents rank rule also frees a caller on
// Ask. ADR 0107 §1 words the rule for every caller, but its table also says the
// defaults reproduce today's behaviour, where an Ask session's spawn, send and
// read raise a card; the two disagree for Ask callers, and loosening cards for
// them is the unsafe way to be wrong. Until the owner rules, the rule frees
// callers on Allow only (an Ask caller keeps its cards, as today).
var askCallersAreFree = false

// CoordinationFor is CoordinationTool with the word of the session the call
// reaches (ADR 0107 §1, the agents class): target is that session's root's
// word, or the caller's own for a spawn (a child is never looser than its
// spawner) and a schedule; "" when there is no target. With the agents class
// at run, a call is free when the target's word is the same or more cautious
// than the caller's; otherwise the caller's session word applies.
func CoordinationFor(p Policy, s State, key string, delegate bool, target permrules.Action) (permrules.Action, string) {
	lim := p.Limit(ClassAgents)
	own, hasOwn := p.ownRule(key)
	if lim == Never || (hasOwn && own == permrules.Deny) {
		return permrules.Deny, "this machine's rules do not allow " + key
	}
	capAsk := lim == AskLimit || (hasOwn && own == permrules.Ask)
	// Plan changes nothing: only reading one's own delegate gets through it. A
	// send, a spawn or a schedule is refused delegate or not, because a delegate
	// spawned on Allow would otherwise carry the change for the Plan caller.
	if s.Mode == permrules.Deny && !(delegate && key == "session_read") {
		return permrules.Deny, PlanReason
	}
	answer := permrules.Ask
	switch {
	case delegate:
		answer = permrules.Allow
	case hasOwn && own == permrules.Allow:
		answer = permrules.Allow
	case contains(s.Coordination, key):
		answer = permrules.Allow
	case key == "session_list":
		answer = permrules.Allow
	case target.Valid() && wordRank(target) <= wordRank(s.Mode) && (s.Mode == permrules.Allow || askCallersAreFree):
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

// AskAlwaysOK reports whether a human's "always allow" on this request may be
// stored although the machine limits its class to ask: the strictest limit over
// its classes is ask (not never, not stop, not run) and none of them is the
// loop class. galopin's own paths never get here (a fixed refusal).
func AskAlwaysOK(p Policy, r Request) bool {
	cat, sensitive := Classify(p, r)
	if _, hit := p.Protected.OwnHit(r); hit && cat != Internal {
		return false
	}
	lim := Run
	for _, c := range p.classesOf(r, cat, sensitive) {
		if c == ClassLoop {
			return false
		}
		lim = Stricter(p.Limit(c), lim)
	}
	return lim == AskLimit
}

// ConnectorCall decides one call of a connector's tool through galopin's
// connector tools (ADR 0108, item 3), which are the `tools` class like any other
// MCP tool: allow means no card, ask a card, deny a refusal the model reads. The
// machine's limit for the class caps the session's word, as for every class:
// never refuses, ask is always a card, and run leaves it to the word (Plan
// refuses, Ask raises a card, Allow runs). Reading what is on offer
// (list true) changes nothing, so only a never limit and a Plan-less nothing
// stand in its way: it is refused under never and otherwise free.
func ConnectorCall(p Policy, s State, list bool) (permrules.Action, string) {
	lim := p.Limit(ClassTools)
	if lim == Never {
		return permrules.Deny, limitReason(ClassTools)
	}
	if list {
		return permrules.Allow, ""
	}
	if s.Mode == permrules.Deny {
		return permrules.Deny, PlanReason
	}
	if lim == AskLimit || s.Mode != permrules.Allow {
		return permrules.Ask, ""
	}
	return permrules.Allow, ""
}
