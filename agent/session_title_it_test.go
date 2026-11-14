package main

import (
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/sessions"
)

// A session created without a name (opencode 2 leaves the title empty) is
// named again after its first turn (C131). opencode's own title agent does it,
// through the permission floor that denies the hidden agents every tool: the
// agent uses none. The title reaches the panel as a session event and the list.
func TestNewSessionGetsATitleAfterItsFirstTurn(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	s, err := r.oc.CreateSession(r.ctx, r.work, backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if s.Title != "" {
		t.Fatalf("a new session's title = %q, want empty (the title agent has not run)", s.Title)
	}
	r.mc.trackSession(r.ws, s)
	r.script(map[string]any{"content": []string{"Build explained"}})
	mark := r.hub.mark()
	if err := r.promptSession(s, "please explain how the build works"); err != nil {
		t.Fatal(err)
	}
	env := r.hub.wait(t, mark, 60*time.Second, "a session event with opencode's title", func(e sessions.Envelope) bool {
		return e.SessionID == s.ID && e.Event.Kind == backend.EventSession && e.Event.Session != nil &&
			e.Event.Session.Title != "" && e.Event.Session.Title != "please explain how the build works"
	})
	t.Logf("title event: %q", env.Event.Session.Title)
	list, err := r.oc.ListSessions(r.ctx, r.work)
	if err != nil {
		t.Fatal(err)
	}
	for _, x := range list {
		if x.ID == s.ID && x.Title == "" {
			t.Errorf("session listed without a title")
		}
	}
}

// When the title agent's call fails (a provider that rejects it) the session
// would stay nameless: galopin lends it the first words of its first prompt.
func TestUntitledSessionGetsTheFirstPromptWordsAsAName(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	s, err := r.oc.CreateSession(r.ctx, r.work, backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	r.mc.trackSession(r.ws, s)
	r.script(map[string]any{"routes": []map[string]any{{"contains": "name conversations", "scenario": map[string]any{"status": 500, "body": "boom"}}}})
	mark := r.hub.mark()
	if err := r.promptSession(s, "fix the flaky login test in the auth module today"); err != nil {
		t.Fatal(err)
	}
	const want = "fix the flaky login test in…"
	r.hub.wait(t, mark, 60*time.Second, "a session event with the stand-in name", func(e sessions.Envelope) bool {
		return e.SessionID == s.ID && e.Event.Kind == backend.EventSession && e.Event.Session != nil && e.Event.Session.Title == want
	})
	r.idle(s, mark)
	got, err := r.oc.GetSession(r.ctx, r.work, s.ID)
	if err != nil || got.Title != want {
		t.Errorf("GetSession title = %q (%v), want %q", got.Title, err, want)
	}
}
