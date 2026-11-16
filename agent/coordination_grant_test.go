package main

import (
	"context"
	"reflect"
	"testing"

	"galopin/internal/backend"
	"galopin/internal/permrules"
)

func mustGrant(t *testing.T, r *coordRig, id string, keys any) {
	t.Helper()
	if _, operr := r.grant(id, keys); operr != nil {
		t.Fatalf("grant %v on %s: %v", keys, id, operr)
	}
}

func setWord(r *coordRig, mode permrules.Action, auto map[string]string) {
	sel := r.cb.sel["caller"]
	sel.Mode = mode
	if auto != nil {
		sel.Auto, sel.AutoClasses = true, auto
	}
	r.cb.sel["caller"] = sel
}

// session.grantCoordination is DEPRECATED and ignored: the same validation as
// before, but nothing is recorded and no decision reads it.
func TestGrantCoordinationIsAcceptedAndIgnored(t *testing.T) {
	r := newCoordRig(t, nil)
	for _, keys := range [][]string{{"bash"}, {"session_send", "edit"}, {"*"}, {""}} {
		if _, operr := r.grant("caller", keys); operr == nil || operr.Code != "invalid" {
			t.Errorf("keys %v: err = %v, want invalid", keys, operr)
		}
	}
	for _, raw := range []string{`{"sessionId":"caller"}`, `{"sessionId":"caller","keys":"session_send"}`} {
		if _, operr := r.mc.opSessionGrantCoordination(context.Background(), []byte(raw)); operr == nil || operr.Code != "invalid" {
			t.Errorf("%s = %v, want invalid", raw, operr)
		}
	}
	if _, operr := r.grant("ses_nope", []string{"session_send"}); operr == nil || operr.Code != "not_found" {
		t.Errorf("unknown session = %v, want not_found", operr)
	}
	res, operr := r.grant("caller", []string{"session_spawn", "session_read", "session_read"})
	if operr != nil {
		t.Fatal(operr)
	}
	if got := res.(map[string]any)["keys"]; !reflect.DeepEqual(got, []string{"session_read", "session_spawn"}) {
		t.Errorf("answer keys = %v, want sorted and de-duplicated", got)
	}
	if got := r.cb.Coordination("caller"); len(got) != 0 {
		t.Errorf("a grant was recorded: %v", got)
	}
	// And a granted key frees nothing: Ask still raises the card.
	r.say("peer", "assistant", "x", t0)
	if _, err := r.call("caller", "session_read", map[string]any{"target": "peer"}); err != nil {
		t.Fatal(err)
	}
	if n := len(r.asks()); n != 1 {
		t.Errorf("a deprecated grant freed a read: %d cards, want 1", n)
	}
	var rows []map[string]any
	for _, row := range r.audit() {
		if row["action"] == "session.grantCoordination" {
			rows = append(rows, row)
		}
	}
	last := rows[len(rows)-1]
	if last["outcome"] != "ignored" || last["session"] != "caller" {
		t.Errorf("audit row = %v, want outcome ignored", last)
	}
}

// permission.rules no longer carries a grant and the hello does not offer one.
func TestPermissionRulesAndHelloShowNoGrant(t *testing.T) {
	r := newCoordRig(t, nil)
	res, operr := r.mc.opPermissionRules(context.Background(), []byte(`{"sessionId":"caller"}`))
	if operr != nil {
		t.Fatal(operr)
	}
	if _, has := res.(map[string]any)["coordination"]; has {
		t.Error("permission.rules still reports a coordination grant")
	}
	hello := buildHello(r.cb, r.mc.pol)
	if hello.Backends[0].Capabilities["coordinationGrant"] {
		t.Error("hello must not advertise coordinationGrant")
	}
}

// The limits that stood over a grant stand over Allow: a local deny of agents,
// another workspace, the hop limit and the rate limit.
func TestCoordinationLimitsStandOnAllow(t *testing.T) {
	r := newCoordRig(t, withDeny("agents"))
	setWord(r, permrules.Allow, nil)
	r.say("peer", "user", "x", t0)
	_, err := r.call("caller", "session_read", map[string]any{"target": "peer"})
	refusedWith(t, err, "refused")

	r = newCoordRig(t, nil)
	setWord(r, permrules.Allow, nil)
	r.say("other", "user", "x", t0)
	if _, err := r.call("caller", "session_read", map[string]any{"target": "other"}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.call("caller", "session_send", map[string]any{"target": "other", "text": "hi"}); err != nil {
		t.Fatal(err)
	}
	if asks := r.asks(); len(asks) != 2 || asks[0].Tool != "session_read" || asks[1].Tool != "session_send" {
		t.Fatalf("cross-workspace asks = %+v, want a card each", asks)
	}

	r = newCoordRig(t, nil)
	setWord(r, permrules.Allow, nil)
	r.mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{WorkspaceDir: r.w1.Path, SessionID: "caller", Event: backend.Event{
		Kind: backend.EventMessage, Message: &backend.Message{ID: "m1", Role: "user", SentBy: &backend.MessageSender{SessionID: "peer", Hop: 3}},
	}})
	if _, err := r.call("caller", "session_send", map[string]any{"target": "peer", "text": "hi"}); err != nil {
		t.Fatal(err)
	}
	if asks := r.asks(); len(asks) != 1 || asks[0].Tool != "session_send" {
		t.Fatalf("a send at hop 4 asks; asks = %+v", asks)
	}

	r = newCoordRig(t, nil)
	setWord(r, permrules.Allow, nil)
	for i := 0; i < sendsPerWindow; i++ {
		if _, err := r.call("caller", "session_send", map[string]any{"target": "peer", "text": "hi"}); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	_, err = r.call("caller", "session_send", map[string]any{"target": "peer", "text": "hi"})
	refusedWith(t, err, "send rate limit")
}

// Coordination per word and per Agents row: Ask is a card, Auto follows the
// agents row (Runs runs; Reviewer and You are a card, which Cerea routes),
// Allow runs, Plan refuses; session_list never asks.
func TestCoordinationPerModeAndAgentsRow(t *testing.T) {
	cases := []struct {
		name     string
		mode     permrules.Action
		auto     map[string]string
		wantCard bool
		refused  bool
	}{
		{"ask", permrules.Ask, nil, true, false},
		{"auto, agents Runs", permrules.Ask, map[string]string{"agents": "run"}, false, false},
		{"auto, agents Reviewer", permrules.Ask, map[string]string{"agents": "ask"}, true, false},
		{"auto, agents You", permrules.Ask, map[string]string{"agents": "ask"}, true, false},
		{"allow", permrules.Allow, nil, false, false},
		{"plan", permrules.Deny, nil, false, true},
	}
	calls := map[string]map[string]any{
		"session_read":  {"target": "peer"},
		"session_send":  {"target": "peer", "text": "hi"},
		"session_spawn": {"title": "t", "prompt": "p", "mode": "inherit"},
	}
	for _, c := range cases {
		for tool, args := range calls {
			r := newCoordRig(t, nil)
			r.say("peer", "assistant", "x", t0)
			setWord(r, c.mode, c.auto)
			_, err := r.call("caller", tool, args)
			n := len(r.asks())
			name := c.name + "/" + tool
			switch {
			case c.refused:
				if err == nil || n != 0 {
					t.Errorf("%s: Plan must refuse with no card (err %v, asks %d)", name, err, n)
				}
			case c.wantCard:
				if n != 1 || r.asks()[0].Tool != tool {
					t.Errorf("%s: asks = %+v, want one %s card", name, r.asks(), tool)
				}
			default:
				if n != 0 {
					t.Errorf("%s: %d cards, want none", name, n)
				}
			}
		}
		r := newCoordRig(t, nil)
		setWord(r, c.mode, c.auto)
		_, err := r.call("caller", "session_list", map[string]any{"note": "x"})
		if len(r.asks()) != 0 || (err != nil && !c.refused) {
			t.Errorf("%s: session_list asked or failed: %v, %d cards", c.name, err, len(r.asks()))
		}
	}
}
