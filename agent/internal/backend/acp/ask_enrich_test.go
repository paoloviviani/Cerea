package acp

import (
	"context"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/decide"
	"galopin/internal/permrules"
)

// Mistral Vibe 3.1.3 answers a tool call with a tool_call notification that names
// the kind, title and input, then asks with a session/request_permission whose
// toolCall carries only its toolCallId (recorded live, 2026-11-18). The ask is
// completed from the call, so it classifies and Auto rows and cards work.
func TestSparseAskIsCompletedFromTheToolCall(t *testing.T) {
	frames := []struct {
		name   string
		call   map[string]any // the tool_call notification
		update map[string]any // a later tool_call_update, or nil
		class  string
		mode   permrules.Action
		want   decide.Verdict
		path   string
	}{
		{
			name: "shell command",
			call: map[string]any{"sessionUpdate": "tool_call", "toolCallId": "effect-1", "kind": "execute", "status": "pending",
				"title": "bash: echo hi", "rawInput": map[string]any{"command": "echo hi"}},
			class: "bash", mode: permrules.Deny, want: decide.Reject,
		},
		{
			name: "read inside the workspace",
			call: map[string]any{"sessionUpdate": "tool_call", "toolCallId": "effect-2", "kind": "read", "status": "pending",
				"title": "Reading notes.txt", "locations": []any{map[string]any{"path": "/w/notes.txt"}}},
			class: "read", mode: permrules.Ask, want: decide.Once, path: "/w/notes.txt",
		},
		{
			name: "edit announced bare, described by an update",
			call: map[string]any{"sessionUpdate": "tool_call", "toolCallId": "effect-3", "status": "pending"},
			update: map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "effect-3", "kind": "edit",
				"title": "Editing a.go", "locations": []any{map[string]any{"path": "/w/a.go"}}},
			class: "edit", mode: permrules.Ask, want: decide.Card, path: "/w/a.go",
		},
	}
	for _, f := range frames {
		t.Run(f.name, func(t *testing.T) {
			b, fa := newTestBackend(t)
			ctx := context.Background()
			sess, err := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{})
			if err != nil {
				t.Fatal(err)
			}
			events, _ := b.Subscribe(ctx)
			if err := b.Prompt(ctx, "/w", sess.ID, backend.Prompt{Text: "go"}); err != nil {
				t.Fatal(err)
			}
			pr := <-fa.promptReqs
			fa.update(pr.sessionID, f.call)
			if f.update != nil {
				fa.update(pr.sessionID, f.update)
			}
			id := f.call["toolCallId"]
			go func() {
				// the sparse ask, as Vibe sends it: no kind, no title, no input
				_, _ = fa.conn.call(ctx, "session/request_permission", map[string]any{
					"sessionId": pr.sessionID,
					"toolCall":  map[string]any{"toolCallId": id},
					"options":   standardPermissionOptions,
				})
			}()
			asked := drainEvents(t, events, sess.ID, 5*time.Second, func(ev backend.Event) bool { return ev.Kind == backend.EventPermissionAsked })
			req := asked[len(asked)-1].Request
			if req == nil {
				t.Fatal("no ask")
			}
			if req.Tool == "" || req.Title == "" {
				t.Errorf("the ask has no tool or title: %+v", req)
			}
			key, patterns := b.NormalizeAsk(*req)
			if key != f.class {
				t.Fatalf("class %q (patterns %v), want %q", key, patterns, f.class)
			}
			if f.path != "" && (len(patterns) == 0 || patterns[0] != f.path) {
				t.Errorf("patterns %v, want the path %s", patterns, f.path)
			}
			got := decide.Decide(decide.Policy{}, decide.State{Mode: f.mode}, decide.Request{Key: key, Patterns: patterns, Workspace: "/w"})
			if got.Verdict != f.want {
				t.Errorf("verdict %s, want %s", got.Verdict, f.want)
			}
			_ = b.ReplyPermission(ctx, "/w", sess.ID, req.ID, backend.DecisionReject, "")
			fa.respond(pr.id, map[string]any{"stopReason": "end_turn"})
		})
	}
}

// An ask that already says what it is keeps its own words; a call the agent never
// described is left as it was (and so stays the cautious unknown class).
func TestAskEnrichmentLeavesCompleteAsksAlone(t *testing.T) {
	b := New(Config{})
	st := newSessionState("s", "/w")
	st.rememberCall("c1", map[string]any{"kind": "read", "title": "Reading x", "locations": []any{map[string]any{"path": "/w/x"}}})
	full := map[string]any{"toolCallId": "c1", "kind": "execute", "title": "mine", "rawInput": map[string]any{"command": "ls"}}
	got := b.enrichAsk(st, full)
	if got["kind"] != "execute" || got["title"] != "mine" {
		t.Errorf("a complete ask was changed: %v", got)
	}
	if _, has := got["locations"]; !has {
		t.Error("a missing field was not filled")
	}
	// "other" is as good as nothing
	other := b.enrichAsk(st, map[string]any{"toolCallId": "c1", "kind": "other"})
	if other["kind"] != "read" {
		t.Errorf("kind other = %v, want the call's read", other["kind"])
	}
	// nothing known: unchanged
	unknown := map[string]any{"toolCallId": "zzz"}
	if got := b.enrichAsk(st, unknown); len(got) != 1 {
		t.Errorf("an undescribed call was changed: %v", got)
	}
	// the input map is never modified
	if _, has := full["locations"]; has {
		t.Error("the caller's map was modified")
	}
}

// A later update that only moves the status, or says "other", must not erase what
// the call said about itself.
func TestRememberCallKeepsTheConcreteKind(t *testing.T) {
	st := newSessionState("s", "/w")
	st.rememberCall("c", map[string]any{"kind": "edit", "title": "Editing a"})
	st.rememberCall("c", map[string]any{"kind": "other", "status": "in_progress"})
	st.rememberCall("c", map[string]any{"status": "completed", "title": ""})
	if m := st.calls["c"]; m["kind"] != "edit" || m["title"] != "Editing a" {
		t.Errorf("memo = %v", m)
	}
	for i := 0; i < maxTrackedCalls+5; i++ {
		st.rememberCall("call-"+string(rune('a'+i%26))+string(rune('a'+i/26%26))+string(rune('a'+i/676)), map[string]any{"kind": "read"})
	}
	if len(st.calls) > maxTrackedCalls {
		t.Errorf("%d calls remembered, the bound is %d", len(st.calls), maxTrackedCalls)
	}
}

// A notification that arrives before session/new's answer creates the session with
// no workspace; the caller that knows it fills it in, so the session is listed.
func TestSessionCreatedByAnEarlyNotificationGetsItsWorkspace(t *testing.T) {
	r := newRegistry()
	early := r.getOrCreate("s1", "")
	if got := r.getOrCreate("s1", "/w"); got != early {
		t.Fatal("a second getOrCreate made another state")
	}
	if l := r.list("/w"); len(l) != 1 {
		t.Errorf("listed %d sessions for /w, want 1", len(l))
	}
	// a known workspace is never overwritten, and "" never blanks one
	r.getOrCreate("s1", "/other")
	r.getOrCreate("s1", "")
	if l := r.list("/w"); len(l) != 1 {
		t.Errorf("the workspace changed: %d sessions for /w", len(l))
	}
}
