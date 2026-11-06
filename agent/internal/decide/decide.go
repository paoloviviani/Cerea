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
	// Auto marks an Auto session (Mode is Ask): the classes in AutoRun run with
	// no card, every other class is a card (ADR 0109 amendment). A nil AutoRun
	// on an Auto session runs nothing.
	Auto    bool
	AutoRun map[Class]bool
}

// Policy is the machine's, never a session's.
type Policy struct {
	// Deny is the classes this machine's owner refuses locally (--deny; ADR
	// 0109): refuse-only, never set over the link.
	Deny map[Class]bool
	// SafeDirs are the safe external directories: their contents never ask.
	SafeDirs []string
	// PlanDirs are directories the plan agent writes its plans into.
	PlanDirs []string
	// Protected is galopin's own paths (a fixed refusal) and the credential
	// stores (the secrets class). The zero value protects nothing.
	Protected Protected
}

// Result is a verdict with the step that produced it and a refusal text.
type Result struct {
	Verdict  Verdict
	Step     string
	Category Category
	// Class is the permission class the request belongs to ("" for an
	// in-project read and the like): the label a card carries.
	Class  Class
	Reason string
}

// Refusal texts, which the agent shows its model.
const (
	PlanReason = "This session is set to Plan: running commands, editing files, fetching from the web and other changes are switched off. Reading and searching the project still work. Say what you would run or change and ask the person to switch the session to Ask or Allow."
)

// FloorReason is the refusal for galopin's own state and configuration.
const FloorReason = "This is galopin's own configuration or state, which no session may touch."

func denyReason(c Class) string {
	return "This machine's owner has refused " + c.Meaning() + " (galopin --deny " + string(c) + ")."
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

func excepted(exs []permrules.Exception, r Request, overAskOnly ...bool) bool {
	overAsk := len(overAskOnly) > 0 && overAskOnly[0]
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

// Decide answers one request from a session whose ROOT is in state s (ADR
// 0109): galopin's own state is refused outright; a class the owner denied
// locally is refused; otherwise the session's word decides (Plan refuses, Ask
// is a card, Allow runs, Auto runs the classes its map says run). The floor
// then lifts a run to a card: credential paths, a write into .git or CI
// config, and a repeating agent.
func Decide(p Policy, s State, r Request) Result {
	cat, sensitive := Classify(p, r)
	classes := p.classesOf(r, cat, sensitive)
	class := primary(classes)
	if _, hit := p.Protected.OwnHit(r); hit && cat != Internal {
		return Result{Verdict: Reject, Step: "floor", Category: cat, Class: class, Reason: FloorReason}
	}
	for _, c := range classes {
		if p.Deny[c] {
			return Result{Verdict: Reject, Step: "deny", Category: cat, Class: class, Reason: denyReason(c)}
		}
	}
	loop, secret := false, false
	for _, c := range classes {
		loop = loop || c == ClassLoop
		secret = secret || c == ClassSecrets
	}
	// A secrets ask only stands on a human's "always" (Exception.OverAsk).
	res := modeAnswer(p, s, r, cat, sensitive, classes, secret && !loop, loop)
	// A write into a repository's .git (config, hooks, info) or CI config is
	// never answered by the session's word or an exception: it is a card.
	if cat == Edit && res.Verdict == Once && res.Step != "plan-file" {
		if _, hit := p.Protected.CIHit(r); hit {
			res.Verdict, res.Step = Card, "git-internals"
		}
	}
	res.Category, res.Class = cat, class
	switch {
	case res.Verdict == Once && loop:
		res.Verdict, res.Step = Card, "loop"
	case res.Verdict == Once && secret && res.Step != "exception-ask":
		res.Verdict, res.Step = Card, "secrets"
	}
	return res
}

func modeAnswer(p Policy, s State, r Request, cat Category, sensitive bool, classes []Class, askOnly, loop bool) Result {
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
	// An "always allow": a credential ask only stands when a human gave it
	// over the ask (OverAsk); a repeating agent never.
	if !loop {
		if !askOnly && excepted(s.Exceptions, r) {
			return once("exception")
		}
		if askOnly && excepted(s.Exceptions, r, true) {
			return once("exception-ask")
		}
	}
	if mode == permrules.Allow {
		return once("allow")
	}
	if cat == Read && !sensitive {
		return once("ask-read")
	}
	if s.Auto && len(classes) > 0 {
		all := true
		for _, c := range classes {
			all = all && s.AutoRun[c]
		}
		if all {
			return once("auto-run")
		}
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
// reaches: target is that session's root's word, or the caller's own for a
// spawn (a child is never looser than its spawner) and a schedule; "" when
// there is no target. A call is free when the target's word is the same or more
// cautious than the caller's on Allow; otherwise the caller's word applies. An
// Auto caller is on Ask here, except that its agents class running makes a
// call free the way Allow does.
func CoordinationFor(p Policy, s State, key string, delegate bool, target permrules.Action) (permrules.Action, string) {
	if p.Deny[ClassAgents] {
		return permrules.Deny, denyReason(ClassAgents)
	}
	// Plan changes nothing: only reading one's own delegate gets through it. A
	// send, a spawn or a schedule is refused delegate or not, because a delegate
	// spawned on Allow would otherwise carry the change for the Plan caller.
	if s.Mode == permrules.Deny && !(delegate && key == "session_read") {
		return permrules.Deny, PlanReason
	}
	autoRuns := s.Auto && s.AutoRun[ClassAgents]
	answer := permrules.Ask
	switch {
	case delegate:
		answer = permrules.Allow
	case contains(s.Coordination, key):
		answer = permrules.Allow
	case key == "session_list":
		answer = permrules.Allow
	case autoRuns && key != "session_read":
		answer = permrules.Allow
	case target.Valid() && wordRank(target) <= wordRank(s.Mode) && (s.Mode == permrules.Allow || askCallersAreFree):
		answer = permrules.Allow
	case s.Mode == permrules.Allow && key != "session_read":
		answer = permrules.Allow
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

// AskAlwaysOK reports whether a human's "always allow" on this request is an
// over-ask one: the request is in the credential class (which is a card even on
// Allow), so only a human's exception stands there. The loop class and
// galopin's own paths never get one.
func AskAlwaysOK(p Policy, r Request) bool {
	cat, sensitive := Classify(p, r)
	if _, hit := p.Protected.OwnHit(r); hit && cat != Internal {
		return false
	}
	secret := false
	for _, c := range p.classesOf(r, cat, sensitive) {
		if c == ClassLoop {
			return false
		}
		secret = secret || c == ClassSecrets
	}
	return secret
}

// ConnectorCall decides one call of a connector's tool through galopin's
// connector tools (ADR 0108, item 3), which are the `tools` class like any other
// MCP tool: allow means no card, ask a card, deny a refusal the model reads. The
// session's word decides (Plan refuses, Ask raises a card, Allow runs, Auto runs
// when its map says tools run); a local --deny tools refuses. Reading what is on
// offer (list true) changes nothing, so it is free unless denied.
func ConnectorCall(p Policy, s State, list bool) (permrules.Action, string) {
	if p.Deny[ClassTools] {
		return permrules.Deny, denyReason(ClassTools)
	}
	if list {
		return permrules.Allow, ""
	}
	if s.Mode == permrules.Deny {
		return permrules.Deny, PlanReason
	}
	if s.Mode == permrules.Allow || (s.Auto && s.AutoRun[ClassTools]) {
		return permrules.Allow, ""
	}
	return permrules.Ask, ""
}
