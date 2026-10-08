package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/policy"
)

var t0 = time.Date(2026, 10, 8, 9, 0, 0, 0, time.UTC)

func refusedWith(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("want a refusal containing %q, got success", want)
	}
	if _, ok := err.(*backend.ToolRefusal); !ok || !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %v (%T), want a refusal containing %q", err, err, want)
	}
}

// Only user and assistant TEXT comes back: no tool input or output, no
// reasoning, no files, nothing synthetic; each message carries role and time.
func TestSessionReadReturnsOnlyText(t *testing.T) {
	r := newCoordRig(t, withRule("session_read", "allow"))
	r.say("peer", "user", "please refactor the parser", t0)
	r.cb.transcripts["peer"] = append(r.cb.transcripts["peer"], backend.TranscriptEntry{
		Message: backend.Message{ID: "a1", Role: "assistant", CreatedAt: t0.Add(time.Minute)},
		Parts: []backend.Part{
			{ID: "p1", Role: "assistant", Type: backend.PartReason, Text: "SECRET_REASONING"},
			{ID: "p2", Role: "assistant", Type: backend.PartTool, Tool: "bash", ToolStatus: backend.ToolCompleted,
				Input: map[string]any{"command": "cat ~/.ssh/id_rsa"}, Output: "SECRET_TOOL_OUTPUT"},
			{ID: "p3", Role: "assistant", Type: backend.PartFile, URL: "data:image/png;base64,SECRET_FILE"},
			{ID: "p4", Role: "assistant", Type: backend.PartText, Text: "Synthetic note", Synthetic: true},
			{ID: "p5", Role: "assistant", Type: backend.PartText, Text: "Done: parser split in two."},
		},
	}, backend.TranscriptEntry{ // a tool-only message has no text: dropped
		Message: backend.Message{ID: "a2", Role: "assistant", CreatedAt: t0.Add(2 * time.Minute)},
		Parts:   []backend.Part{{ID: "p6", Role: "assistant", Type: backend.PartTool, Tool: "read", Output: "SECRET_READ"}},
	})
	out, err := r.call("caller", "session_read", map[string]any{"target": "peer", "last": 10})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"[user · 2026-10-08T09:00:00Z]", "please refactor the parser", "[assistant · 2026-10-08T09:01:00Z]", "Done: parser split in two."} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	for _, leak := range []string{"SECRET_REASONING", "SECRET_TOOL_OUTPUT", "cat ~/.ssh", "SECRET_FILE", "Synthetic note", "SECRET_READ"} {
		if strings.Contains(out, leak) {
			t.Errorf("%q leaked into the answer:\n%s", leak, out)
		}
	}
	if strings.Index(out, "please refactor") > strings.Index(out, "Done: parser") {
		t.Error("messages must be oldest first")
	}
}

func TestSessionReadCountsAndCaps(t *testing.T) {
	r := newCoordRig(t, withRule("session_read", "allow"))
	for i := 0; i < 60; i++ {
		r.say("peer", "assistant", "msg-"+strings.Repeat("x", 3)+string(rune('A'+i%26))+"-"+time.Duration(i).String(), t0.Add(time.Duration(i)*time.Second))
	}
	count := func(args map[string]any) int {
		t.Helper()
		out, err := r.call("caller", "session_read", args)
		if err != nil {
			t.Fatal(err)
		}
		return strings.Count(out, "\n[assistant ·") + boolInt(strings.HasPrefix(out, "[assistant ·"))
	}
	if n := count(map[string]any{"target": "peer"}); n != 10 {
		t.Errorf("default = %d messages, want 10", n)
	}
	if n := count(map[string]any{"target": "peer", "last": 0}); n != 10 {
		t.Errorf("last 0 = %d, want the default 10", n)
	}
	if n := count(map[string]any{"target": "peer", "last": "3"}); n != 3 {
		t.Errorf("last \"3\" = %d, want 3 (a model may send a string)", n)
	}
	if n := count(map[string]any{"target": "peer", "last": 500}); n != 50 {
		t.Errorf("last 500 = %d, want the cap of 50", n)
	}
	for _, bad := range []any{-1, 2.5, "many", true} {
		_, err := r.call("caller", "session_read", map[string]any{"target": "peer", "last": bad})
		refusedWith(t, err, "last")
	}
	// The newest messages are the ones kept.
	out, _ := r.call("caller", "session_read", map[string]any{"target": "peer", "last": 1})
	if !strings.Contains(out, "msg-xxx"+string(rune('A'+59%26))) {
		t.Errorf("last 1 is not the newest message:\n%s", out)
	}
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func TestSessionReadTruncatesMessagesAndTheWholeAnswer(t *testing.T) {
	r := newCoordRig(t, withRule("session_read", "allow"))
	r.say("peer", "user", strings.Repeat("é", 5000), t0) // 10 KB of two-byte runes
	out, err := r.call("caller", "session_read", map[string]any{"target": "peer"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "[message truncated at 4 KB]") {
		t.Error("a long message must say it was cut")
	}
	if strings.Count(out, "é") > readMessageCap/2 {
		t.Errorf("message kept %d runes, want at most %d bytes of it", strings.Count(out, "é"), readMessageCap)
	}

	// 50 × 4 KB far exceeds 32 KB: the oldest go, the newest stay, and it says so.
	r2 := newCoordRig(t, withRule("session_read", "allow"))
	for i := 0; i < 50; i++ {
		r2.say("peer", "assistant", strings.Repeat("a", 3000)+"#"+string(rune('A'+i%26))+time.Duration(i).String(), t0.Add(time.Duration(i)*time.Second))
	}
	out, err = r2.call("caller", "session_read", map[string]any{"target": "peer", "last": 50})
	if err != nil {
		t.Fatal(err)
	}
	if len(out) > readTotalCap {
		t.Errorf("answer is %d bytes, cap is %d", len(out), readTotalCap)
	}
	if !strings.Contains(out, "earlier messages omitted") {
		t.Error("the cap must be marked")
	}
	if !strings.Contains(out, "#"+string(rune('A'+49%26))+"49ns") {
		t.Error("the newest message must survive the cap")
	}
	if strings.Contains(out, "#A0s") || strings.Contains(out, "#A0ns") {
		t.Error("the oldest message must be the one dropped")
	}
}

func TestSessionReadTargets(t *testing.T) {
	r := newCoordRig(t, withRule("session_read", "allow"))
	r.say("peer", "user", "hi", t0)
	_, err := r.call("caller", "session_read", map[string]any{"target": "caller"})
	refusedWith(t, err, "your own session")
	_, err = r.call("caller", "session_read", map[string]any{"target": "ses_nope"})
	refusedWith(t, err, "no such session")
	_, err = r.call("caller", "session_read", map[string]any{})
	refusedWith(t, err, "target is required")
	_, err = r.call("caller", "session_read", map[string]any{"target": "peer", "workspaceId": "x"})
	refusedWith(t, err, "unsupported argument")

	// An archived session is not listed, so it is as good as unknown.
	delete(r.cb.sessions, "peer")
	_, err = r.call("caller", "session_read", map[string]any{"target": "peer"})
	refusedWith(t, err, "no such session")

	// A subagent of the caller's own tree is readable; another tree's is not.
	r.addSession(r.w1, "kid", "Kid", "caller")
	r.say("kid", "assistant", "kid says hello", t0)
	out, err := r.call("caller", "session_read", map[string]any{"target": "kid"})
	if err != nil || !strings.Contains(out, "kid says hello") {
		t.Fatalf("own subagent: %v %q", err, out)
	}
	r.addSession(r.w2, "stranger", "Stranger", "other")
	_, err = r.call("caller", "session_read", map[string]any{"target": "stranger"})
	refusedWith(t, err, "subagent of another session")
	// ...and a subagent may read its own root.
	r.say("caller", "user", "root text", t0)
	out, err = r.call("kid", "session_read", map[string]any{"target": "caller"})
	if err != nil || !strings.Contains(out, "root text") {
		t.Fatalf("a subagent reading its root: %v %q", err, out)
	}
}

// With no rule a read is a card (a gp_ ask carrying the target and count), and a
// blanket Allow on the session never grants it; a person's no is a refusal.
func TestSessionReadNeedsACardUnlessARuleAllows(t *testing.T) {
	r := newCoordRig(t, nil)
	r.say("peer", "user", "secret plans", t0)
	if err := r.cb.SetPermissionMode(context.Background(), "", "caller", "allow"); err != nil {
		t.Fatal(err)
	}
	out, err := r.call("caller", "session_read", map[string]any{"target": "peer", "last": 5})
	if err != nil || !strings.Contains(out, "secret plans") {
		t.Fatalf("approved read: %v %q", err, out)
	}
	asks := r.asks()
	if len(asks) != 1 || asks[0].Tool != "session_read" || asks[0].Title != "Read messages from Peer" {
		t.Fatalf("asks = %+v, want one session_read card even on Allow (a blanket allow is not consent)", asks)
	}
	meta := asks[0].Metadata
	if tgt, _ := meta["target"].(map[string]any); tgt["sessionId"] != "peer" || meta["last"] != 5 {
		t.Errorf("card metadata = %v", meta)
	}

	r.cb.answer = func(backend.PermissionRequest) (backend.Decision, string) { return backend.DecisionReject, "no" }
	_, err = r.call("caller", "session_read", map[string]any{"target": "peer"})
	refusedWith(t, err, "declined")
}

func TestSessionReadRuleAllowDenyAndCrossWorkspace(t *testing.T) {
	r := newCoordRig(t, withRule("session_read", "allow"))
	r.say("peer", "user", "same workspace", t0)
	r.say("other", "user", "other workspace", t0)
	if _, err := r.call("caller", "session_read", map[string]any{"target": "peer"}); err != nil {
		t.Fatal(err)
	}
	if n := len(r.asks()); n != 0 {
		t.Fatalf("a rule allow raised %d cards in the same workspace, want none", n)
	}
	// Another workspace still asks, whatever the rule says.
	if _, err := r.call("caller", "session_read", map[string]any{"target": "other"}); err != nil {
		t.Fatal(err)
	}
	if asks := r.asks(); len(asks) != 1 || asks[0].Tool != "session_read" {
		t.Fatalf("cross-workspace asks = %+v, want one card", asks)
	}

	d := newCoordRig(t, withRule("session_read", "deny"))
	d.say("peer", "user", "x", t0)
	_, err := d.call("caller", "session_read", map[string]any{"target": "peer"})
	refusedWith(t, err, "do not allow session_read")
	if len(d.asks()) != 0 {
		t.Error("a deny must not raise a card")
	}
}

func TestSessionReadRateLimit(t *testing.T) {
	r := newCoordRig(t, withRule("session_read", "allow"))
	r.say("peer", "user", "x", t0)
	now := time.Now()
	r.mc.agentTools.now = func() time.Time { return now }
	for i := 0; i < readsPerWindow; i++ {
		if _, err := r.call("caller", "session_read", map[string]any{"target": "peer"}); err != nil {
			t.Fatalf("read %d: %v", i, err)
		}
	}
	_, err := r.call("caller", "session_read", map[string]any{"target": "peer"})
	refusedWith(t, err, "read rate limit")
	// Another target has its own budget, and the window rolls.
	r.say("other", "user", "y", t0)
	if _, err := r.call("caller", "session_read", map[string]any{"target": "other"}); err != nil {
		t.Errorf("another pair: %v", err)
	}
	now = now.Add(readWindow + time.Second)
	if _, err := r.call("caller", "session_read", map[string]any{"target": "peer"}); err != nil {
		t.Errorf("after the window: %v", err)
	}
}

// Every read is an audit row naming tool, caller, target, decision and reason —
// and nothing of what was read.
func TestSessionReadAuditNeverHoldsContent(t *testing.T) {
	r := newCoordRig(t, withRule("session_read", "allow"))
	r.say("peer", "user", "TOP_SECRET_CONTENT", t0)
	if _, err := r.call("caller", "session_read", map[string]any{"target": "peer"}); err != nil {
		t.Fatal(err)
	}
	_, _ = r.call("caller", "session_read", map[string]any{"target": "ses_nope"})
	var rows []map[string]any
	for _, row := range r.audit() {
		if row["action"] == "agent_tool" && row["tool"] == "session_read" {
			rows = append(rows, row)
		}
	}
	if len(rows) != 3 {
		t.Fatalf("rows = %v, want allow + done for the read and a refusal", rows)
	}
	if rows[0]["decision"] != "allow" || rows[0]["reason"] != "rule" || rows[0]["to"] != "peer" || rows[0]["from"] != "caller" {
		t.Errorf("allow row = %v", rows[0])
	}
	if rows[1]["decision"] != "done" || rows[1]["to"] != "peer" {
		t.Errorf("done row = %v", rows[1])
	}
	if rows[2]["decision"] != "refused" || rows[2]["reason"] == nil {
		t.Errorf("refusal row = %v", rows[2])
	}
	raw, _ := os.ReadFile(filepath.Join(r.stateDir, "audit.log"))
	if strings.Contains(string(raw), "TOP_SECRET_CONTENT") {
		t.Error("the transcript's content reached the audit log")
	}
}

func TestPolicyDefaultsLeaveSessionReadUncapped(t *testing.T) {
	// Like session_send: no default ceiling row (enroll caps bash and session_spawn only).
	if got := defaultEnrollMax()["session_read"]; got != "" {
		t.Errorf("enroll's default ceiling caps session_read at %q; it must match session_send (uncapped)", got)
	}
	if got := defaultEnrollMax()["session_send"]; got != "" {
		t.Fatalf("session_send default changed: %q", got)
	}
	_ = policy.Default()
}
