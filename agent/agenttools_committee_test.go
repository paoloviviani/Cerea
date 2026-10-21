package main

import (
	"context"
	"galopin/internal/permrules"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
)

// The committee recipe: N delegates answer one question; the spawner gets one
// combined message, or what arrived by the deadline.

type timers struct{ fns []func() }

func (ts *timers) after(_ time.Duration, f func()) { ts.fns = append(ts.fns, f) }

func committeeRig(t *testing.T) (*coordRig, *timers) {
	t.Helper()
	r := reportRig(t)
	ts := &timers{}
	r.mc.agentTools.afterFunc = ts.after
	return r, ts
}

func (r *coordRig) committee(args map[string]any) ([]string, map[string]any, error) {
	r.t.Helper()
	out, err := r.call("caller", "session_committee", args)
	if err != nil {
		return nil, nil, err
	}
	res := resultOf(r.t, out)
	var ids []string
	for _, s := range res["started"].([]any) {
		ids = append(ids, s.(map[string]any)["sessionId"].(string))
	}
	return ids, res, nil
}

func TestCommitteeGathersAllAnswersIntoOneMessage(t *testing.T) {
	r, _ := committeeRig(t)
	r.offer("pystino/fast", "pystino/deep")
	r.writeProfiles(`{"default":"deep","profiles":{"fast":{"model":"pystino/fast"},"deep":{"model":"pystino/deep"}}}`)
	ids, res, err := r.committee(map[string]any{"title": "Which db", "question": "Postgres or SQLite?", "profiles": []string{"fast", "", "deep"}})
	if err != nil || len(ids) != 3 {
		t.Fatalf("ids=%v err=%v", ids, err)
	}
	if res["timeoutMinutes"].(float64) != 15 {
		t.Errorf("default timeout = %v", res["timeoutMinutes"])
	}
	// "" is the default profile; each member runs on its profile's model.
	for i, want := range []string{"pystino/fast", "pystino/deep", "pystino/deep"} {
		if got := r.cb.created[i].ModelID; got != want {
			t.Errorf("member %d model = %q, want %q", i, got, want)
		}
	}
	// Every member got the same question.
	ps := r.prompts()
	for i, id := range ids {
		var text string
		for _, p := range ps {
			if p.session == id {
				text = p.prompt.Text
			}
		}
		if !strings.Contains(text, "Postgres or SQLite?") || !strings.Contains(text, "member ") {
			t.Errorf("member %d prompt = %q", i, text)
		}
	}
	r.finishTurn(ids[0], "Postgres.")
	r.finishTurn(ids[1], "SQLite.")
	if n := len(r.toCaller()); n != 0 {
		t.Fatalf("a partial committee delivered %d message(s) early", n)
	}
	r.finishTurn(ids[2], "Postgres, with a caveat.")
	got := r.toCaller()
	if len(got) != 1 {
		t.Fatalf("messages to the spawner = %d, want exactly one", len(got))
	}
	text := got[0].prompt.Text
	for _, want := range []string{`Committee "Which db": 3 of 3 members answered.`, "Postgres.", "SQLite.", "with a caveat"} {
		if !strings.Contains(text, want) {
			t.Errorf("combined message lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "time limit") {
		t.Errorf("a complete committee must not mention the time limit")
	}
	if len(r.mc.agentTools.reports.Groups) != 0 {
		t.Errorf("the group must be gone once delivered")
	}
}

func TestCommitteeTimeoutDeliversWhatArrived(t *testing.T) {
	r, ts := committeeRig(t)
	ids, _, err := r.committee(map[string]any{"title": "Q", "question": "?", "profiles": []string{"", ""}, "timeoutMinutes": 5})
	if err != nil {
		t.Fatal(err)
	}
	r.finishTurn(ids[0], "only me")
	if len(ts.fns) != 1 {
		t.Fatalf("timers armed = %d, want 1", len(ts.fns))
	}
	ts.fns[0]()
	got := r.toCaller()
	if len(got) != 1 {
		t.Fatalf("messages = %d", len(got))
	}
	text := got[0].prompt.Text
	if !strings.Contains(text, "1 of 2 members answered") || !strings.Contains(text, "only me") || !strings.Contains(text, "No answer yet from") || !strings.Contains(text, ids[1]) {
		t.Errorf("timeout message:\n%s", text)
	}
	// A late answer is not lost: it arrives on its own like any delegate's.
	r.callerTurn()
	r.finishTurn(ids[1], "late answer")
	if got := r.toCaller(); len(got) != 2 || !strings.Contains(got[1].prompt.Text, "late answer") {
		t.Errorf("late report: %d messages", len(got))
	}
	// The timer firing again (or after completion) does nothing.
	ts.fns[0]()
	if got := r.toCaller(); len(got) != 2 {
		t.Errorf("a second firing delivered again")
	}
}

func TestCommitteeTimerAfterCompletionIsHarmless(t *testing.T) {
	r, ts := committeeRig(t)
	ids, _, _ := r.committee(map[string]any{"title": "Q", "question": "?", "profiles": []string{"", ""}})
	r.finishTurn(ids[0], "a")
	r.finishTurn(ids[1], "b")
	ts.fns[0]()
	if got := r.toCaller(); len(got) != 1 {
		t.Errorf("messages = %d, want 1", len(got))
	}
}

func TestCommitteeFailedAndStoppedMembersDoNotHangIt(t *testing.T) {
	r, _ := committeeRig(t)
	ids, _, _ := r.committee(map[string]any{"title": "Q", "question": "?", "profiles": []string{"", "", ""}})
	// One fails.
	r.status(ids[0], backend.StatusBusy)
	r.ev(ids[0], backend.Event{Kind: backend.EventError, ErrorMessage: "provider down"})
	r.status(ids[0], backend.StatusIdle)
	// One is stopped by the person.
	r.status(ids[1], backend.StatusBusy)
	r.mc.agentTools.noteStopped(ids[1])
	r.status(ids[1], backend.StatusIdle)
	r.finishTurn(ids[2], "fine")
	got := r.toCaller()
	if len(got) != 1 {
		t.Fatalf("messages = %d", len(got))
	}
	for _, want := range []string{"3 of 3 members answered", "provider down", "was stopped", "fine"} {
		if !strings.Contains(got[0].prompt.Text, want) {
			t.Errorf("lacks %q:\n%s", want, got[0].prompt.Text)
		}
	}
}

func TestCommitteeApprovalNoticesAreNotHeld(t *testing.T) {
	r, _ := committeeRig(t)
	ids, _, _ := r.committee(map[string]any{"title": "Q", "question": "?", "profiles": []string{"", ""}})
	r.ev(ids[0], backend.Event{Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: "p1", SessionID: ids[0], Tool: "bash"}})
	got := r.toCaller()
	if len(got) != 1 || !strings.Contains(got[0].prompt.Text, "waiting for approval") {
		t.Fatalf("approval notice: %+v", got)
	}
}

func TestCommitteeBounds(t *testing.T) {
	r, _ := committeeRig(t)
	cases := map[string]map[string]any{
		"one member":      {"title": "Q", "question": "?", "profiles": []string{""}},
		"four members":    {"title": "Q", "question": "?", "profiles": []string{"", "", "", ""}},
		"no profiles":     {"title": "Q", "question": "?"},
		"no question":     {"title": "Q", "question": " ", "profiles": []string{"", ""}},
		"no title":        {"question": "?", "profiles": []string{"", ""}},
		"timeout too big": {"title": "Q", "question": "?", "profiles": []string{"", ""}, "timeoutMinutes": 61},
		"timeout <1":      {"title": "Q", "question": "?", "profiles": []string{"", ""}, "timeoutMinutes": 0.5},
		"unknown profile": {"title": "Q", "question": "?", "profiles": []string{"", "nope"}},
		"unknown arg":     {"title": "Q", "question": "?", "profiles": []string{"", ""}, "count": 2},
	}
	for name, args := range cases {
		if _, _, err := r.committee(args); err == nil {
			t.Errorf("%s: want a refusal", name)
		}
	}
	if len(r.cb.created) != 0 {
		t.Fatalf("a refused committee started %d session(s)", len(r.cb.created))
	}
}

func TestCommitteeRespectsSpawnLimitsAllOrNothing(t *testing.T) {
	r, _ := committeeRig(t)
	r.spawn(map[string]any{}) // one live delegate: a committee of 3 no longer fits
	n := len(r.cb.created)
	if _, _, err := r.committee(map[string]any{"title": "Q", "question": "?", "profiles": []string{"", "", ""}}); err == nil || !strings.Contains(err.Error(), "live spawn limit") {
		t.Fatalf("err = %v", err)
	}
	if len(r.cb.created) != n {
		t.Fatalf("a committee that does not fit must start nothing")
	}
	if _, _, err := r.committee(map[string]any{"title": "Q", "question": "?", "profiles": []string{"", ""}}); err != nil {
		t.Fatalf("two fit: %v", err)
	}
	// Rate: the window now holds 3 of 6; a committee of 3 more fits only
	// if the live limit lets it, so test the rate rule on its own.
	r2, _ := committeeRig(t)
	root := "caller"
	r2.mc.agentTools.mu.Lock()
	for i := 0; i < spawnsPerWindow-1; i++ {
		r2.mc.agentTools.spawnLog[root] = append(r2.mc.agentTools.spawnLog[root], time.Now())
	}
	r2.mc.agentTools.mu.Unlock()
	if _, _, err := r2.committee(map[string]any{"title": "Q", "question": "?", "profiles": []string{"", ""}}); err == nil || !strings.Contains(err.Error(), "rate limit") {
		t.Fatalf("err = %v", err)
	}
}

func TestCommitteeDeclinedCardStopsIt(t *testing.T) {
	r, _ := committeeRig(t)
	r.cb.answer = func(backend.PermissionRequest) (backend.Decision, string) { return backend.DecisionReject, "no" }
	if _, _, err := r.committee(map[string]any{"title": "Q", "question": "?", "profiles": []string{"", ""}}); err == nil {
		t.Fatal("want a refusal")
	}
	if len(r.asks()) != 1 || len(r.cb.created) != 0 {
		t.Fatalf("asks = %d created = %d: a declined first member must stop the rest", len(r.asks()), len(r.cb.created))
	}
	if len(r.mc.agentTools.reports.Groups) != 0 {
		t.Fatal("no group must remain")
	}
}

func TestCommitteeAskRaisesOneCardPerMember(t *testing.T) {
	r, _ := committeeRig(t)
	r.offer("pystino/fast")
	r.writeProfiles(`{"profiles":{"fast":{"model":"pystino/fast"}}}`)
	if _, _, err := r.committee(map[string]any{"title": "Q", "question": "?", "profiles": []string{"", "fast"}}); err != nil {
		t.Fatal(err)
	}
	a := r.asks()
	if len(a) != 2 || a[0].Tool != "session_spawn" || a[1].Metadata["committee"] == nil {
		t.Fatalf("asks = %+v", a)
	}
}

func TestCommitteeAllowCallerNoCardsAndMembersKeepTheCallersWord(t *testing.T) {
	r, _ := committeeRig(t)
	allowCaller(t, r)
	ids, _, err := r.committee(map[string]any{"title": "Q", "question": "?", "profiles": []string{"", ""}})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.asks()) != 0 {
		t.Errorf("an Allow caller's committee raised cards: %+v", r.asks())
	}
	for _, id := range ids {
		if got := string(r.cb.PermissionMode(id)); got != "allow" {
			t.Errorf("member word = %s, want the caller's", got)
		}
	}
}

func TestCommitteeModePlanIsPassedToEveryMember(t *testing.T) {
	r, _ := committeeRig(t)
	r.cb.modes = []backend.Mode{{ID: "plan"}, {ID: "build"}}
	_, _, err := r.committee(map[string]any{"title": "Q", "question": "?", "profiles": []string{"", ""}, "mode": "plan"})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.cb.created) != 2 {
		t.Fatalf("created %d", len(r.cb.created))
	}
	for _, c := range r.cb.created {
		if c.ModeID != "plan" {
			t.Errorf("member mode = %q", c.ModeID)
		}
	}
	if _, _, err := r.committee(map[string]any{"title": "Q", "question": "?", "profiles": []string{"", ""}, "mode": 3}); err == nil {
		t.Error("a non-string mode must be refused")
	}
}

func TestCommitteeSurvivesARestart(t *testing.T) {
	r, _ := committeeRig(t)
	ids, _, _ := r.committee(map[string]any{"title": "Q", "question": "?", "profiles": []string{"", ""}})
	r.finishTurn(ids[0], "first")
	// A new process reads the state back and re-arms the deadline.
	at2 := newAgentTools(r.mc, r.mc.agentTools.host)
	ts2 := &timers{}
	at2.afterFunc = ts2.after
	at2.async = func(f func()) { f() }
	at2.attachState(r.stateDir)
	at2.resumeGroups()
	if len(at2.reports.Groups) != 1 || len(ts2.fns) != 1 {
		t.Fatalf("groups = %d timers = %d", len(at2.reports.Groups), len(ts2.fns))
	}
	r.mc.agentTools = at2
	r.finishTurn(ids[1], "second") // absorbed through the reloaded state
	got := r.toCaller()
	if len(got) != 1 || !strings.Contains(got[0].prompt.Text, "first") || !strings.Contains(got[0].prompt.Text, "second") {
		t.Fatalf("after restart: %+v", got)
	}
}

func TestPlanCallerCannotConveneACommittee(t *testing.T) {
	r, _ := committeeRig(t)
	_ = r.cb.SetPermissionMode(context.Background(), "", "caller", permrules.Deny)
	if _, _, err := r.committee(map[string]any{"title": "Q", "question": "?", "profiles": []string{"", ""}}); err == nil {
		t.Fatal("a Plan session must not convene a committee")
	}
}
