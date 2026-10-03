package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/permrules"
	"galopin/internal/policy"
	"galopin/internal/sessions"
)

// The Deny / Ask / Allow selector's live specs (S1–S12), against the real,
// pinned opencode and the mock LLM, through the real session.setPermissionMode,
// permission.reply, permission.rules and permission.saved.remove ops. What is
// asserted is what a tool does under the rules galopin composed, never a unit's
// say-so. Gated behind GALOPIN_OPENCODE_IT=1.

func bashArgs(command string) map[string]any {
	return map[string]any{"command": command, "description": "run it"}
}

// S1 Allow: an edit runs with no ask; bash still asks under the default `bash`
// ceiling of ask; a write outside the workspace asks; reading .env asks.
func TestSelectorS1Allow(t *testing.T) {
	r := newPermRig(t, permRigOpts{perm: policy.Permission{Max: map[string]string{"bash": "ask"}}})
	s := r.session("s1", "")
	r.setMode(s, "allow")
	if got := r.reread(s).Mode; got != "allow" {
		t.Fatalf("permission.rules mode = %q, want allow", got)
	}

	ask, part, mark := r.try(s, "s1-edit.txt")
	if ask != nil || part.ToolStatus != backend.ToolCompleted || !r.exists("s1-edit.txt") {
		t.Errorf("edit under Allow: ask=%v part=%+v exists=%v, want it to run with no ask", ask, part, r.exists("s1-edit.txt"))
	}
	r.idle(s, mark)

	ask, _, mark = r.tryCall(s, "bash", bashArgs("echo hi"))
	if ask == nil || ask.Tool != "bash" {
		t.Fatalf("bash under Allow with a ceiling of ask: ask=%v, want an ask (the ceiling caps the blanket)", ask)
	}
	r.reply(s, ask.ID, "reject")
	r.idle(s, mark)

	outside := filepath.Join(r.root, "s1-outside.txt")
	ask, _, mark = r.tryCall(s, "write", map[string]any{"filePath": outside, "content": "x"})
	if ask == nil || ask.Tool != "external_directory" {
		t.Fatalf("a write outside the workspace under Allow: ask=%v, want an external_directory ask", ask)
	}
	r.reply(s, ask.ID, "reject")
	r.idle(s, mark)
	if _, err := os.Stat(outside); err == nil {
		t.Error("the outside file was written before anyone answered")
	}

	if err := os.WriteFile(filepath.Join(r.work, ".env"), []byte("SECRET=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ask, _, mark = r.tryCall(s, "read", map[string]any{"filePath": filepath.Join(r.work, ".env")})
	if ask == nil || ask.Tool != "read" {
		t.Fatalf("reading .env under Allow: ask=%v, want a read ask", ask)
	}
	r.reply(s, ask.ID, "reject")
	r.idle(s, mark)
}

// S2 Ask: an edit asks; read and grep don't; the question tool works without a
// permission ask.
func TestSelectorS2Ask(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	s := r.session("s2", "")
	if got := r.reread(s).Mode; got != "ask" {
		t.Fatalf("a new session's mode = %q, want ask", got)
	}
	if err := os.WriteFile(filepath.Join(r.work, "s2.txt"), []byte("needle\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	ask, _, mark := r.try(s, "s2-edit.txt")
	if ask == nil || ask.Tool != "edit" {
		t.Fatalf("edit under Ask: ask=%v, want an ask", ask)
	}
	r.reply(s, ask.ID, "reject")
	r.idle(s, mark)

	ask, part, mark := r.tryCall(s, "read", map[string]any{"filePath": filepath.Join(r.work, "s2.txt")})
	if ask != nil || part.ToolStatus != backend.ToolCompleted {
		t.Errorf("read under Ask: ask=%v part=%+v, want it to run", ask, part)
	}
	r.idle(s, mark)
	ask, part, mark = r.tryCall(s, "grep", map[string]any{"pattern": "needle", "path": r.work})
	if ask != nil || part.ToolStatus != backend.ToolCompleted {
		t.Errorf("grep under Ask: ask=%v part=%+v, want it to run", ask, part)
	}
	r.idle(s, mark)

	// The question tool raises a question, never a permission ask.
	r.script(map[string]any{"toolCalls": []map[string]any{{
		"id": "call_s2_q", "name": "question",
		"arguments": `{"questions":[{"question":"Which approach?","header":"Approach","options":[{"label":"A","description":"Do A"},{"label":"B","description":"Do B"}],"multiple":false}]}`,
	}}})
	mark = r.hub.mark()
	if err := r.oc.Prompt(r.ctx, r.work, s.ID, backend.Prompt{Text: "ask me something"}); err != nil {
		t.Fatal(err)
	}
	r.hub.wait(t, mark, 60*time.Second, "question.asked", func(e sessions.Envelope) bool {
		return e.SessionID == s.ID && e.Event.Kind == backend.EventQuestionAsked
	})
	if asks := r.asks(mark, s); len(asks) != 0 {
		t.Errorf("the question tool raised a permission ask under Ask: %+v", asks)
	}
}

// S3 Deny: edit, bash and task are refused with no card; read works.
func TestSelectorS3Deny(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	s := r.session("s3", "")
	r.setMode(s, "deny")
	if err := os.WriteFile(filepath.Join(r.work, "s3.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		tool string
		args map[string]any
	}{
		{"write", map[string]any{"filePath": filepath.Join(r.work, "s3-edit.txt"), "content": "x"}},
		{"bash", bashArgs("echo hi > s3-bash.txt")},
		{"task", map[string]any{"description": "d", "prompt": "s3-task-marker", "subagent_type": "general"}},
	} {
		ask, part, mark := r.tryCall(s, c.tool, c.args)
		if ask != nil {
			t.Errorf("%s under Deny raised a card: %+v", c.tool, ask)
			r.reply(s, ask.ID, "reject")
		} else if !refused(part) {
			t.Errorf("%s under Deny: part=%+v, want it refused", c.tool, part)
		}
		r.idle(s, mark)
	}
	if r.exists("s3-edit.txt") || r.exists("s3-bash.txt") {
		t.Error("a refused tool still wrote")
	}
	ask, part, _ := r.tryCall(s, "read", map[string]any{"filePath": filepath.Join(r.work, "s3.txt")})
	if ask != nil || part.ToolStatus != backend.ToolCompleted {
		t.Errorf("read under Deny: ask=%v part=%+v, want it to run", ask, part)
	}
}

// S4 / S5 / S6 on one session: "always" under Ask stores an exception for
// exactly that command and tells opencode "once"; Deny blocks it and Ask
// restores it; removing it makes the command ask again.
func TestSelectorS4S5S6Exceptions(t *testing.T) {
	r := newPermRig(t, permRigOpts{perm: policy.Permission{Max: map[string]string{"bash": "allow"}}})
	s := r.session("s4", "")

	// S4.
	ask, _, mark := r.tryCall(s, "bash", bashArgs("git status"))
	if ask == nil || ask.Tool != "bash" {
		t.Fatalf("git status under Ask: ask=%v, want an ask", ask)
	}
	r.reply(s, ask.ID, "always")
	r.idle(s, mark)
	ex := r.exceptions(s)
	if len(ex) != 1 || ex[0].Permission != "bash" || !ex[0].Removable || ex[0].SessionID != s.ID || ex[0].GrantedAt == "" {
		t.Fatalf("exceptions = %+v, want one removable bash exception on this session", ex)
	}
	if ask, part, mark := r.tryCall(s, "bash", bashArgs("git status")); ask != nil || part.ToolStatus != backend.ToolCompleted {
		t.Errorf("git status after always: ask=%v part=%+v, want it to run", ask, part)
	} else {
		r.idle(s, mark)
	}
	ask, _, mark = r.tryCall(s, "bash", bashArgs("git log"))
	if ask == nil {
		t.Error("git log did not ask: the exception covers more than the command it was given for")
	} else {
		r.reply(s, ask.ID, "reject")
		r.idle(s, mark)
	}
	// A second session in the same workspace still asks: nothing was forwarded to
	// opencode as "always" (its approval would have been shared by the workspace).
	other := r.session("s4-other", "")
	ask, _, mark = r.tryCall(other, "bash", bashArgs("git status"))
	if ask == nil {
		t.Error("a second session in the same workspace ran git status without asking: an always reached opencode")
	} else {
		r.reply(other, ask.ID, "reject")
		r.idle(other, mark)
	}
	var always bool
	for _, row := range r.auditRows() {
		always = always || (row["action"] == "permission" && row["decision"] == "always" && row["capped"] == nil)
	}
	if !always {
		t.Errorf("the always is not in the audit log: %v", r.auditRows())
	}

	// S5.
	r.setMode(s, "deny")
	ask, part, mark := r.tryCall(s, "bash", bashArgs("git status"))
	if ask != nil || !refused(part) {
		t.Errorf("git status under Deny with an exception: ask=%v part=%+v, want it refused (Deny beats an exception)", ask, part)
	}
	r.idle(s, mark)
	if ex := r.exceptions(s); len(ex) != 1 {
		t.Errorf("exceptions while Deny = %+v, want it kept", ex)
	}
	r.setMode(s, "ask")
	if ask, part, mark := r.tryCall(s, "bash", bashArgs("git status")); ask != nil || part.ToolStatus != backend.ToolCompleted {
		t.Errorf("git status back on Ask: ask=%v part=%+v, want the exception restored", ask, part)
	} else {
		r.idle(s, mark)
	}

	// S6.
	r.removeException(s, ex[0].ID)
	if got := r.exceptions(s); len(got) != 0 {
		t.Errorf("exceptions after removal = %+v", got)
	}
	ask, _, mark = r.tryCall(s, "bash", bashArgs("git status"))
	if ask == nil {
		t.Error("git status ran after its exception was removed")
	} else {
		r.reply(s, ask.ID, "reject")
		r.idle(s, mark)
	}
	var removed bool
	for _, row := range r.auditRows() {
		removed = removed || (row["action"] == "permission.saved.remove" && row["id"] == ex[0].ID)
		if row["action"] == "permission.saved.remove" {
			if raw, _ := json.Marshal(row); strings.Contains(string(raw), "git status") {
				t.Errorf("a pattern reached the audit log: %s", raw)
			}
		}
	}
	if !removed {
		t.Error("the removal is not in the audit log")
	}
}

// S7: "always" on a capped key stores nothing, and the next call asks.
func TestSelectorS7AlwaysOnACappedKeyStoresNothing(t *testing.T) {
	r := newPermRig(t, permRigOpts{perm: policy.Permission{Max: map[string]string{"bash": "ask"}}})
	s := r.session("s7", "")
	ask, _, mark := r.tryCall(s, "bash", bashArgs("echo capped"))
	if ask == nil {
		t.Fatal("no ask")
	}
	r.reply(s, ask.ID, "always")
	r.idle(s, mark)
	if ex := r.exceptions(s); len(ex) != 0 {
		t.Errorf("exceptions = %+v, want none: the ceiling caps bash", ex)
	}
	ask, _, mark = r.tryCall(s, "bash", bashArgs("echo capped"))
	if ask == nil {
		t.Error("the next identical call did not ask")
	} else {
		r.reply(s, ask.ID, "reject")
		r.idle(s, mark)
	}
	var capped bool
	for _, row := range r.auditRows() {
		capped = capped || (row["action"] == "permission" && row["decision"] == "once" && row["capped"] == true)
	}
	if !capped {
		t.Errorf("audit lacks the capped reply: %v", r.auditRows())
	}
}

// S8 Subagents follow their root.
//
// What opencode 1.18.32 does with a session's rules shapes what can be asserted
// here, and two of its habits are pinned by TestSelectorAModeChangedMidTurnIsInForceOnTheNextTurn:
// it takes a session's rules once, when a turn starts, so a PATCH lands from the
// session's NEXT turn; and a task creates its subagent session and starts its
// first turn in one breath, before galopin has heard of it. A subagent's first
// turn is therefore judged by what the process already carries — the agent-level
// floor (which asks for the blanket's names) and the denies opencode copies from
// its parent — and the root's selector governs every turn after it. Each subtest
// says which it is looking at.
func TestSelectorS8Subagents(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	general := r.agentRules("general")
	childRules := func(id string) []permrules.Rule {
		return append(append([]permrules.Rule(nil), general...), r.sessionRules(id)...)
	}
	child := func(id string) backend.Session { return backend.Session{ID: id} }

	t.Run("root on Allow: the first turn is held by the floor, the next turn's edit runs", func(t *testing.T) {
		root := r.session("s8-allow", "")
		r.setMode(root, "allow")
		id, mark := r.delegate(root, "s8-allow-marker", "s8-allow.txt")
		ask, _ := r.childOutcome(id, mark)
		if ask == nil || ask.Tool != "edit" {
			t.Fatalf("a task child's first turn under a root on Allow: ask=%v, want the floor's ask (the root's rules cannot be on the child before its first turn starts)", ask)
		}
		r.reply(child(id), ask.ID, "once")
		r.idle(root, mark)
		if got := permrules.Evaluate(childRules(id), "edit", "x.txt"); got != permrules.Allow {
			t.Fatalf("the child's rules after its first turn say edit = %s, want the root's Allow", got)
		}
		ask, part, _ := r.tryCall(child(id), "write", map[string]any{"filePath": filepath.Join(r.work, "s8-allow-2.txt"), "content": "x"})
		if ask != nil || part.ToolStatus != backend.ToolCompleted || !r.exists("s8-allow-2.txt") {
			t.Errorf("the child's next turn under a root on Allow: ask=%v part=%+v exists=%v, want the edit to run", ask, part, r.exists("s8-allow-2.txt"))
		}
	})

	t.Run("root on Deny: the child's edit is refused", func(t *testing.T) {
		// Deny withdraws the task tool from the root itself, so the child is a
		// session opencode is told is a child of the root's (parentID): galopin
		// learns of it the way it learns of a task's, from its session event.
		root := r.session("s8-deny", "")
		r.setMode(root, "deny")
		kid := r.rawChild(root)
		ask, part, _ := r.tryCall(kid, "write", map[string]any{"filePath": filepath.Join(r.work, "s8-deny.txt"), "content": "x"})
		if ask != nil {
			r.reply(kid, ask.ID, "reject")
			t.Fatalf("the child asked (%+v) under a root on Deny", ask)
		}
		if !refused(part) || r.exists("s8-deny.txt") {
			t.Errorf("child edit under a root on Deny: part=%+v exists=%v, want refused", part, r.exists("s8-deny.txt"))
		}
	})

	t.Run("a root change is re-applied to a tracked child", func(t *testing.T) {
		root := r.session("s8-reapply", "")
		id, mark := r.delegate(root, "s8-reapply-marker", "s8-reapply.txt")
		ask, _ := r.childOutcome(id, mark)
		if ask == nil {
			t.Fatal("under Ask the child's edit did not ask")
		}
		r.reply(child(id), ask.ID, "once")
		r.idle(root, mark)
		if got := permrules.Evaluate(childRules(id), "edit", "x.txt"); got != permrules.Ask {
			t.Fatalf("the child's rules under a root on Ask say edit = %s", got)
		}
		r.setMode(root, "allow")
		if got := permrules.Evaluate(childRules(id), "edit", "x.txt"); got != permrules.Allow {
			t.Errorf("the child's rules after the root went to Allow say edit = %s: the change did not reach a live child", got)
		}
		r.setMode(root, "deny")
		if got := permrules.Evaluate(childRules(id), "edit", "x.txt"); got != permrules.Deny {
			t.Errorf("the child's rules after the root went to Deny say edit = %s", got)
		}
		if got := r.oc.PermissionMode(id); got != permrules.Deny {
			t.Errorf("the child reports mode %s, want its root's", got)
		}
	})

	t.Run("the root's exception reaches the child's next turn", func(t *testing.T) {
		root := r.session("s8-exception", "")
		id, mark := r.delegate(root, "s8-ex-marker", "s8-ex-first.txt")
		ask, _ := r.childOutcome(id, mark)
		if ask == nil {
			t.Fatal("no first ask")
		}
		r.reply(child(id), ask.ID, "once")
		r.idle(root, mark)
		if _, err := r.oc.AddException(r.ctx, r.work, root.ID, permrules.Exception{
			ID: "ex_s8", Permission: "edit", Patterns: []string{"*s8-ex.txt"},
		}); err != nil {
			t.Fatal(err)
		}
		ask, part, _ := r.tryCall(child(id), "write", map[string]any{"filePath": filepath.Join(r.work, "s8-ex.txt"), "content": "x"})
		if ask != nil || part.ToolStatus != backend.ToolCompleted || !r.exists("s8-ex.txt") {
			t.Errorf("child edit of the excepted file: ask=%v part=%+v exists=%v, want it to run", ask, part, r.exists("s8-ex.txt"))
		}
		ask, _, _ = r.tryCall(child(id), "write", map[string]any{"filePath": filepath.Join(r.work, "s8-other.txt"), "content": "x"})
		if ask == nil {
			t.Error("the exception covered a file it was not given for")
		} else {
			r.reply(child(id), ask.ID, "reject")
		}
	})
}

// opencode takes a session's rules when a turn starts, so a PATCH made while a
// turn runs (probed live: a mode changed while the turn waited on an ask, with the
// turn's next step still asking) applies from the next turn. galopin's selector is
// written against that — a change is in force from the session's next turn, and a
// task's first turn belongs to the floor — and this pins the half a mock without
// multi-step scripts can: that the change IS in force on the next turn, through
// the mode change made mid-turn.
func TestSelectorAModeChangedMidTurnIsInForceOnTheNextTurn(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	s := r.session("per-turn", "")
	ask, _, mark := r.try(s, "per-turn-1.txt")
	if ask == nil {
		t.Fatal("no first ask")
	}
	// The mode changes while the turn is waiting on this ask.
	r.setMode(s, "allow")
	r.reply(s, ask.ID, "once")
	r.idle(s, mark)
	// Next turn: the new mode is in force.
	if ask, part, _ := r.try(s, "per-turn-2.txt"); ask != nil || part.ToolStatus != backend.ToolCompleted {
		t.Errorf("the next turn after the change: ask=%v part=%+v, want it to run under Allow", ask, part)
	}
}

// S9 Legacy machine: no permission block anywhere (no file block, no rules, no
// ceiling), as on a machine whose policy.json predates permissions. A new
// session's write asks — the hello-world regression test — with no re-enroll.
func TestSelectorS9LegacyMachineAsksBeforeWriting(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	s := r.session("s9", "")
	ask, _, mark := r.try(s, "s9.txt")
	if ask == nil {
		t.Fatal("a new session on a machine with no permission policy wrote without asking")
	}
	if r.exists("s9.txt") {
		t.Error("the file exists before anyone answered")
	}
	if got := r.reread(s).Mode; got != "ask" {
		t.Errorf("mode = %q, want ask", got)
	}
	r.reply(s, ask.ID, "once")
	r.idle(s, mark)
	if !r.exists("s9.txt") {
		t.Error("once did not land the write")
	}
}

// S11: the retired ops answer unsupported; permission.rules lists exceptions as
// removable.
func TestSelectorS11RetiredOpsAndRemovableExceptions(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	s := r.session("s11", "")
	for _, op := range []string{"session.setAutoAccept", "session.setRules"} {
		raw, _ := json.Marshal(map[string]any{"sessionId": s.ID, "enabled": true, "rules": []any{}})
		if _, operr := r.mc.Handle(r.ctx, op, raw); operr == nil || operr.Code != "unsupported" {
			t.Errorf("%s: %v, want unsupported", op, operr)
		}
	}
	ask, _, mark := r.try(s, "s11.txt")
	if ask == nil {
		t.Fatal("no ask")
	}
	r.reply(s, ask.ID, "always")
	r.idle(s, mark)
	ex := r.exceptions(s)
	if len(ex) != 1 || !ex[0].Removable || ex[0].Permission != "edit" {
		t.Errorf("savedApprovals = %+v, want one removable edit exception", ex)
	}
	// A bad mode and an unknown session.
	for body, code := range map[string]string{
		`{"sessionId":"` + s.ID + `","mode":"maybe"}`: "invalid",
		`{"sessionId":"ses_nope","mode":"allow"}`:     "not_found",
	} {
		if _, operr := r.mc.Handle(r.ctx, "session.setPermissionMode", json.RawMessage(body)); operr == nil || operr.Code != code {
			t.Errorf("session.setPermissionMode %s: %v, want %s", body, operr, code)
		}
	}
	// Session objects carry the word.
	res, operr := r.mc.Handle(r.ctx, "session.get", json.RawMessage(`{"sessionId":"`+s.ID+`"}`))
	if operr != nil {
		t.Fatal(operr)
	}
	body, _ := json.Marshal(res)
	if !strings.Contains(string(body), `"permissionMode":"ask"`) {
		t.Errorf("session.get = %s, want permissionMode ask", body)
	}
}

// S12 canary: every permission name opencode 1.18.32 knows is classified by
// galopin as either untouched by the selector's blanket or following it. A name
// that is in neither fails here, so a release that adds one cannot silently
// land on the wrong side (an untouched name a blanket Allow would flip, or a
// blanket name left unrestated). Names are read from the binary itself: the
// permission config schema, every rule of every built-in agent, and the tool
// registry (a tool's permission is its id, except write and apply_patch, which
// ask `edit`).
func TestSelectorS12EveryPermissionNameIsClassified(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	names := map[string]string{} // name -> where it was seen

	var doc struct {
		Components struct {
			Schemas map[string]struct {
				AnyOf []struct {
					Properties map[string]json.RawMessage `json:"properties"`
				} `json:"anyOf"`
			} `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(r.raw(http.MethodGet, "/doc", nil), &doc); err != nil {
		t.Fatal(err)
	}
	cfg, ok := doc.Components.Schemas["PermissionConfig"]
	if !ok {
		t.Fatal("GET /doc has no PermissionConfig schema: the permission vocabulary can no longer be read from the binary; revisit this canary")
	}
	for _, alt := range cfg.AnyOf {
		for name := range alt.Properties {
			names[name] = "the permission config schema"
		}
	}

	var agents []struct {
		Name       string           `json:"name"`
		Permission []permrules.Rule `json:"permission"`
	}
	if err := json.Unmarshal(r.raw(http.MethodGet, "/agent?directory="+r.work, nil), &agents); err != nil {
		t.Fatal(err)
	}
	for _, a := range agents {
		for _, rule := range a.Permission {
			if rule.Permission != "*" {
				names[rule.Permission] = "agent " + a.Name
			}
		}
	}

	var tools []string
	if err := json.Unmarshal(r.raw(http.MethodGet, "/experimental/tool/ids", nil), &tools); err != nil {
		t.Fatal(err)
	}
	for _, tool := range tools {
		switch tool {
		case "invalid":
			continue // the stand-in a withdrawn tool's call lands on; no permission of its own
		case "write", "apply_patch":
			tool = "edit"
		}
		names[tool] = "the tool registry"
	}

	if len(names) < 10 {
		t.Fatalf("read only %d permission names (%v): the canary is not seeing the binary's vocabulary", len(names), names)
	}
	classified := map[string]bool{}
	for _, n := range permrules.Untouched {
		classified[n] = true
	}
	for _, n := range permrules.Blanket {
		classified[n] = true
	}
	var unknown []string
	for name, where := range names {
		if !classified[name] {
			unknown = append(unknown, name+" (from "+where+")")
		}
	}
	sort.Strings(unknown)
	if len(unknown) > 0 {
		t.Errorf("permission names opencode knows that permrules classifies neither as Untouched nor as Blanket: %v. "+
			"Decide for each whether a blanket Allow/Deny should move it, add it to permrules.Untouched or permrules.Blanket, "+
			"and check what it does under each mode live before shipping this opencode.", unknown)
	}
	// Names the table lists that this opencode does not (yet) know are fine —
	// they are the brief's list, kept for the releases that add them — but say so.
	for name := range classified {
		if _, seen := names[name]; !seen {
			t.Logf("note: %q is classified but this opencode does not name it", name)
		}
	}
}

// rawChild makes a session opencode is told is a subagent session of parent (a
// create with parentID) and gives it its root's rules the way the machine does
// when a task creates one (the task flow itself is exercised by the delegate
// subtests; a root on Deny cannot delegate, its task tool being withdrawn).
func (r *permRig) rawChild(parent backend.Session) backend.Session {
	r.t.Helper()
	out := r.raw(http.MethodPost, "/session?directory="+r.work, map[string]any{"title": "child", "parentID": parent.ID})
	var m struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(out, &m)
	child := backend.Session{ID: m.ID, Title: "child", ParentID: parent.ID}
	r.mc.trackSession(r.ws, child)
	for deadline := time.Now().Add(10 * time.Second); r.oc.RootOf(child.ID) != parent.ID; time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			r.t.Fatalf("galopin never learned that %s is under %s", child.ID, parent.ID)
		}
	}
	if err := r.oc.ApplyChildRules(r.ctx, r.work, child.ID, "general"); err != nil {
		r.t.Fatal(err)
	}
	return child
}
