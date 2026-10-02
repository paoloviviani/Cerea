package main

import (
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/permrules"
	"galopin/internal/policy"
)

// P1: the file says edit: deny, the machine's own rules say edit: allow. The
// machine's rules sit above the file, so the write runs and nothing asks.
func TestPassthroughP1MachineRulesBeatTheFile(t *testing.T) {
	r := newPermRig(t, permRigOpts{
		file: map[string]any{"edit": "deny"},
		perm: policy.Permission{Rules: map[string]string{"edit": "allow"}},
	})
	s := r.session("p1", "")
	ask, part, mark := r.try(s, "p1.txt")
	if ask != nil {
		t.Fatalf("asked for %s %v; the machine's allow should have run it", ask.Tool, ask.Patterns)
	}
	if part.ToolStatus != backend.ToolCompleted || !r.exists("p1.txt") {
		t.Errorf("write = %s (%s), file exists=%v", part.ToolStatus, part.ToolError, r.exists("p1.txt"))
	}
	r.idle(s, mark)
	if asks := r.asks(mark, s); len(asks) != 0 {
		t.Errorf("asks = %v, want none", asks)
	}

	// Control: without the machine's rule the same file denies.
	r2 := newPermRig(t, permRigOpts{file: map[string]any{"edit": "deny"}})
	s2 := r2.session("p1-control", "")
	ask, part, _ = r2.try(s2, "p1c.txt")
	if ask != nil || !refused(part) || r2.exists("p1c.txt") {
		t.Errorf("control: ask=%v part=%+v exists=%v; the file's deny should stand alone", ask, part, r2.exists("p1c.txt"))
	}
}

// P2: the file allows edit, the machine's own rule says ask. Exactly one ask,
// which stays pending whatever the panel is doing; once lands the write,
// reject errors the tool.
func TestPassthroughP2AskStaysPendingAndAnswersLand(t *testing.T) {
	r := newPermRig(t, permRigOpts{
		file: map[string]any{"edit": "allow"},
		perm: policy.Permission{Rules: map[string]string{"edit": "ask"}},
	})
	s := r.session("p2", "")
	ask, _, mark := r.try(s, "p2a.txt")
	if ask == nil {
		t.Fatal("the write ran; the machine's ask should have beaten the file's allow")
	}
	if ask.Tool != "edit" {
		t.Errorf("ask tool = %q, want edit", ask.Tool)
	}
	// Still pending seconds later: nothing reaches for it (no panel is attached
	// here at all), and nothing times it out.
	time.Sleep(4 * time.Second)
	if n := r.mat.PendingPermissions(s.ID); n != 1 {
		t.Fatalf("pending = %d after 4s, want exactly the one ask", n)
	}
	if asks := r.asks(mark, s); len(asks) != 1 {
		t.Fatalf("asks = %d, want exactly one permission.asked", len(asks))
	}
	if r.exists("p2a.txt") {
		t.Fatal("the file was written before anyone answered")
	}
	r.reply(s, ask.ID, "once")
	r.idle(s, mark)
	if !r.exists("p2a.txt") {
		t.Error("once did not land the write")
	}

	ask, _, mark = r.try(s, "p2b.txt")
	if ask == nil {
		t.Fatal("the second write did not ask")
	}
	r.reply(s, ask.ID, "reject")
	part := r.hub.toolDone(t, mark, s.ID, "write")
	if part.ToolStatus != backend.ToolFailed || r.exists("p2b.txt") {
		t.Errorf("reject: tool %s, file exists=%v", part.ToolStatus, r.exists("p2b.txt"))
	}
}

// P3: the machine's rule says allow but the ceiling says ask: the ceiling wins.
// "always" becomes "once": nothing is saved, and the next identical write asks again.
func TestPassthroughP3CeilingWinsAndAlwaysBecomesOnce(t *testing.T) {
	r := newPermRig(t, permRigOpts{
		perm: policy.Permission{Rules: map[string]string{"edit": "allow"}, Max: map[string]string{"edit": "ask"}},
	})
	s := r.session("p3", "")
	// The rules were in the create itself: they are on the session before any
	// prompt exists, with the ceiling last.
	rules := r.sessionRules(s.ID)
	if len(rules) == 0 || rules[0] != (permrules.Rule{Permission: "edit", Pattern: "*", Action: permrules.Allow}) ||
		rules[len(rules)-1].Action != permrules.Ask {
		t.Fatalf("session rules before the first prompt = %+v, want the machine's allow first and the ceiling's ask last", rules)
	}
	ask, _, mark := r.try(s, "p3a.txt")
	if ask == nil {
		t.Fatal("the write ran; the ceiling (ask) should have beaten the machine's allow")
	}
	r.reply(s, ask.ID, "always")
	r.idle(s, mark)
	if !r.exists("p3a.txt") {
		t.Fatal("the capped answer should still have let this one write through")
	}
	if saved := r.saved(); len(saved) != 0 {
		t.Errorf("saved approvals = %+v, want none: the ceiling turns always into once", saved)
	}
	// The next identical write asks again — that is what "once" means.
	ask, _, mark = r.try(s, "p3a.txt")
	if ask == nil {
		t.Fatal("an identical write did not ask again: the always was remembered")
	}
	r.reply(s, ask.ID, "reject")
	r.idle(s, mark)

	var capped bool
	for _, row := range r.auditRows() {
		if row["action"] == "permission" && row["decision"] == "once" && row["capped"] == true && row["by"] == "user" {
			capped = true
		}
	}
	if !capped {
		t.Errorf("audit lacks the capped reply: %v", r.auditRows())
	}
}

// P6: an "always" is given while the ceiling still allows it. The ceiling is
// then tightened to deny. opencode keeps the always in memory and checks it
// after every rule, so only the restart galopin performs makes the deny hold.
func TestPassthroughP6TightenedCeilingRestartsAndDenies(t *testing.T) {
	r := newPermRig(t, permRigOpts{file: map[string]any{"edit": "ask"}})
	s := r.session("p6", "")
	ask, _, mark := r.try(s, "p6a.txt")
	if ask == nil {
		t.Fatal("the write did not ask (file says ask)")
	}
	r.reply(s, ask.ID, "always")
	r.idle(s, mark)
	if saved := r.saved(); len(saved) != 1 || saved[0].Permission != "edit" || saved[0].SessionID != s.ID || saved[0].WorkspaceDir != r.work {
		t.Fatalf("the machine's record of the always = %+v, want one edit approval granted by this session in this workspace", saved)
	}
	// Remembered: the next write sails through without asking.
	if ask, part, _ := r.try(s, "p6b.txt"); ask != nil || part.ToolStatus != backend.ToolCompleted {
		t.Fatalf("the always was not honoured: ask=%v part=%+v", ask, part)
	}

	// Tighten through the same path the file watcher takes.
	ch := r.live.Tighten(policy.Permission{Max: map[string]string{"edit": "deny"}})
	if !ch.Tightened {
		t.Fatalf("the ceiling did not read as tightened: %+v", ch)
	}
	r.mc.policyTightened(r.ctx, ch)

	ask, part, _ := r.try(s, "p6c.txt")
	if ask != nil {
		t.Fatalf("asked after the ceiling went to deny: %+v", ask)
	}
	if !refused(part) || r.exists("p6c.txt") {
		t.Errorf("after the restart: tool=%s %s (%s) exists=%v, want denied", part.Tool, part.ToolStatus, part.ToolError, r.exists("p6c.txt"))
	}
	var restarted bool
	for _, row := range r.auditRows() {
		restarted = restarted || (row["action"] == "permission.tightened" && row["restarted"] == true)
	}
	if !restarted {
		t.Error("the restart was not audited")
	}
	if saved := r.saved(); len(saved) != 0 {
		t.Errorf("saved approvals after the restart = %+v, want them forgotten with the process that held them", saved)
	}
}

// The pending ask of a session dies with the restart, and no client is left
// holding a card for it.
func TestPassthroughRestartWithdrawsPendingAsks(t *testing.T) {
	r := newPermRig(t, permRigOpts{file: map[string]any{"edit": "ask"}})
	s := r.session("restart", "")
	ask, _, _ := r.try(s, "r.txt")
	if ask == nil {
		t.Fatal("no ask")
	}
	ch := r.live.Tighten(policy.Permission{Max: map[string]string{"bash": "deny"}})
	r.mc.policyTightened(r.ctx, ch)
	if n := r.mat.PendingPermissions(s.ID); n != 0 {
		t.Errorf("pending = %d after the restart, want the dead ask withdrawn", n)
	}
}

// P4: the parent's own session rule allows edit and it writes without a card.
// Its subagent does not inherit that: it falls back to its own agent's rules
// (and the file's), which ask.
func TestPassthroughP4ParentAllowDoesNotReachTheSubagent(t *testing.T) {
	r := newPermRig(t, permRigOpts{
		file: map[string]any{"edit": "ask"},
		perm: policy.Permission{Rules: map[string]string{"edit": "allow"}},
	})
	parent := r.session("p4", "")
	if ask, part, _ := r.try(parent, "p4-parent.txt"); ask != nil || part.ToolStatus != backend.ToolCompleted {
		t.Fatalf("the parent's own write: ask=%v part=%+v; its allow should apply to itself", ask, part)
	}

	child, mark := r.delegate(parent, "p4-child-marker", "p4-child.txt")
	ask, part := r.childOutcome(child, mark)
	if ask == nil {
		t.Fatalf("the subagent wrote without asking (%+v): the parent's allow reached it", part)
	}
	if ask.SessionID != child {
		t.Errorf("ask belongs to %s, want the child %s", ask.SessionID, child)
	}
	for _, env := range r.hub.since(mark) {
		if env.Event.Kind == backend.EventPermissionAsked && env.SessionID == child && env.RootSessionID != parent.ID {
			t.Errorf("the child's ask is rooted at %q, want the parent %q", env.RootSessionID, parent.ID)
		}
	}
	for _, rule := range r.sessionRules(child) {
		if rule.Permission == "edit" && rule.Action == permrules.Allow {
			t.Errorf("the child's own rules carry an edit allow: %+v", rule)
		}
	}
	if r.exists("p4-child.txt") {
		t.Fatal("the child's file exists before anyone answered")
	}
	r.reply(backend.Session{ID: child}, ask.ID, "once")
	r.hub.toolDone(t, mark, child, "write")
	if !r.exists("p4-child.txt") {
		t.Error("answering the child's ask did not land its write")
	}
}

// P5: the parent's session denies edit. A deny is the one thing a subagent
// does inherit: its write is refused with no card.
func TestPassthroughP5ParentDenyReachesTheSubagent(t *testing.T) {
	r := newPermRig(t, permRigOpts{
		file: map[string]any{"edit": "ask"},
		perm: policy.Permission{Rules: map[string]string{"edit": "deny"}},
	})
	parent := r.session("p5", "")
	child, mark := r.delegate(parent, "p5-child-marker", "p5-child.txt")
	ask, part := r.childOutcome(child, mark)
	if ask != nil {
		t.Fatalf("the subagent was asked (%+v); a deny should have been inherited", ask)
	}
	if !refused(part) || r.exists("p5-child.txt") {
		t.Errorf("child write: tool=%s %s (%s), file exists=%v; want refused", part.Tool, part.ToolStatus, part.ToolError, r.exists("p5-child.txt"))
	}
	r.idle(parent, mark)
	if asks := r.asks(mark, backend.Session{ID: child}); len(asks) != 0 {
		t.Errorf("child asks = %v, want no card", asks)
	}
}

// P6b: why the restart exists. An always is kept in memory, shared by every
// session in the workspace and checked after every rule, so lowering a ceiling
// from allow to ask does NOT make the next write ask until the process is
// restarted. galopin restarts it.
func TestPassthroughP6bTightenedToAskNeedsTheRestart(t *testing.T) {
	r := newPermRig(t, permRigOpts{file: map[string]any{"edit": "ask"}})
	s := r.session("p6b", "")
	ask, _, mark := r.try(s, "p6b-a.txt")
	if ask == nil {
		t.Fatal("no first ask")
	}
	r.reply(s, ask.ID, "always")
	r.idle(s, mark)
	if ask, part, _ := r.try(s, "p6b-b.txt"); ask != nil || part.ToolStatus != backend.ToolCompleted {
		t.Fatalf("the always was not honoured: ask=%v part=%+v", ask, part)
	}

	ch := r.live.Tighten(policy.Permission{Max: map[string]string{"edit": "ask"}})
	if !ch.Tightened {
		t.Fatal("not tightened")
	}
	// Rules alone, no restart: the always still wins. This is the behaviour the
	// restart answers; if opencode ever stops doing it, this log says so.
	if err := r.oc.EnsureRules(r.ctx, r.work, s.ID); err != nil {
		t.Fatal(err)
	}
	if ask, _, _ := r.try(s, "p6b-c.txt"); ask != nil {
		t.Log("opencode now asks despite an always once the ceiling's rules are applied: the restart may no longer be needed (canary TestUpgradeCanaryAlwaysIsSharedAndCheckedAfterRules says which)")
		r.reply(s, ask.ID, "reject")
	}

	r.mc.policyTightened(r.ctx, ch)
	ask, part, _ := r.try(s, "p6b-d.txt")
	if ask == nil {
		t.Fatalf("after the restart the write did not ask: %+v", part)
	}
	r.reply(s, ask.ID, "reject")
}

// P1 (the panel's claim): the file says edit: deny and a person's setRules
// says edit: allow. The session block beats the file, so the write RUNS.
// (TestPassthroughP1MachineRulesBeatTheFile is the machine's own rule against
// the file; this is the session's.)
func TestPassthroughP1SetRulesBeatTheFile(t *testing.T) {
	r := newPermRig(t, permRigOpts{file: map[string]any{"edit": "deny"}})
	s := r.session("p1-setrules", "")
	if ask, part, _ := r.try(s, "p1-before.txt"); ask != nil || !refused(part) || r.exists("p1-before.txt") {
		t.Fatalf("control: ask=%v part=%+v exists=%v; the file's deny should stand until a rule is set", ask, part, r.exists("p1-before.txt"))
	}
	r.setRules(s, []map[string]string{{"permission": "edit", "pattern": "*", "action": "allow"}})
	ask, part, mark := r.try(s, "p1-after.txt")
	if ask != nil {
		t.Fatalf("asked for %s; the person's allow should have run it", ask.Tool)
	}
	if part.ToolStatus != backend.ToolCompleted || !r.exists("p1-after.txt") {
		t.Errorf("write = %s (%s), exists=%v", part.ToolStatus, part.ToolError, r.exists("p1-after.txt"))
	}
	r.idle(s, mark)
	// And the re-read says so: the written rule is a cerea one, after the file's.
	var fileDeny, cereaAllow bool
	for _, rule := range r.reread(s).Rules {
		fileDeny = fileDeny || (rule.Source == "file" && rule.Permission == "edit" && rule.Action == "deny")
		cereaAllow = cereaAllow || (rule.Source == "cerea" && rule.Permission == "edit" && rule.Action == "allow")
	}
	if !fileDeny || !cereaAllow {
		t.Errorf("re-read lacks the file's deny (%v) or the cerea allow (%v)", fileDeny, cereaAllow)
	}
}

// F2: the machine's own ask reaches a subagent. A parent's rule normally stops
// at the parent (opencode carries only denies); a restricting machine rule is
// applied to the child as a cap, so the subagent's write asks.
func TestPassthroughMachineAskReachesTheSubagent(t *testing.T) {
	r := newPermRig(t, permRigOpts{perm: policy.Permission{Rules: map[string]string{"edit": "ask"}}})
	parent := r.session("machine-ask", "")
	child, mark := r.delegate(parent, "machine-ask-marker", "machine-ask.txt")
	ask, part := r.childOutcome(child, mark)
	if ask == nil {
		t.Fatalf("the subagent wrote without asking (%+v): the machine's ask stopped at the parent", part)
	}
	if ask.SessionID != child || ask.Tool != "edit" {
		t.Errorf("ask = %+v", ask)
	}
	if r.exists("machine-ask.txt") {
		t.Fatal("the file exists before anyone answered")
	}
	// Restrict-only: the same rule applied to a read-only subagent could only
	// tighten, never turn its deny into an ask (permrules + backend units pin
	// that); here the general child's write lands once answered.
	r.reply(backend.Session{ID: child}, ask.ID, "once")
	r.hub.toolDone(t, mark, child, "write")
	if !r.exists("machine-ask.txt") {
		t.Error("answering the child's ask did not land its write")
	}
}
