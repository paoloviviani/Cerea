package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
)

// session_list must show a caller its own task subagents: a finished child
// drops out of the conversation's view (only the task result's task_id names
// it), and without the listing the model cannot find it again — seen live, a
// session with five finished task children told the person it had launched
// none. Other trees' subagents stay hidden; session_send to an own-tree id
// stays refused.

type ownSubagentRow struct {
	SessionID    string `json:"sessionId"`
	Title        string `json:"title"`
	ParentID     string `json:"parentId"`
	Agent        string `json:"agent"`
	Status       string `json:"status"`
	LastActivity string `json:"lastActivity"`
	Note         string `json:"note"`
}

func listOwnSubagents(t *testing.T, r *coordRig, caller string) map[string]ownSubagentRow {
	t.Helper()
	out, err := r.call(caller, "session_list", map[string]any{"note": "x"})
	if err != nil {
		t.Fatalf("session_list as %s: %v", caller, err)
	}
	var rows []ownSubagentRow
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("session_list output: %v\n%s", err, out)
	}
	byID := map[string]ownSubagentRow{}
	for _, row := range rows {
		byID[row.SessionID] = row
	}
	return byID
}

// addSubagent registers a session with the full record (agent type, status,
// updated time) BEFORE the tree first sees it: the listing enriches rows
// with the tree's tracked status, so a record edited after tracking would
// still read the stale one.
func addSubagent(r *coordRig, id, title, parent, agent string, status backend.SessionStatus, updated time.Time) {
	s := backend.Session{
		ID: id, Title: title, ParentID: parent,
		Agent: agent, Status: status,
		CreatedAt: t0, UpdatedAt: updated,
	}
	r.cb.mu.Lock()
	r.cb.sessions[id] = s
	r.cb.dirs[id] = r.w1.Path
	r.cb.mu.Unlock()
	r.mc.trackSession(r.w1, s)
}

// ownSubagentTree builds the tree the listing tests share: caller with two
// finished task children (one grandchildren deep) and another top-level
// session with a child of its own.
func ownSubagentTree(r *coordRig) {
	addSubagent(r, "kid1", "Kid One", "caller", "explore", backend.StatusIdle, t0.Add(3*time.Hour))
	addSubagent(r, "kid2", "Kid Two", "caller", "general", backend.StatusBusy, time.Time{})
	addSubagent(r, "grandkid", "Grand Kid", "kid1", "explore", backend.StatusIdle, time.Time{})
	r.addSession(r.w1, "alien", "Alien", "")
	r.addSession(r.w1, "aliencub", "Alien Cub", "alien")
}

// A top-level caller lists its children and their descendants, marked with
// parentId; another tree's subagent is absent.
func TestSessionListShowsOwnSubagentsToTopLevelCaller(t *testing.T) {
	r := newCoordRig(t, nil)
	ownSubagentTree(r)
	byID := listOwnSubagents(t, r, "caller")

	kid1, ok := byID["kid1"]
	if !ok {
		t.Fatalf("caller does not list its own subagent kid1: %v", keysOf(byID))
	}
	if kid1.ParentID != "caller" {
		t.Errorf("kid1 parentId = %q, want caller", kid1.ParentID)
	}
	if kid1.Agent != "explore" {
		t.Errorf("kid1 agent = %q, want explore", kid1.Agent)
	}
	if kid1.LastActivity != "2026-10-08T12:00:00Z" {
		t.Errorf("kid1 lastActivity = %q, want the RFC 3339 update time", kid1.LastActivity)
	}
	for _, want := range []string{"task_id", "session_read", "not a session_send target"} {
		if !strings.Contains(kid1.Note, want) {
			t.Errorf("kid1 note = %q, want it to mention %q", kid1.Note, want)
		}
	}

	kid2, ok := byID["kid2"]
	if !ok {
		t.Fatalf("caller does not list its own subagent kid2: %v", keysOf(byID))
	}
	if kid2.Status != string(backend.StatusBusy) {
		t.Errorf("kid2 status = %q, want busy", kid2.Status)
	}
	if kid2.LastActivity != "" {
		t.Errorf("kid2 lastActivity = %q, want empty when the record carries no update time", kid2.LastActivity)
	}

	grandkid, ok := byID["grandkid"]
	if !ok {
		t.Fatalf("caller does not list its grandchild: %v", keysOf(byID))
	}
	if grandkid.ParentID != "kid1" {
		t.Errorf("grandkid parentId = %q, want kid1", grandkid.ParentID)
	}
	if !strings.Contains(grandkid.Note, `subagent of your subagent "Kid One"`) {
		t.Errorf("grandkid note = %q, want it named as a subagent of Kid One", grandkid.Note)
	}

	if _, ok := byID["aliencub"]; ok {
		t.Error("another tree's subagent is listed")
	}
	if alien, ok := byID["alien"]; !ok || alien.ParentID != "" {
		t.Errorf("top-level alien row = %+v, want it listed without a parentId", alien)
	}
}

// A subagent caller lists its own children only: not its siblings, not
// another tree's subagents — and not itself.
func TestSessionListShowsSubagentCallerOnlyItsDescendants(t *testing.T) {
	r := newCoordRig(t, nil)
	ownSubagentTree(r)
	byID := listOwnSubagents(t, r, "kid1")

	if _, ok := byID["grandkid"]; !ok {
		t.Errorf("a subagent does not list its own child: %v", keysOf(byID))
	}
	for _, id := range []string{"kid2", "aliencub", "kid1"} {
		if _, ok := byID[id]; ok {
			t.Errorf("a subagent lists %q: siblings, other trees and itself stay out", id)
		}
	}
	// Top-level sessions are still listed, with the existing notes.
	if _, ok := byID["caller"]; !ok {
		t.Errorf("a subagent no longer lists its parent's row: %v", keysOf(byID))
	}
}

// A listed own-subagent id is still no session_send target, exactly as
// before: the listing names it for task/session_read, never for sends.
func TestSessionSendToListedOwnSubagentStillRefused(t *testing.T) {
	r := newCoordRig(t, nil)
	ownSubagentTree(r)
	byID := listOwnSubagents(t, r, "caller")
	if _, ok := byID["kid1"]; !ok {
		t.Fatalf("precondition: kid1 is not listed: %v", keysOf(byID))
	}
	_, err := r.call("caller", "session_send", map[string]any{"target": "kid1", "text": "hi"})
	refusedWith(t, err, "subagent")

	_, err = r.call("kid1", "session_send", map[string]any{"target": "grandkid", "text": "hi"})
	refusedWith(t, err, "subagent")
	if ps := r.prompts(); len(ps) != 0 {
		t.Errorf("prompts = %+v, want no delivery from a refused send", ps)
	}
}

func keysOf(byID map[string]ownSubagentRow) []string {
	ids := make([]string, 0, len(byID))
	for id := range byID {
		ids = append(ids, id)
	}
	return ids
}
