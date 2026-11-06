package main

import (
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/permrules"
	"galopin/internal/policy"
)

// P1: the owner's opencode.json says edit: deny. The file's deny is the owner's
// and stands (ADR 0097: the floor restates it, so opencode refuses natively and
// galopin is never asked), even under Allow: the write is refused with no card.
func TestPassthroughP1TheFilesDenyStands(t *testing.T) {
	r := newPermRig(t, permRigOpts{
		file: map[string]any{"edit": "deny"},
	})
	s := r.session("p1", "")
	r.setMode(s, "allow")
	ask, part, mark := r.try(s, "p1.txt")
	if ask != nil {
		t.Fatalf("asked for %s %v; the file's deny should have stood", ask.Tool, ask.Patterns)
	}
	if !refused(part) || r.exists("p1.txt") {
		t.Errorf("write = %s (%s), file exists=%v, want refused", part.ToolStatus, part.ToolError, r.exists("p1.txt"))
	}
	r.idle(s, mark)
	if asks := r.asks(mark, s); len(asks) != 0 {
		t.Errorf("asks = %v, want none", asks)
	}

	// Control: a second machine, same file, same answer.
	r2 := newPermRig(t, permRigOpts{file: map[string]any{"edit": "deny"}})
	s2 := r2.session("p1-control", "")
	r2.setMode(s2, "allow")
	ask, part, _ = r2.try(s2, "p1c.txt")
	if ask != nil || !refused(part) || r2.exists("p1c.txt") {
		t.Errorf("control: ask=%v part=%+v exists=%v; the file's deny should stand under Allow", ask, part, r2.exists("p1c.txt"))
	}
}

// P2: the file allows edit, the session is on Ask. Exactly one ask,
// which stays pending whatever the panel is doing; once lands the write,
// reject errors the tool.
func TestPassthroughP2AskStaysPendingAndAnswersLand(t *testing.T) {
	r := newPermRig(t, permRigOpts{
		file: map[string]any{"edit": "allow"},
	})
	s := r.session("p2", "")
	ask, _, mark := r.try(s, "p2a.txt")
	if ask == nil {
		t.Fatal("the write ran; galopin's Ask should have beaten the file's allow")
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

// P3: on Ask an edit asks. A human's "always" on that card is stored, scoped to the file of the ask and never opencode's `*`:
// the next write of that file runs, any other file asks.
func TestPassthroughP3AlwaysStoresForThatFileOnly(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	s := r.session("p3", "")
	// Nothing is written to the session: the selector is galopin's own state,
	// not opencode rules (ADR 0097).
	if rules := r.sessionRules(s.ID); len(rules) != 0 {
		t.Fatalf("session rules before the first prompt = %+v, want none", rules)
	}
	ask, _, mark := r.try(s, "p3a.txt")
	if ask == nil {
		t.Fatal("the write ran; the session's Ask should have asked")
	}
	r.reply(s, ask.ID, "always")
	r.idle(s, mark)
	if !r.exists("p3a.txt") {
		t.Fatal("the answer should have let this one write through")
	}
	ex := r.exceptions(s)
	if len(ex) != 1 || ex[0].Permission != "edit" || len(ex[0].Patterns) == 0 {
		t.Fatalf("exceptions = %+v, want one edit exception for the file", ex)
	}
	for _, p := range ex[0].Patterns {
		if strings.Trim(p, "*?/ ") == "" {
			t.Errorf("exception pattern %q matches every file", p)
		}
	}
	// The same file runs under the exception, another file asks.
	if ask, part, _ := r.try(s, "p3a.txt"); ask != nil || part.ToolStatus != backend.ToolCompleted {
		t.Fatalf("the same file did not run: ask=%v part=%+v", ask, part)
	}
	ask, _, mark = r.try(s, "p3b.txt")
	if ask == nil {
		t.Fatal("another file did not ask: the always covers more than its file")
	}
	r.reply(s, ask.ID, "reject")
	r.idle(s, mark)

	var stored bool
	for _, row := range r.auditRows() {
		if row["action"] == "permission" && row["decision"] == "always" && row["by"] == "user" && row["capped"] == nil {
			stored = true
		}
	}
	if !stored {
		t.Errorf("audit lacks the stored always: %v", r.auditRows())
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
	// Remembered: the next write of that file sails through without asking.
	if ask, part, _ := r.try(s, "p6a.txt"); ask != nil || part.ToolStatus != backend.ToolCompleted {
		t.Fatalf("the always was not honoured: ask=%v part=%+v", ask, part)
	}

	// Tighten through the same path the file watcher takes.
	ch := r.live.Tighten(policy.Permission{Deny: []string{"edit"}})
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
		restarted = restarted || (row["action"] == "permission.tightened" && row["restarted"] == false)
	}
	if !restarted {
		t.Error("the tightening was not audited (restarted:false: nothing restarts any more)")
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
	// A restart of opencode (a crash, an upgrade) kills what it held in memory.
	if err := r.oc.RestartForPolicy(r.ctx); err != nil {
		t.Fatal(err)
	}
	if n := r.mat.PendingPermissions(s.ID); n != 0 {
		t.Errorf("pending = %d after the restart, want the dead ask withdrawn", n)
	}
}

// P4: a subagent follows its root's word. The parent is on Ask, so it asks; so
// does the child, and no edit allow is among the child's own rules.
func TestPassthroughP4SubagentFollowsItsRootsAsk(t *testing.T) {
	r := newPermRig(t, permRigOpts{
		file: map[string]any{"edit": "ask"},
	})
	parent := r.session("p4", "")
	if ask, _, _ := r.try(parent, "p4-parent.txt"); ask == nil {
		t.Fatal("the parent wrote without asking on Ask")
	} else {
		r.reply(parent, ask.ID, "reject")
	}

	child, mark := r.delegate(parent, "p4-child-marker", "p4-child.txt")
	ask, part := r.childOutcome(child, mark)
	if ask == nil {
		t.Fatalf("the subagent wrote without asking (%+v): it follows its root's Ask", part)
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

// P5: the parent's session is on Plan (deny). A deny is the one thing a subagent
// does inherit: its write is refused with no card.
func TestPassthroughP5ParentDenyReachesTheSubagent(t *testing.T) {
	r := newPermRig(t, permRigOpts{
		file: map[string]any{"edit": "ask"},
	})
	parent := r.session("p5", "")
	r.setMode(parent, "deny")
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

// P6b: an exception under a local deny that arrives later. The deny beats the
// exception at the next ask, with no restart.
func TestPassthroughP6bALocalDenyBeatsTheException(t *testing.T) {
	r := newPermRig(t, permRigOpts{file: map[string]any{"edit": "ask"}})
	s := r.session("p6b", "")
	ask, _, mark := r.try(s, "p6b-a.txt")
	if ask == nil {
		t.Fatal("no first ask")
	}
	r.reply(s, ask.ID, "always")
	r.idle(s, mark)
	if ask, part, _ := r.try(s, "p6b-a.txt"); ask != nil || part.ToolStatus != backend.ToolCompleted {
		t.Fatalf("the exception was not honoured: ask=%v part=%+v", ask, part)
	}

	ch := r.live.Tighten(policy.Permission{Deny: []string{"edit"}})
	if !ch.Tightened {
		t.Fatal("not tightened")
	}
	// No rule and no restart: the next ask is decided under the new deny.
	ask, part, _ := r.try(s, "p6b-a.txt")
	if ask != nil {
		t.Fatalf("the exception outlived a local deny: asked %+v", ask)
	}
	if !refused(part) {
		t.Errorf("a denied class ran: %+v", part)
	}

	r.mc.policyTightened(r.ctx, ch)
}
