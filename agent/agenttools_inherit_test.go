package main

import (
	"context"
	"encoding/json"
	"testing"

	"galopin/internal/permrules"
	"galopin/internal/policy"
)

// A spawned session inherits its caller's permission word and coordination
// grant, never more; an Allow session's blanket covers the mutating session
// tools the way it covers `schedule` (reads stay grant-gated); the ceiling
// and the machine's own rules still cap beneath it. The rig composes with
// the real permrules, so these are the production rules, not canned answers.
func allowCaller(t *testing.T, r *coordRig) {
	t.Helper()
	if err := r.cb.SetPermissionMode(context.Background(), "", "caller", permrules.Allow); err != nil {
		t.Fatal(err)
	}
}

func spawnChild(t *testing.T, r *coordRig) (string, map[string]any) {
	t.Helper()
	args := map[string]any{"title": "worker", "prompt": "do the thing", "mode": "inherit"}
	out, err := r.call("caller", "session_spawn", args)
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	var result map[string]any
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatalf("spawn result is not JSON: %v", err)
	}
	child, _ := result["sessionId"].(string)
	if child == "" {
		t.Fatalf("spawn result has no sessionId: %q", out)
	}
	return child, result
}

func TestSpawnInheritsAllowWordAndGrant(t *testing.T) {
	r := newCoordRig(t, nil)
	allowCaller(t, r)
	mustGrant(t, r, "caller", []string{"session_read"})

	child, result := spawnChild(t, r)
	if result["permissionMode"] != "allow" {
		t.Errorf("result permissionMode = %v, want allow", result["permissionMode"])
	}
	if got := r.cb.PermissionMode(child); got != permrules.Allow {
		t.Errorf("child word = %s, want allow", got)
	}
	if got := r.cb.Coordination(child); len(got) != 1 || got[0] != "session_read" {
		t.Errorf("child grant = %v, want the caller's [session_read]", got)
	}
	if n := len(r.asks()); n != 0 {
		t.Fatalf("an allow spawn raised %d cards: %+v", n, r.asks())
	}
	// The child's composed rules carry the word: bash evaluates allow, under
	// the same ceiling as the caller.
	rules, err := r.cb.EffectiveRules(context.Background(), "", child)
	if err != nil {
		t.Fatal(err)
	}
	if got := permrules.Evaluate(rules, "bash", "ls"); got != permrules.Allow {
		t.Errorf("child bash = %s, want allow", got)
	}
}

func TestSpawnFromAskStaysAsk(t *testing.T) {
	r := newCoordRig(t, nil)
	child, result := spawnChild(t, r)
	if _, ok := result["autoApproved"]; ok {
		t.Errorf("an ask spawn must not carry autoApproved: %v", result)
	}
	if got := r.cb.PermissionMode(child); got != permrules.Ask {
		t.Errorf("child word = %s, want ask", got)
	}
	if asks := r.asks(); len(asks) != 1 || asks[0].Tool != "session_spawn" {
		t.Errorf("asks = %+v, want the one spawn card", asks)
	}
}

func TestAllowBlanketCoversSendWithoutAGrant(t *testing.T) {
	r := newCoordRig(t, nil)
	allowCaller(t, r)
	r.say("peer", "assistant", "done", t0)

	res, err := r.call("caller", "session_send", map[string]any{"target": "peer", "text": "thanks"})
	if err != nil || res != `{"autoApproved":true}` {
		t.Fatalf("send: %v %q", err, res)
	}
	if n := len(r.asks()); n != 0 {
		t.Fatalf("an allow send raised %d cards: %+v", n, r.asks())
	}
	// Reads stay grant-gated whatever the word is.
	if _, err := r.call("caller", "session_read", map[string]any{"target": "peer"}); err != nil {
		t.Fatal(err)
	}
	if asks := r.asks(); len(asks) != 1 || asks[0].Tool != "session_read" {
		t.Errorf("asks = %+v, want the one read card", asks)
	}
}

func TestAllowBlanketStillCappedByCeiling(t *testing.T) {
	r := newCoordRig(t, func(p *policy.Policy) { withMax("session_send", "ask")(p) })
	allowCaller(t, r)
	if _, err := r.call("caller", "session_send", map[string]any{"target": "peer", "text": "hi"}); err != nil {
		t.Fatal(err)
	}
	if asks := r.asks(); len(asks) != 1 || asks[0].Tool != "session_send" {
		t.Fatalf("a send the ceiling caps at ask must still raise a card; asks = %+v", asks)
	}

	// Spawns likewise, on the default session_spawn=ask ceiling — and the
	// approved child still inherits the caller's word.
	r2 := newCoordRig(t, func(p *policy.Policy) { withMax("session_spawn", "ask")(p) })
	_ = r2.cb.SetPermissionMode(context.Background(), "", "caller", permrules.Allow)
	child, result := spawnChild(t, r2)
	if asks := r2.asks(); len(asks) != 1 || asks[0].Tool != "session_spawn" {
		t.Fatalf("a spawn the ceiling caps at ask must still raise a card; asks = %+v", asks)
	}
	if result["permissionMode"] != "allow" {
		t.Errorf("result permissionMode = %v, want allow", result["permissionMode"])
	}
	if got := r2.cb.PermissionMode(child); got != permrules.Allow {
		t.Errorf("child word = %s, want the inherited allow", got)
	}
}

func TestAllowBlanketYieldsToAMachineDeny(t *testing.T) {
	r := newCoordRig(t, func(p *policy.Policy) {
		p.Permission.Rules = map[string]string{"session_send": "deny"}
	})
	allowCaller(t, r)
	before := len(r.asks())
	if _, err := r.call("caller", "session_send", map[string]any{"target": "peer", "text": "hi"}); err == nil {
		t.Fatal("a machine-denied send must be refused")
	}
	if n := len(r.asks()); n != before {
		t.Errorf("a refused send must not raise a card")
	}
}
