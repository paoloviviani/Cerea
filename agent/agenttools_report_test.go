package main

import (
	"context"
	"strings"
	"testing"

	"galopin/internal/backend"
)

// Report-back (ADR 0099): when a delegate finishes a turn its spawner started,
// galopin delivers the final assistant message to the spawner as an attributed
// message. Notices for an error and for a card waiting. Queued while the
// spawner is busy, persisted across a restart, dropped when it is gone.

// reportRig is a coordRig whose report work runs inline.
func reportRig(t *testing.T) *coordRig {
	t.Helper()
	r := newCoordRig(t, nil)
	r.mc.agentTools.async = func(f func()) { f() }
	return r
}

// ev plays one backend event for a session through the materializer and into
// the report observer, as forwardEvents does in production.
func (r *coordRig) ev(id string, e backend.Event) {
	r.t.Helper()
	dir, _, operr := r.mc.resolveSession(id)
	if operr != nil {
		r.t.Fatal(operr)
	}
	r.mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{WorkspaceDir: dir, SessionID: id, Event: e})
	for {
		select {
		case env := <-r.mc.mat.Events():
			r.mc.agentTools.observe(env)
		default:
			return
		}
	}
}

func (r *coordRig) status(id string, s backend.SessionStatus) {
	r.t.Helper()
	r.ev(id, backend.Event{Kind: backend.EventStatus, Status: s})
}

// finishTurn plays a delegate's turn: busy, a final assistant message, idle.
func (r *coordRig) finishTurn(id, final string) {
	r.t.Helper()
	r.status(id, backend.StatusBusy)
	r.say(id, "assistant", final, t0)
	r.status(id, backend.StatusIdle)
}

// callerTurn plays the spawner's own turn answering what was delivered to it.
func (r *coordRig) callerTurn() {
	r.t.Helper()
	r.status("caller", backend.StatusBusy)
	r.status("caller", backend.StatusIdle)
}

func (r *coordRig) spawn(args map[string]any) string {
	r.t.Helper()
	if args["title"] == nil {
		args["title"] = "Fixer"
	}
	if args["prompt"] == nil {
		args["prompt"] = "fix the parser"
	}
	out, err := r.call("caller", "session_spawn", args)
	if err != nil {
		r.t.Fatal(err)
	}
	i := strings.Index(out, `"sessionId":"`)
	if i < 0 {
		r.t.Fatalf("no sessionId in %q", out)
	}
	rest := out[i+len(`"sessionId":"`):]
	return rest[:strings.Index(rest, `"`)]
}

// toCaller is the prompts galopin delivered to the spawner (not the spawn's
// own prompt to the child).
func (r *coordRig) toCaller() []coordPrompt {
	var out []coordPrompt
	for _, p := range r.prompts() {
		if p.session == "caller" {
			out = append(out, p)
		}
	}
	return out
}

func TestDelegateReportsItsFinalMessage(t *testing.T) {
	r := reportRig(t)
	child := r.spawn(map[string]any{})
	r.finishTurn(child, "Parser fixed; tests pass.")
	got := r.toCaller()
	if len(got) != 1 {
		t.Fatalf("prompts to the spawner = %d, want 1", len(got))
	}
	p := got[0].prompt
	if !strings.Contains(p.Text, "Report from Fixer (session "+child+")") || !strings.Contains(p.Text, "Parser fixed; tests pass.") {
		t.Errorf("report text = %q", p.Text)
	}
	if p.SentBy == nil || p.SentBy.SessionID != child || p.SentBy.Hop != 0 {
		t.Errorf("SentBy = %+v, want the delegate at hop 0 (a report is not a hop)", p.SentBy)
	}
	if !strings.Contains(p.Preface, "not") || !strings.Contains(p.Preface, "person") {
		t.Errorf("preface = %q, want it to say it is not the person", p.Preface)
	}
	if a := r.asks(); len(a) > 1 { // the spawn's own card at most
		t.Errorf("the report raised cards: %+v", a)
	}
}

func TestReportFalseIsFireAndForget(t *testing.T) {
	r := reportRig(t)
	child := r.spawn(map[string]any{"report": false})
	r.finishTurn(child, "done")
	if n := len(r.toCaller()); n != 0 {
		t.Fatalf("report:false delivered %d prompts", n)
	}
}

func TestOnlySpawnerStartedTurnsAreReported(t *testing.T) {
	r := reportRig(t)
	child := r.spawn(map[string]any{})
	r.finishTurn(child, "first")
	if n := len(r.toCaller()); n != 1 {
		t.Fatalf("first turn: %d reports, want 1", n)
	}
	r.callerTurn()
	// The person types in the delegate: nothing reaches the spawner, neither
	// a report nor an error nor an approval notice.
	r.status(child, backend.StatusBusy)
	r.ev(child, backend.Event{Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: "perm1", SessionID: child, Tool: "bash"}})
	r.ev(child, backend.Event{Kind: backend.EventError, ErrorMessage: "boom"})
	r.status(child, backend.StatusIdle)
	if n := len(r.toCaller()); n != 1 {
		t.Fatalf("person-started turn leaked: %d prompts to the spawner, want 1", n)
	}
	// The spawner's own send starts a reportable turn again.
	if _, err := r.call("caller", "session_send", map[string]any{"target": child, "text": "now the tests"}); err != nil {
		t.Fatal(err)
	}
	r.finishTurn(child, "tests done")
	if n := len(r.toCaller()); n != 2 {
		t.Fatalf("after the spawner's send: %d prompts, want 2", n)
	}
}

func TestErrorAndApprovalNotices(t *testing.T) {
	r := reportRig(t)
	child := r.spawn(map[string]any{})
	r.status(child, backend.StatusBusy)
	ask := &backend.PermissionRequest{ID: "perm1", SessionID: child, Tool: "bash"}
	r.ev(child, backend.Event{Kind: backend.EventPermissionAsked, Request: ask})
	r.ev(child, backend.Event{Kind: backend.EventPermissionAsked, Request: ask}) // a repeat is one notice
	got := r.toCaller()
	if len(got) != 1 || !strings.Contains(got[0].prompt.Text, "Fixer is waiting for approval: bash") {
		t.Fatalf("approval notice = %+v", got)
	}
	r.callerTurn()
	r.ev(child, backend.Event{Kind: backend.EventError, ErrorMessage: "provider down"})
	r.status(child, backend.StatusIdle)
	got = r.toCaller()
	if len(got) != 2 || !strings.Contains(got[1].prompt.Text, "provider down") || strings.Contains(got[1].prompt.Text, "Report from") {
		t.Fatalf("error notice = %+v", got)
	}
}

func TestStoppedTurnIsNotReported(t *testing.T) {
	r := reportRig(t)
	child := r.spawn(map[string]any{})
	r.status(child, backend.StatusBusy)
	r.mc.agentTools.noteStopped(child)
	r.say(child, "assistant", "half", t0)
	r.status(child, backend.StatusIdle)
	if n := len(r.toCaller()); n != 0 {
		t.Fatalf("a stopped turn produced %d prompts", n)
	}
}

func TestReportWaitsForABusySpawner(t *testing.T) {
	r := reportRig(t)
	child := r.spawn(map[string]any{})
	r.status("caller", backend.StatusBusy)
	r.finishTurn(child, "result one")
	if n := len(r.toCaller()); n != 0 {
		t.Fatalf("delivered into a running turn: %d", n)
	}
	r.status("caller", backend.StatusIdle)
	got := r.toCaller()
	if len(got) != 1 || !strings.Contains(got[0].prompt.Text, "result one") {
		t.Fatalf("after idle: %+v", got)
	}
}

func TestQueuedReportsGoOutAsOneMessage(t *testing.T) {
	r := reportRig(t)
	a := r.spawn(map[string]any{"title": "A"})
	b := r.spawn(map[string]any{"title": "B"})
	r.status("caller", backend.StatusBusy)
	r.finishTurn(a, "from a")
	r.finishTurn(b, "from b")
	r.status("caller", backend.StatusIdle)
	got := r.toCaller()
	if len(got) != 1 || !strings.Contains(got[0].prompt.Text, "from a") || !strings.Contains(got[0].prompt.Text, "from b") {
		t.Fatalf("want one combined message, got %+v", got)
	}
}

func TestQueuedReportSurvivesARestart(t *testing.T) {
	r := reportRig(t)
	child := r.spawn(map[string]any{})
	r.status("caller", backend.StatusBusy)
	r.finishTurn(child, "survives")

	// A new process: the same state directory, fresh in-memory state.
	at2 := newAgentTools(r.mc, r.mc.agentTools.host)
	at2.async = func(f func()) { f() }
	at2.attachState(r.stateDir)
	r.mc.agentTools = at2
	r.status("caller", backend.StatusIdle)
	got := r.toCaller()
	if len(got) != 1 || !strings.Contains(got[0].prompt.Text, "survives") {
		t.Fatalf("after restart: %+v", got)
	}
}

func TestTurnFinishedWhileDownIsRecovered(t *testing.T) {
	r := reportRig(t)
	child := r.spawn(map[string]any{})
	// galopin was down: the child finished, no event was seen.
	r.say(child, "assistant", "finished in the dark", t0)
	at2 := newAgentTools(r.mc, r.mc.agentTools.host)
	at2.async = func(f func()) { f() }
	at2.attachState(r.stateDir)
	r.mc.agentTools = at2
	at2.recover(context.Background())
	got := r.toCaller()
	if len(got) != 1 || !strings.Contains(got[0].prompt.Text, "finished in the dark") {
		t.Fatalf("recovered report: %+v", got)
	}
	// And only once.
	at2.recover(context.Background())
	if n := len(r.toCaller()); n != 1 {
		t.Fatalf("recovery repeated: %d", n)
	}
}

func TestReportToAnArchivedSpawnerIsDropped(t *testing.T) {
	r := reportRig(t)
	child := r.spawn(map[string]any{})
	r.cb.mu.Lock()
	delete(r.cb.sessions, "caller")
	r.cb.mu.Unlock()
	r.finishTurn(child, "nobody home")
	if n := len(r.toCaller()); n != 0 {
		t.Fatalf("delivered to a gone spawner: %d", n)
	}
	if q := r.mc.agentTools.queuedFor("caller"); q != 0 {
		t.Fatalf("queue holds %d items for a gone spawner", q)
	}
}

// A spawner that answers every report by messaging its delegate again cannot
// loop past the existing limits: the pair's send rate stops it, and a report is
// never a hop.
func TestReportPingPongIsBounded(t *testing.T) {
	r := reportRig(t)
	child := r.spawn(map[string]any{})
	reports, sends := 0, 0
	r.finishTurn(child, "round 0")
	r.callerTurn()
	for i := 1; i <= 30; i++ {
		got := len(r.toCaller())
		if got <= reports {
			break // no new report: the loop has stopped
		}
		reports = got
		if _, err := r.call("caller", "session_send", map[string]any{"target": child, "text": "again"}); err != nil {
			break // refused by the rate limit
		}
		sends++
		r.callerTurn()
		r.finishTurn(child, "round")
		r.callerTurn()
	}
	if sends > sendsPerWindow {
		t.Fatalf("%d sends in one window, limit %d", sends, sendsPerWindow)
	}
	if reports > sendsPerWindow+1 {
		t.Fatalf("%d reports, want at most %d", reports, sendsPerWindow+1)
	}
	for _, p := range r.toCaller() {
		if p.prompt.SentBy.Hop != 0 {
			t.Fatalf("a report carried hop %d", p.prompt.SentBy.Hop)
		}
	}
}
