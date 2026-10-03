package main

import (
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/permrules"
	"galopin/internal/policy"
)

// P1: the file says edit: deny, the machine's own rules say edit: allow. The
// machine's rule sits above the file's, so it wins over it; the session's mode
// block then takes it to the selector's word. Under Allow the write runs and
// nothing asks. The control: the file's deny alone is a deny, and a deny is the
// one thing the blanket never moves, so Allow does not run that write.
func TestPassthroughP1MachineRulesBeatTheFile(t *testing.T) {
	r := newPermRig(t, permRigOpts{
		file: map[string]any{"edit": "deny"},
		perm: policy.Permission{Rules: map[string]string{"edit": "allow"}},
	})
	s := r.session("p1", "")
	r.setMode(s, "allow")
	ask, part, mark := r.try(s, "p1.txt")
	if ask != nil {
		t.Fatalf("asked for %s %v; the machine's allow under the session's Allow should have run it", ask.Tool, ask.Patterns)
	}
	if part.ToolStatus != backend.ToolCompleted || !r.exists("p1.txt") {
		t.Errorf("write = %s (%s), file exists=%v", part.ToolStatus, part.ToolError, r.exists("p1.txt"))
	}
	r.idle(s, mark)
	if asks := r.asks(mark, s); len(asks) != 0 {
		t.Errorf("asks = %v, want none", asks)
	}

	// Control: without the machine's rule the same file denies, whatever the mode.
	r2 := newPermRig(t, permRigOpts{file: map[string]any{"edit": "deny"}})
	s2 := r2.session("p1-control", "")
	r2.setMode(s2, "allow")
	ask, part, _ = r2.try(s2, "p1c.txt")
	if ask != nil || !refused(part) || r2.exists("p1c.txt") {
		t.Errorf("control: ask=%v part=%+v exists=%v; the file's deny should stand under Allow", ask, part, r2.exists("p1c.txt"))
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
	if ex := r.exceptions(s); len(ex) != 0 {
		t.Errorf("exceptions = %+v, want none: a capped key stores nothing", ex)
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

// P6: an "always allow" is given while the ceiling still allows it. The ceiling
// is then tightened to deny. The exception is galopin's own rule, composed under
// the ceiling's tail, so the deny holds; the process is restarted all the same
// (what an older one may still hold in memory dies with it). The exception is
// kept, not forgotten with the process: it is galopin's, and listed still.
func TestPassthroughP6TightenedCeilingRestartsAndDenies(t *testing.T) {
	r := newPermRig(t, permRigOpts{file: map[string]any{"edit": "ask"}})
	s := r.session("p6", "")
	ask, _, mark := r.try(s, "p6a.txt")
	if ask == nil {
		t.Fatal("the write did not ask (file says ask)")
	}
	r.reply(s, ask.ID, "always")
	r.idle(s, mark)
	if ex := r.exceptions(s); len(ex) != 1 || ex[0].Permission != "edit" || ex[0].SessionID != s.ID || !ex[0].Removable {
		t.Fatalf("the exception for the always = %+v, want one removable edit exception on this session", ex)
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
	if ex := r.exceptions(s); len(ex) != 1 {
		t.Errorf("exceptions after the restart = %+v, want the one kept (it is galopin's, not the process's)", ex)
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

// P4: the machine's own allow of edit does not reach a subagent. The parent is on
// Ask (the mode block sits above the machine's own rule), so it asks; so does the
// child, and no edit allow is among the child's own rules.
func TestPassthroughP4MachineAllowDoesNotReachTheSubagent(t *testing.T) {
	r := newPermRig(t, permRigOpts{
		file: map[string]any{"edit": "ask"},
		perm: policy.Permission{Rules: map[string]string{"edit": "allow"}},
	})
	parent := r.session("p4", "")
	if ask, _, _ := r.try(parent, "p4-parent.txt"); ask == nil {
		t.Fatal("the parent wrote without asking: the machine's allow beat the session's Ask")
	} else {
		r.reply(parent, ask.ID, "reject")
	}

	child, mark := r.delegate(parent, "p4-child-marker", "p4-child.txt")
	ask, part := r.childOutcome(child, mark)
	if ask == nil {
		t.Fatalf("the subagent wrote without asking (%+v): the machine's allow reached it", part)
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

// P6b: an exception under a ceiling that tightens to ask. The exception is a rule
// galopin composes under the ceiling's tail, so re-applying the rules is enough —
// the next write asks even before the restart, which opencode's own in-memory
// "always" would have needed (canary 4 pins that behaviour of opencode).
func TestPassthroughP6bTightenedToAskCapsTheException(t *testing.T) {
	r := newPermRig(t, permRigOpts{file: map[string]any{"edit": "ask"}})
	s := r.session("p6b", "")
	ask, _, mark := r.try(s, "p6b-a.txt")
	if ask == nil {
		t.Fatal("no first ask")
	}
	r.reply(s, ask.ID, "always")
	r.idle(s, mark)
	if ask, part, _ := r.try(s, "p6b-b.txt"); ask != nil || part.ToolStatus != backend.ToolCompleted {
		t.Fatalf("the exception was not honoured: ask=%v part=%+v", ask, part)
	}

	ch := r.live.Tighten(policy.Permission{Max: map[string]string{"edit": "ask"}})
	if !ch.Tightened {
		t.Fatal("not tightened")
	}
	// Rules alone, no restart: the cap already holds.
	if err := r.oc.EnsureRules(r.ctx, r.work, s.ID); err != nil {
		t.Fatal(err)
	}
	ask, _, _ = r.try(s, "p6b-c.txt")
	if ask == nil {
		t.Fatal("the exception outlived a ceiling of ask: the tail does not cap it")
	}
	r.reply(s, ask.ID, "reject")

	r.mc.policyTightened(r.ctx, ch)
	ask, part, _ := r.try(s, "p6b-d.txt")
	if ask == nil {
		t.Fatalf("after the restart the write did not ask: %+v", part)
	}
	r.reply(s, ask.ID, "reject")
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
