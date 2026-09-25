package main

import (
	"context"
	"encoding/json"
	"testing"

	"galopin/internal/backend"
)

// listingBackend answers ListSessions with a fixed tree; everything else is
// the panicking fakeBackend's.
type listingBackend struct {
	fakeBackend
	sessions []backend.Session
}

func (l *listingBackend) ListSessions(context.Context, string) ([]backend.Session, error) {
	return l.sessions, nil
}

// TestSessionListCarriesSubagents pins that session.list lists subagents
// (M4 hid them) with parentId and rootId, and that a parent carries a
// childSummary, even when the child is listed before its parent.
func TestSessionListCarriesSubagents(t *testing.T) {
	back := &listingBackend{sessions: []backend.Session{
		{ID: "child", ParentID: "parent", Status: backend.StatusBusy, Title: "Researcher"},
		{ID: "parent", Status: backend.StatusBusy, Title: "Main"},
	}}
	mc := newTestMachine(t, back)
	if _, err := mc.workspaces.Create("ws", t.TempDir(), nil); err != nil {
		t.Fatal(err)
	}

	res, operr := mc.Handle(context.Background(), "session.list", json.RawMessage(`{}`))
	if operr != nil {
		t.Fatalf("session.list: %+v", operr)
	}
	raw, _ := json.Marshal(res)
	var out struct {
		Sessions []backend.Session `json:"sessions"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	byID := map[string]backend.Session{}
	for _, s := range out.Sessions {
		byID[s.ID] = s
	}
	child, ok := byID["child"]
	if !ok {
		t.Fatalf("the subagent is not listed: %s", raw)
	}
	if child.ParentID != "parent" || child.RootID != "parent" {
		t.Errorf("child parentId/rootId = %q/%q, want parent/parent", child.ParentID, child.RootID)
	}
	parent := byID["parent"]
	if parent.RootID != "parent" {
		t.Errorf("parent rootId = %q, want itself", parent.RootID)
	}
	if parent.ChildSummary == nil || parent.ChildSummary.Children != 1 || parent.ChildSummary.Running != 1 {
		t.Errorf("parent childSummary = %+v, want 1 child running", parent.ChildSummary)
	}
}
