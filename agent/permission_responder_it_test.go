package main

import (
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/policy"
	"galopin/internal/sessions"
)

// The auto-accept responder, live (PROTOCOL.md §6 "Auto-accept"): opencode's
// own auto mode — per session, "once", tool asks only, never questions — run by
// galopin where the panel may be closed, and following the nearest ancestor
// that has set it, subagents included.

func responders(rules, max map[string]string) policy.Permission {
	return policy.Permission{Responders: policy.TerminalAllowed, Rules: rules, Max: max}
}

func (r *permRig) responderRows() []map[string]any {
	var out []map[string]any
	for _, row := range r.auditRows() {
		if row["action"] == "permission" && row["by"] == "responder" {
			out = append(out, row)
		}
	}
	return out
}

// A deny asks nothing, so there is nothing for auto-accept to answer: no ask,
// no reply, no card — and the write is refused.
func TestResponderDenyWithAutoOnAsksNothing(t *testing.T) {
	r := newPermRig(t, permRigOpts{perm: responders(map[string]string{"edit": "deny"}, nil)})
	s := r.session("auto-deny", "")
	if err := r.mat.SetAutoAccept(s.ID, true); err != nil {
		t.Fatal(err)
	}
	ask, part, mark := r.try(s, "deny.txt")
	if ask != nil || !refused(part) || r.exists("deny.txt") {
		t.Fatalf("ask=%v part=%+v exists=%v; the deny should have refused it", ask, part, r.exists("deny.txt"))
	}
	r.idle(s, mark)
	if asks := r.asks(mark, s); len(asks) != 0 {
		t.Errorf("cards = %v, want none", asks)
	}
	if rows := r.responderRows(); len(rows) != 0 {
		t.Errorf("the responder replied to something: %v", rows)
	}
}

// An ask in an auto session is answered "once", with no card, and it is never
// remembered: auto-accept creates no saved approval.
func TestResponderAnswersOnceWithoutACardAndSavesNothing(t *testing.T) {
	r := newPermRig(t, permRigOpts{file: map[string]any{"edit": "ask"}, perm: responders(nil, nil)})
	s := r.session("auto-once", "")
	if err := r.mat.SetAutoAccept(s.ID, true); err != nil {
		t.Fatal(err)
	}
	ask, part, mark := r.try(s, "auto1.txt")
	if ask != nil {
		t.Fatalf("a card was shown for an auto session: %+v", ask)
	}
	if part.ToolStatus != backend.ToolCompleted || !r.exists("auto1.txt") {
		t.Fatalf("write = %+v exists=%v", part, r.exists("auto1.txt"))
	}
	r.idle(s, mark)
	rows := r.responderRows()
	if len(rows) != 1 || rows[0]["decision"] != "once" || rows[0]["tool"] != "edit" || rows[0]["session"] != s.ID {
		t.Fatalf("responder audit = %v, want one once on edit in this session", rows)
	}
	if saved := r.saved(); len(saved) != 0 {
		t.Errorf("saved approvals = %+v; auto-accept must never create one", saved)
	}
	// The same write again asks the responder again: nothing was remembered.
	_, _, mark2 := r.try(s, "auto1.txt")
	if len(r.asks(mark2, s)) != 0 {
		t.Error("a card appeared on the second write")
	}
	r.idle(s, mark2)
	if rows := r.responderRows(); len(rows) != 2 {
		t.Errorf("responder rows = %d after the second identical write, want 2 (an always would have made it 1)", len(rows))
	}

	// Switching it off puts the cards back.
	if err := r.mat.SetAutoAccept(s.ID, false); err != nil {
		t.Fatal(err)
	}
	ask, _, _ = r.try(s, "auto2.txt")
	if ask == nil {
		t.Fatal("auto-accept off, but the write was not asked")
	}
	r.reply(s, ask.ID, "reject")
}

// A question is never auto-answered, whatever the flag says.
func TestResponderNeverAnswersAQuestion(t *testing.T) {
	r := newPermRig(t, permRigOpts{perm: responders(nil, nil)})
	s := r.session("auto-question", "")
	if err := r.mat.SetAutoAccept(s.ID, true); err != nil {
		t.Fatal(err)
	}
	r.script(map[string]any{"toolCalls": []map[string]any{{
		"id": "call_q1", "name": "question",
		"arguments": `{"questions":[{"question":"Which approach?","header":"Approach","options":[{"label":"A","description":"Do A"},{"label":"B","description":"Do B"}],"multiple":false}]}`,
	}}})
	mark := r.hub.mark()
	if err := r.oc.Prompt(r.ctx, r.work, s.ID, backend.Prompt{Text: "ask me"}); err != nil {
		t.Fatal(err)
	}
	env := r.hub.wait(t, mark, 60*time.Second, "question.asked", func(e sessions.Envelope) bool {
		return e.SessionID == s.ID && e.Event.Kind == backend.EventQuestionAsked
	})
	time.Sleep(4 * time.Second)
	for _, e := range r.hub.since(mark) {
		if e.Event.Kind == backend.EventQuestionResolved {
			t.Fatalf("the question was resolved without anyone answering: %+v", e.Event)
		}
	}
	if n := len(r.mat.PendingQuestionRequests(s.ID)); n != 1 {
		t.Errorf("pending questions = %d, want 1", n)
	}
	if err := r.oc.RejectQuestion(r.ctx, r.work, s.ID, env.Event.QuestionRequestID); err != nil {
		t.Fatal(err)
	}
}

// A subagent explicitly turned off overrides a parent that is on: its ask
// shows as a card, and the parent's flag does not answer it.
func TestResponderChildExplicitlyOffOverridesParentOn(t *testing.T) {
	r := newPermRig(t, permRigOpts{file: map[string]any{"edit": "ask"}, perm: responders(nil, nil)})
	// Decided in the event loop, before the child's first ask can be handled.
	r.mat.OnChild(func(dir, id string) {
		_ = r.mat.SetAutoAccept(id, false)
		go r.mc.giveChildTheCeiling(dir, id)
	})
	parent := r.session("auto-parent", "")
	if err := r.mat.SetAutoAccept(parent.ID, true); err != nil {
		t.Fatal(err)
	}
	child, mark := r.delegate(parent, "off-child-marker", "off-child.txt")
	ask, part := r.childOutcome(child, mark)
	if ask == nil {
		t.Fatalf("the child was answered by its parent's flag (%+v) though it is explicitly off", part)
	}
	if r.mat.AutoAccept(child) {
		t.Error("the child reads as auto-accepting")
	}
	if rows := r.responderRows(); len(rows) != 0 {
		t.Errorf("responder rows = %v, want none", rows)
	}
	r.reply(backend.Session{ID: child}, ask.ID, "once")
	r.hub.toolDone(t, mark, child, "write")
}

// The Amendment: a subagent with no setting of its own follows its parent's
// "on". The responder answers its tool asks under the same caps as the
// parent's — once, no card, nothing saved.
func TestResponderChildWithNoSettingFollowsParentOn(t *testing.T) {
	r := newPermRig(t, permRigOpts{
		file: map[string]any{"edit": "ask"},
		perm: responders(nil, nil),
	})
	parent := r.session("auto-parent2", "")
	if err := r.mat.SetAutoAccept(parent.ID, true); err != nil {
		t.Fatal(err)
	}
	child, mark := r.delegate(parent, "follow-child-marker", "follow-child.txt")
	ask, part := r.childOutcome(child, mark)
	if ask != nil {
		t.Fatalf("the child's ask became a card (%+v): the parent's auto-accept did not reach it", ask)
	}
	if part.ToolStatus != backend.ToolCompleted || !r.exists("follow-child.txt") {
		t.Fatalf("child write = %+v exists=%v", part, r.exists("follow-child.txt"))
	}
	r.idle(parent, mark)
	rows := r.responderRows()
	if len(rows) != 1 || rows[0]["session"] != child || rows[0]["decision"] != "once" || rows[0]["tool"] != "edit" {
		t.Fatalf("responder audit = %v, want one once on edit in the child %s", rows, child)
	}
	if saved := r.saved(); len(saved) != 0 {
		t.Errorf("saved approvals = %+v, want none", saved)
	}
	if !r.mat.AutoAccept(child) {
		t.Error("the child's effective auto-accept should read on")
	}
}

// With the machine's consent withdrawn (policy.json tightened while running),
// the next ask in a session that was on is a card again.
func TestResponderStopsWhenTheMachineTurnsItOff(t *testing.T) {
	r := newPermRig(t, permRigOpts{file: map[string]any{"edit": "ask"}, perm: responders(nil, nil)})
	s := r.session("auto-off", "")
	if err := r.mat.SetAutoAccept(s.ID, true); err != nil {
		t.Fatal(err)
	}
	if ask, part, _ := r.try(s, "on.txt"); ask != nil || part.ToolStatus != backend.ToolCompleted {
		t.Fatalf("auto on: ask=%v part=%+v", ask, part)
	}
	ch := r.live.Tighten(policy.Permission{Responders: policy.TerminalDenied})
	if !ch.RespondersOff {
		t.Fatalf("change = %+v", ch)
	}
	r.mc.policyTightened(r.ctx, ch) // responders only: no restart
	if r.mat.AutoAccept(s.ID) {
		t.Error("the session still reads as auto-accepting on a machine that turned it off")
	}
	ask, _, _ := r.try(s, "off.txt")
	if ask == nil {
		t.Fatal("the write was not asked after the machine turned auto-accept off")
	}
	r.reply(s, ask.ID, "reject")
}

// The responder is limited by the ceiling: a key capped at ask is asked of a
// person even in an auto session — for the session itself and for a subagent
// following its parent — while an uncapped key beside it is answered.
func TestResponderLeavesCeilingCappedKeysToAPerson(t *testing.T) {
	r := newPermRig(t, permRigOpts{file: map[string]any{"edit": "ask", "bash": "ask"}, perm: responders(nil, map[string]string{"edit": "ask"})})
	s := r.session("auto-capped", "")
	if err := r.mat.SetAutoAccept(s.ID, true); err != nil {
		t.Fatal(err)
	}
	ask, _, mark := r.try(s, "capped.txt")
	if ask == nil {
		t.Fatal("the responder answered an edit ask under an ask ceiling")
	}
	if rows := r.responderRows(); len(rows) != 0 {
		t.Errorf("responder rows = %v, want none", rows)
	}
	r.reply(s, ask.ID, "once")
	r.idle(s, mark)

	// And a subagent under the same parent is asked too.
	child, mark2 := r.delegate(s, "capped-child-marker", "capped-child.txt")
	cask, _ := r.childOutcome(child, mark2)
	if cask == nil {
		t.Fatal("the child's edit ask under an ask ceiling was answered by its parent's flag")
	}
	r.reply(backend.Session{ID: child}, cask.ID, "once")
	r.hub.toolDone(t, mark2, child, "write")
}
