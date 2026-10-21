package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"galopin/internal/backend"
)

// Issue 23: stopping a session makes opencode cancel its background
// subagents without telling the parent. galopin tells it once.

// bgTask plays the parent's task call that started child, with background on
// or off, and the child's tree edge.
func (r *coordRig) bgTask(parent, child, desc string, background bool) {
	r.t.Helper()
	r.addSession(r.w1, child, "kid "+child, parent)
	r.ev(parent, backend.Event{Kind: backend.EventPart, Part: &backend.Part{
		ID: "tp_" + child, MessageID: parent + "_tm", Role: "assistant", Type: backend.PartTool,
		Tool: "task", CallID: "c_" + child, ToolStatus: backend.ToolRunning, SubtaskSessionID: child,
		Input: map[string]any{"description": desc, "background": background},
	}})
}

// abort plays the end of an in-flight turn cut short by a Stop.
func (r *coordRig) abort(id, msgID string) {
	r.t.Helper()
	r.ev(id, backend.Event{Kind: backend.EventMessage, Message: &backend.Message{ID: msgID, Role: "assistant", Aborted: true}})
}

func TestStopTellsTheParentWhichBackgroundTasksWereCancelled(t *testing.T) {
	r := reportRig(t)
	r.bgTask("caller", "kidA", "scan the repo", true)
	r.bgTask("caller", "kidB", "write docs", true)
	r.bgTask("caller", "kidC", "foreground thing", false)
	r.bgTask("caller", "kidD", "already done", true)
	r.mc.agentTools.cancelWait = 0
	r.mc.agentTools.async = func(f func()) {} // the batch is flushed by hand below
	r.status("caller", backend.StatusBusy)
	r.abort("caller", "caller_a1")
	r.status("kidD", backend.StatusBusy)
	r.say("kidD", "assistant", "finished before the stop", t0)
	r.status("kidD", backend.StatusIdle)
	r.abort("kidA", "a1")
	r.abort("kidB", "b1")
	r.abort("kidC", "c1")
	r.abort("kidA", "a1") // a replayed event
	r.mc.agentTools.async = func(f func()) { f() }
	r.mc.agentTools.flushCancelled("caller")
	r.status("caller", backend.StatusIdle)
	// The person pressed Stop: galopin sends the parent nothing on its own.
	if got := r.toCaller(); len(got) != 0 {
		t.Fatalf("galopin woke the stopped parent: %+v", got)
	}
	want := "Stopping this turn also cancelled 2 background tasks; they did not finish: scan the repo (kidA), write docs (kidB)."
	// A replay never tells twice.
	r.abort("kidA", "a1")
	r.mc.agentTools.flushCancelled("caller")

	// A restart in between keeps the held note.
	at2 := newAgentTools(r.mc, r.mc.agentTools.host)
	at2.async = func(f func()) { f() }
	at2.attachState(r.stateDir)
	r.mc.agentTools = at2

	// The person's next prompt carries it, once.
	r.userPrompt("caller", "carry on")
	r.userPrompt("caller", "and again")
	got := r.toCaller()
	if len(got) != 2 {
		t.Fatalf("prompts to the parent = %d, want the person's two", len(got))
	}
	if got[0].prompt.Text != "carry on" || !strings.Contains(got[0].prompt.Preface, want) || !strings.Contains(got[0].prompt.Preface, "not from your person") {
		t.Errorf("first prompt = %+v, want the note in its preface", got[0].prompt)
	}
	if got[1].prompt.Preface != "" {
		t.Errorf("the note was delivered twice: %q", got[1].prompt.Preface)
	}
}

func (r *coordRig) userPrompt(id, text string) {
	r.t.Helper()
	raw, _ := json.Marshal(map[string]any{"sessionId": id, "text": text})
	if _, operr := r.mc.opSessionPrompt(context.Background(), raw); operr != nil {
		r.t.Fatal(operr)
	}
}

func TestCancelledNoteWaitsForTheBusyParentAndSurvivesARestart(t *testing.T) {
	r := reportRig(t)
	r.bgTask("caller", "kidA", "scan", true)
	r.mc.agentTools.cancelWait = 0
	r.status("caller", backend.StatusBusy)
	r.abort("kidA", "a1")
	if n := len(r.toCaller()); n != 0 {
		t.Fatalf("delivered into a running turn: %d", n)
	}
	if got := r.mc.agentTools.queuedFor("caller"); got != 1 {
		t.Fatalf("queued = %d, want 1", got)
	}
	// A new process: the note is in the persisted queue, and the child's
	// abort is remembered, so a replay does not tell twice.
	at2 := newAgentTools(r.mc, r.mc.agentTools.host)
	at2.async = func(f func()) { f() }
	at2.cancelWait = 0
	at2.attachState(r.stateDir)
	r.mc.agentTools = at2
	r.abort("kidA", "a1")
	if at2.queuedFor("caller") != 1 {
		t.Fatalf("replay after restart queued again: %d", at2.queuedFor("caller"))
	}
	r.status("caller", backend.StatusIdle)
	pr := r.toCaller()
	if len(pr) != 1 || !strings.Contains(pr[0].prompt.Text, "1 background task was stopped before finishing: scan (kidA)") {
		t.Fatalf("after restart: %+v", pr)
	}
}

func TestAbortedSubagentIsCancelledOnTheSessionRow(t *testing.T) {
	r := reportRig(t)
	r.mc.agentTools.cancelWait = 0
	r.bgTask("caller", "kidA", "scan", true)
	r.status("kidA", backend.StatusBusy)
	r.abort("kidA", "a1")
	r.status("kidA", backend.StatusIdle)
	row := func() backend.Session {
		r.cb.mu.Lock()
		sess := r.cb.sessions["kidA"]
		r.cb.mu.Unlock()
		return r.mc.enrich(sess, r.w1.ID)
	}
	if !row().Cancelled {
		t.Errorf("an aborted idle child: Cancelled = false")
	}
	r.status("kidA", backend.StatusBusy)
	if row().Cancelled {
		t.Errorf("a child running again is still Cancelled")
	}
	r.status("kidA", backend.StatusIdle)
	r.ev("kidA", backend.Event{Kind: backend.EventMessage, Message: &backend.Message{ID: "a2", Role: "assistant"}})
	if row().Cancelled {
		t.Errorf("a child that then finished is still Cancelled")
	}
}
