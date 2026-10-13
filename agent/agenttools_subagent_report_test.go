package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/permrules"
	"galopin/internal/policy"
	"galopin/internal/sessions"
	"galopin/internal/workspaces"
)

// The subagent report-back contract: a task subagent reports to its parent in
// its final message (delivered automatically as the background-task result),
// never with session_send — session_list says so where the model looks, and a
// send it makes anyway never auto-approves (the live incident of 2026-10-11:
// an Allow parent's background child, refused a send to its own tree, picked
// the only other listed session and auto-sent /etc/hosts to it).

// TestSessionListNoteTellsTaskSubagentToReportInItsFinalMessage pins the
// session_list note for the three callers: a task subagent sees its parent's
// row marked with the report instruction, a root session sees its own row
// marked as before, and an unrelated row carries no note.
func TestSessionListNoteTellsTaskSubagentToReportInItsFinalMessage(t *testing.T) {
	r := newCoordRig(t, nil)
	r.addSession(r.w1, "kid", "Kid", "caller")

	out, err := r.call("kid", "session_list", map[string]any{"note": "where do I report"})
	if err != nil {
		t.Fatalf("session_list as a subagent: %v", err)
	}
	var rows []struct {
		SessionID string `json:"sessionId"`
		Note      string `json:"note"`
	}
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("list output: %v\n%s", err, out)
	}
	byID := map[string]string{}
	for _, row := range rows {
		byID[row.SessionID] = row.Note
	}
	if got := byID["caller"]; !strings.Contains(got, "your parent") || !strings.Contains(got, "final message") || !strings.Contains(got, "do not session_send") {
		t.Errorf("the parent's row for a subagent caller = %q, want the report-in-your-final-message note", got)
	}
	for _, id := range []string{"peer", "other"} {
		if got := byID[id]; got != "" {
			t.Errorf("unrelated row %s carries a note: %q", id, got)
		}
	}

	// A root caller sees its own row marked as before — and its own
	// subagent's row marked for resume, not for sends.
	out, err = r.call("caller", "session_list", map[string]any{"note": "x"})
	if err != nil {
		t.Fatalf("session_list as a root: %v", err)
	}
	rows = nil
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("list output: %v\n%s", err, out)
	}
	for _, row := range rows {
		want := ""
		switch row.SessionID {
		case "caller":
			want = "your own session tree: not a session_send target"
		case "kid":
			want = "your subagent (resume it with task, task_id = this sessionId; read it with session_read; not a session_send target)"
		}
		if row.Note != want {
			t.Errorf("row %s note = %q, want %q", row.SessionID, row.Note, want)
		}
	}
}

// TestSubagentSendNeverAutoApproves pins the guard: a task subagent on an
// Allow root, sending to an unrelated session in its own workspace, still
// raises the card — and the card names the case.
func TestSubagentSendNeverAutoApproves(t *testing.T) {
	r := newCoordRig(t, nil)
	if err := r.cb.SetPermissionMode(context.Background(), "", "caller", "allow"); err != nil {
		t.Fatal(err)
	}
	r.addSession(r.w1, "kid", "Kid", "caller")

	res, err := r.call("kid", "session_send", map[string]any{"target": "peer", "text": "here is what I found"})
	if err != nil {
		t.Fatalf("send from a subagent: %v", err)
	}
	if res != "{}" {
		t.Errorf("a subagent's card-approved send answered %q, want {} (no autoApproved)", res)
	}
	asks := r.asks()
	if len(asks) != 1 || asks[0].Tool != "session_send" {
		t.Fatalf("asks = %+v, want one session_send card", asks)
	}
	if asks[0].Metadata["fromSubagent"] != true {
		t.Errorf("card metadata fromSubagent = %v, want true", asks[0].Metadata["fromSubagent"])
	}
	if got, _ := asks[0].Metadata["parentTitle"].(string); got != "Caller" {
		t.Errorf("card metadata parentTitle = %v, want the parent's title", asks[0].Metadata["parentTitle"])
	}
	// The rig answers once, so the send is delivered after the card.
	ps := r.prompts()
	if len(ps) != 1 || ps[0].session != "peer" {
		t.Errorf("prompts = %+v, want the one delivery to peer", ps)
	}
}

// TestSubagentSendCardsEvenWhenTheTreeLostTheEdge pins the guard failing
// closed: the materializer's tree has not learned the caller's parent edge
// (a galopin restart that has not replayed it), but the session record
// opencode serves carries ParentID — the send must still raise the card.
// The rig hides the edge from the listing the machine feeds the tree with,
// while GetSession (what the tool caller carries) still reports it; that is
// the only way the tree stays edge-blind here, because a send lists the
// machine's sessions before it decides, and a listing that carried the edge
// would heal it.
func TestSubagentSendCardsEvenWhenTheTreeLostTheEdge(t *testing.T) {
	r := newTreeBlindRig(t)
	if err := r.cb.SetPermissionMode(context.Background(), "", "caller", "allow"); err != nil {
		t.Fatal(err)
	}
	// The backend knows the child's parent; the materializer is told about
	// the session without the edge, the way a restarted galopin first sees it.
	r.cb.mu.Lock()
	r.cb.sessions["orphan"] = backend.Session{ID: "orphan", Title: "Orphan", ParentID: "caller", Status: backend.StatusIdle, CreatedAt: time.Now()}
	r.cb.dirs["orphan"] = r.w1.Path
	r.cb.mu.Unlock()
	r.mc.trackSession(r.w1, backend.Session{ID: "orphan", Title: "Orphan", Status: backend.StatusIdle, CreatedAt: time.Now()})
	if got := r.mc.mat.RootOf("orphan"); got != "orphan" {
		t.Fatalf("precondition: the tree knows %q's root as %q, want itself", "orphan", got)
	}

	res, err := r.call("orphan", "session_send", map[string]any{"target": "peer", "text": "hi"})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if res != "{}" {
		t.Errorf("send answered %q, want {} (card-approved, not autoApproved)", res)
	}
	asks := r.asks()
	if len(asks) != 1 || asks[0].Tool != "session_send" {
		t.Fatalf("asks = %+v, want one session_send card", asks)
	}
	if asks[0].Metadata["fromSubagent"] != true {
		t.Errorf("card metadata fromSubagent = %v, want true", asks[0].Metadata["fromSubagent"])
	}
	if got, _ := asks[0].Metadata["parentTitle"].(string); got != "Caller" {
		t.Errorf("card metadata parentTitle = %q, want the parent's title", got)
	}
}

// treeBlindBackend is a coordBackend whose listings omit the parent edge:
// the machine's session tree is fed without it, while GetSession (and so
// the tool caller's own session record) still reports it. The backend's own
// parent map is untouched, so the caller's word still resolves through its
// root, as it does live.
type treeBlindBackend struct {
	*coordBackend
}

func (t *treeBlindBackend) ListSessions(ctx context.Context, dir string) ([]backend.Session, error) {
	out, err := t.coordBackend.ListSessions(ctx, dir)
	for i := range out {
		out[i].ParentID = ""
	}
	return out, err
}

// newTreeBlindRig is newCoordRig around a treeBlindBackend.
func newTreeBlindRig(t *testing.T) *coordRig {
	t.Helper()
	stateDir := t.TempDir()
	reg, err := workspaces.Load(filepath.Join(stateDir, "workspaces.json"))
	if err != nil {
		t.Fatal(err)
	}
	w1, err := reg.Create("one", t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	w2, err := reg.Create("two", t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	cb := &coordBackend{
		sessions: map[string]backend.Session{}, dirs: map[string]string{},
		transcripts: map[string][]backend.TranscriptEntry{}, sel: map[string]permrules.Selector{},
	}
	blind := &treeBlindBackend{cb}
	mat := sessions.New(blind, policy.Default())
	mc := newMachine(reg, blind, mat, policy.Default())
	cb.layers = mc.live.Layers
	audit, err := newAuditLogger(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = audit.Close() })
	mc.AttachAudit(audit)
	if mc.agentTools == nil {
		t.Fatal("the agent tools were not installed on the rig")
	}
	r := &coordRig{t: t, mc: mc, cb: cb, stateDir: stateDir, w1: w1, w2: w2}
	r.addSession(w1, "caller", "Caller", "")
	r.addSession(w1, "peer", "Peer", "")
	r.addSession(w2, "other", "Other", "")
	return r
}

// The two callers the guard must not disturb: a root session on Allow (and
// likewise a session_spawn child, which is a root) still auto-sends within
// its workspace.
func TestRootAndSpawnedRootSendStillAutoApprove(t *testing.T) {
	for _, id := range []string{"caller", "spawnedroot"} {
		t.Run(id, func(t *testing.T) {
			r := newCoordRig(t, nil)
			if err := r.cb.SetPermissionMode(context.Background(), "", id, "allow"); err != nil {
				t.Fatal(err)
			}
			if id == "spawnedroot" {
				// A session_spawn child is a new top-level session: no parent
				// in the tree, even though it was started by another session.
				r.addSession(r.w1, id, "Spawned", "")
			}
			res, err := r.call(id, "session_send", map[string]any{"target": "peer", "text": "hi"})
			if err != nil {
				t.Fatalf("send: %v", err)
			}
			if res != `{"autoApproved":true}` {
				t.Errorf("a root send answered %q, want autoApproved", res)
			}
			if asks := r.asks(); len(asks) != 0 {
				t.Errorf("a root send raised %d cards: %+v", len(asks), asks)
			}
			if ps := r.prompts(); len(ps) != 1 || ps[0].session != "peer" {
				t.Errorf("prompts = %+v, want the one delivery", ps)
			}
		})
	}
}
