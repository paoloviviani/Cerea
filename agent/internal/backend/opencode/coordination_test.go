package opencode

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"

	"galopin/internal/backend"
	"galopin/internal/permrules"
)

// A coordination grant is galopin's own state on the root: replacing it leaves
// nothing of the old one and clearing it empties it. Nothing is written to
// opencode (the decision function reads it).
func TestSetCoordinationReplacesAndClears(t *testing.T) {
	b, f := newPermFake(t, func() permrules.Layers { return permrules.Layers{} })
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/ws", backend.CreateSessionOptions{})
	if err := b.SetCoordination(ctx, "/ws", s.ID, []string{"session_list", "session_read", "session_send"}); err != nil {
		t.Fatal(err)
	}
	if got := b.Coordination(s.ID); !reflect.DeepEqual(got, []string{"session_list", "session_read", "session_send"}) {
		t.Errorf("Coordination = %v", got)
	}
	if err := b.SetCoordination(ctx, "/ws", s.ID, []string{"session_read"}); err != nil {
		t.Fatal(err)
	}
	if got := b.Coordination(s.ID); !reflect.DeepEqual(got, []string{"session_read"}) {
		t.Errorf("after the grant shrank: %v", got)
	}
	if err := b.SetCoordination(ctx, "/ws", s.ID, nil); err != nil {
		t.Fatal(err)
	}
	if len(b.Coordination(s.ID)) != 0 {
		t.Errorf("after clearing: %v", b.Coordination(s.ID))
	}
	if n := f.patchCount(s.ID); n != 0 {
		t.Errorf("a grant wrote %d PATCHes to opencode, want none", n)
	}
}

// The grant is the selector's, so it persists with it: a galopin started again
// on the same state finds it.
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
}
