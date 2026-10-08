package opencode

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"

	"galopin/internal/backend"
	"galopin/internal/permrules"
)

// A coordination grant is applied at once, as allows beneath the ceiling's tail;
// replacing it leaves nothing of the old one; clearing it asks again.
func TestSetCoordinationAppliesReplacesAndClears(t *testing.T) {
	b, f := newPermFake(t, func() permrules.Layers { return permrules.Layers{} })
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/ws", backend.CreateSessionOptions{})
	grant := func(tool string) permrules.Action {
		return permrules.Grant(stackOf(t, buildOnly, f, 0), tool)
	}
	if grant("session_send") != permrules.Ask {
		t.Fatal("a fresh session must ask")
	}
	if err := b.SetCoordination(ctx, "/ws", s.ID, []string{"session_list", "session_read", "session_send"}); err != nil {
		t.Fatal(err)
	}
	if grant("session_send") != permrules.Allow || grant("session_read") != permrules.Allow || grant("session_spawn") != permrules.Ask {
		t.Errorf("after the grant: send=%s read=%s spawn=%s", grant("session_send"), grant("session_read"), grant("session_spawn"))
	}
	if got := b.Coordination(s.ID); !reflect.DeepEqual(got, []string{"session_list", "session_read", "session_send"}) {
		t.Errorf("Coordination = %v", got)
	}
	if err := b.SetCoordination(ctx, "/ws", s.ID, []string{"session_read"}); err != nil {
		t.Fatal(err)
	}
	if grant("session_send") != permrules.Ask || grant("session_read") != permrules.Allow {
		t.Errorf("after the grant shrank: send=%s read=%s", grant("session_send"), grant("session_read"))
	}
	if err := b.SetCoordination(ctx, "/ws", s.ID, nil); err != nil {
		t.Fatal(err)
	}
	if grant("session_read") != permrules.Ask || len(b.Coordination(s.ID)) != 0 {
		t.Errorf("after clearing: read=%s coordination=%v", grant("session_read"), b.Coordination(s.ID))
	}
}

// The grant is the selector's, so it persists with it: a galopin started again
// on the same state finds it and composes the same rules.
func TestCoordinationSurvivesARestart(t *testing.T) {
	layers := func() permrules.Layers { return permrules.Layers{} }
	b, _ := newPermFake(t, layers)
	b.cfg.OverlayPath = filepath.Join(t.TempDir(), "overlay.json")
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/ws", backend.CreateSessionOptions{})
	if err := b.SetCoordination(ctx, "/ws", s.ID, []string{"session_read", "session_send"}); err != nil {
		t.Fatal(err)
	}

	b2 := New(Config{OverlayPath: b.cfg.OverlayPath, Permissions: layers})
	if err := b2.loadOverlay(); err != nil {
		t.Fatal(err)
	}
	if got := b2.Coordination(s.ID); !reflect.DeepEqual(got, []string{"session_read", "session_send"}) {
		t.Fatalf("after a restart the grant = %v", got)
	}
	rules := permrules.Compose(layers(), b2.selectorOf(s.ID), []permrules.Rule{{Permission: "*", Pattern: "*", Action: permrules.Allow}})
	if permrules.Grant(rules, "session_send") != permrules.Allow || permrules.Grant(rules, "session_spawn") != permrules.Ask {
		t.Errorf("the restarted backend composes the wrong rules for the grant")
	}
}

// The grant is read through the machine's ceiling: a key capped at ask asks.
func TestCoordinationIsCappedByTheCeiling(t *testing.T) {
	layers := func() permrules.Layers {
		return permrules.Layers{Ceiling: permrules.Ceiling{Max: map[string]permrules.Action{"session_send": permrules.Ask, "session_spawn": permrules.Deny}}}
	}
	b, f := newPermFake(t, layers)
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/ws", backend.CreateSessionOptions{})
	if err := b.SetCoordination(ctx, "/ws", s.ID, []string{"session_read", "session_send", "session_spawn"}); err != nil {
		t.Fatal(err)
	}
	all := stackOf(t, buildOnly, f, 0)
	for tool, want := range map[string]permrules.Action{"session_read": permrules.Allow, "session_send": permrules.Ask, "session_spawn": permrules.Deny} {
		if got := permrules.Grant(all, tool); got != want {
			t.Errorf("%s = %s, want %s", tool, got, want)
		}
	}
}
