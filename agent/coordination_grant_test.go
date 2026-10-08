package main

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"galopin/internal/backend"
	"galopin/internal/policy"
)

func mustGrant(t *testing.T, r *coordRig, id string, keys any) {
	t.Helper()
	if _, operr := r.grant(id, keys); operr != nil {
		t.Fatalf("grant %v on %s: %v", keys, id, operr)
	}
}

// Only the four coordination keys are accepted: anything else is `invalid` and
// records nothing.
func TestGrantCoordinationKeyAllowlist(t *testing.T) {
	r := newCoordRig(t, nil)
	for _, keys := range [][]string{{"bash"}, {"session_send", "edit"}, {"*"}, {"session_*"}, {"task"}, {""}, {"external_directory"}} {
		_, operr := r.grant("caller", keys)
		if operr == nil || operr.Code != "invalid" {
			t.Errorf("keys %v: err = %v, want invalid", keys, operr)
		}
	}
	if got := r.cb.Coordination("caller"); len(got) != 0 {
		t.Errorf("a refused grant recorded %v", got)
	}
	// keys is required (an empty list clears), and must be a list.
	raw := []byte(`{"sessionId":"caller"}`)
	if _, operr := r.mc.opSessionGrantCoordination(context.Background(), raw); operr == nil || operr.Code != "invalid" {
		t.Errorf("missing keys = %v, want invalid", operr)
	}
	raw = []byte(`{"sessionId":"caller","keys":"session_send"}`)
	if _, operr := r.mc.opSessionGrantCoordination(context.Background(), raw); operr == nil || operr.Code != "invalid" {
		t.Errorf("keys as a string = %v, want invalid", operr)
	}
	res, operr := r.grant("caller", []string{"session_spawn", "session_read", "session_read"})
	if operr != nil {
		t.Fatal(operr)
	}
	if got := res.(map[string]any)["keys"]; !reflect.DeepEqual(got, []string{"session_read", "session_spawn"}) {
		t.Errorf("answer keys = %v, want sorted and de-duplicated", got)
	}
}

func TestGrantCoordinationRefusals(t *testing.T) {
	r := newCoordRig(t, nil)
	if _, operr := r.grant("ses_nope", []string{"session_send"}); operr == nil || operr.Code != "not_found" {
		t.Errorf("unknown session = %v, want not_found", operr)
	}
	r.addSession(r.w1, "kid", "Kid", "caller")
	if _, operr := r.grant("kid", []string{"session_send"}); operr == nil || operr.Code != "invalid" || !strings.Contains(operr.Message, "caller") {
		t.Errorf("a subagent = %v, want invalid naming its root", operr)
	}
	// A machine that installed no agent tools has nothing to grant.
	r.mc.agentTools = nil
	if _, operr := r.grant("caller", []string{"session_send"}); operr == nil || operr.Code != "unsupported" {
		t.Errorf("no agent tools = %v, want unsupported", operr)
	}
}

// The point of the op: a granted session reads another's text and messages it
// with no card, and the same calls ask on a session nobody granted.
func TestGrantedSessionReadsAndSendsWithoutACard(t *testing.T) {
	r := newCoordRig(t, nil)
	r.say("peer", "assistant", "build is green", t0)
	mustGrant(t, r, "caller", []string{"session_list", "session_read", "session_send"})

	out, err := r.call("caller", "session_read", map[string]any{"target": "peer"})
	if err != nil || !strings.Contains(out, "build is green") {
		t.Fatalf("read: %v %q", err, out)
	}
	res, err := r.call("caller", "session_send", map[string]any{"target": "peer", "text": "thanks, ship it"})
	if err != nil || res != `{"autoApproved":true}` {
		t.Fatalf("send: %v %q", err, res)
	}
	if _, err := r.call("caller", "session_list", map[string]any{"note": "x"}); err != nil {
		t.Fatal(err)
	}
	if n := len(r.asks()); n != 0 {
		t.Fatalf("a granted session raised %d cards: %+v", n, r.asks())
	}
	ps := r.prompts()
	if len(ps) != 1 || ps[0].session != "peer" || ps[0].prompt.Text != "thanks, ship it" || ps[0].prompt.SentBy == nil {
		t.Errorf("prompts = %+v, want the one message to peer", ps)
	}

	// The key not granted still asks.
	if _, err := r.call("caller", "session_spawn", map[string]any{"title": "t", "prompt": "p", "mode": "inherit"}); err == nil {
		// spawn needs CreateSession, which the rig does not provide: it must have
		// reached the card (the rig answers once) before failing there.
		t.Log("spawn unexpectedly succeeded")
	}
	if asks := r.asks(); len(asks) != 1 || asks[0].Tool != "session_spawn" {
		t.Errorf("asks = %+v, want a card for the key that was not granted", asks)
	}

	// A session nobody granted asks for the same read.
	if _, err := r.call("peer", "session_read", map[string]any{"target": "other"}); err != nil {
		t.Fatal(err)
	}
	if asks := r.asks(); asks[len(asks)-1].Tool != "session_read" {
		t.Errorf("asks = %+v, want a read card from the ungranted session", asks)
	}
}

// A grant is never more than the machine's ceiling, the cross-workspace rule,
// the hop limit or the rate limit.
func TestGrantNeverExceedsTheCeilingWorkspaceHopOrRate(t *testing.T) {
	// The ceiling caps send at ask and deny for read.
	r := newCoordRig(t, func(p *policy.Policy) {
		withMax("session_send", "ask")(p)
		withMax("session_read", "deny")(p)
	})
	r.say("peer", "user", "x", t0)
	mustGrant(t, r, "caller", []string{"session_read", "session_send"})
	_, err := r.call("caller", "session_read", map[string]any{"target": "peer"})
	refusedWith(t, err, "do not allow session_read")
	if _, err := r.call("caller", "session_send", map[string]any{"target": "peer", "text": "hi"}); err != nil {
		t.Fatal(err)
	}
	if asks := r.asks(); len(asks) != 1 || asks[0].Tool != "session_send" {
		t.Fatalf("a key the ceiling caps at ask must still raise a card; asks = %+v", asks)
	}

	// Cross-workspace: send and read to another workspace still ask.
	r = newCoordRig(t, nil)
	r.say("other", "user", "x", t0)
	mustGrant(t, r, "caller", []string{"session_read", "session_send"})
	if _, err := r.call("caller", "session_read", map[string]any{"target": "other"}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.call("caller", "session_send", map[string]any{"target": "other", "text": "hi"}); err != nil {
		t.Fatal(err)
	}
	asks := r.asks()
	if len(asks) != 2 || asks[0].Tool != "session_read" || asks[1].Tool != "session_send" {
		t.Fatalf("cross-workspace asks = %+v, want a card each", asks)
	}

	// Hop: a send past hop 3 asks even in the same workspace.
	r = newCoordRig(t, nil)
	mustGrant(t, r, "caller", []string{"session_send"})
	r.mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{WorkspaceDir: r.w1.Path, SessionID: "caller", Event: backend.Event{
		Kind: backend.EventMessage, Message: &backend.Message{ID: "m1", Role: "user", SentBy: &backend.MessageSender{SessionID: "peer", Hop: 3}},
	}})
	if _, err := r.call("caller", "session_send", map[string]any{"target": "peer", "text": "hi"}); err != nil {
		t.Fatal(err)
	}
	if asks := r.asks(); len(asks) != 1 || asks[0].Tool != "session_send" {
		t.Fatalf("a send at hop 4 asks despite the grant; asks = %+v", asks)
	}

	// Rate: the sixth send in a minute is refused.
	r = newCoordRig(t, nil)
	mustGrant(t, r, "caller", []string{"session_send"})
	for i := 0; i < sendsPerWindow; i++ {
		if _, err := r.call("caller", "session_send", map[string]any{"target": "peer", "text": "hi"}); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	_, err = r.call("caller", "session_send", map[string]any{"target": "peer", "text": "hi"})
	refusedWith(t, err, "send rate limit")
}

// `keys: []` clears the grant: the next call asks again. Deny keeps it but wins.
func TestGrantCoordinationClearsAndYieldsToDeny(t *testing.T) {
	r := newCoordRig(t, nil)
	r.say("peer", "user", "x", t0)
	mustGrant(t, r, "caller", []string{"session_read"})
	if _, err := r.call("caller", "session_read", map[string]any{"target": "peer"}); err != nil || len(r.asks()) != 0 {
		t.Fatalf("granted read: %v asks=%d", err, len(r.asks()))
	}
	mustGrant(t, r, "caller", []string{})
	if got := r.cb.Coordination("caller"); len(got) != 0 {
		t.Errorf("after clearing: %v", got)
	}
	if _, err := r.call("caller", "session_read", map[string]any{"target": "peer"}); err != nil {
		t.Fatal(err)
	}
	if len(r.asks()) != 1 {
		t.Errorf("a cleared grant must ask again; asks = %d", len(r.asks()))
	}
	// Deny wins over a kept grant.
	mustGrant(t, r, "caller", []string{"session_read"})
	_ = r.cb.SetPermissionMode(context.Background(), "", "caller", "deny")
	_, err := r.call("caller", "session_read", map[string]any{"target": "peer"})
	refusedWith(t, err, "do not allow session_read")
}

// The grant is audited with its keys and its outcome, refusals included.
func TestGrantCoordinationIsAudited(t *testing.T) {
	r := newCoordRig(t, nil)
	mustGrant(t, r, "caller", []string{"session_send", "session_read"})
	_, _ = r.grant("caller", []string{"bash"})
	mustGrant(t, r, "caller", []string{})
	var rows []map[string]any
	for _, row := range r.audit() {
		if row["action"] == "session.grantCoordination" {
			rows = append(rows, row)
		}
	}
	if len(rows) != 3 {
		t.Fatalf("rows = %v", rows)
	}
	if rows[0]["outcome"] != "ok" || !reflect.DeepEqual(rows[0]["keys"], []any{"session_read", "session_send"}) || rows[0]["session"] != "caller" {
		t.Errorf("grant row = %v", rows[0])
	}
	if rows[1]["outcome"] != "invalid" || !reflect.DeepEqual(rows[1]["keys"], []any{"bash"}) {
		t.Errorf("refused row = %v", rows[1])
	}
	if rows[2]["outcome"] != "ok" || !reflect.DeepEqual(rows[2]["keys"], []any{}) {
		t.Errorf("clear row = %v", rows[2])
	}
}

// permission.rules shows the grant, and a hello says the machine can take one.
func TestPermissionRulesAndHelloShowTheGrant(t *testing.T) {
	r := newCoordRig(t, nil)
	mustGrant(t, r, "caller", []string{"session_read"})
	raw := []byte(`{"sessionId":"caller"}`)
	res, operr := r.mc.opPermissionRules(context.Background(), raw)
	if operr != nil {
		t.Fatal(operr)
	}
	if got := res.(map[string]any)["coordination"]; !reflect.DeepEqual(got, []string{"session_read"}) {
		t.Errorf("coordination = %v", got)
	}
	hello := buildHello(r.cb, r.mc.pol)
	if !hello.Backends[0].Capabilities["coordinationGrant"] {
		t.Error("hello must advertise coordinationGrant")
	}
}
