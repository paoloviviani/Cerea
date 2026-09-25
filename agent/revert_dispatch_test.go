package main

import (
	"context"
	"encoding/json"
	"testing"

	"galopin/internal/backend"
)

// revertingBackend is fakeBackend plus the revert capability, recording calls.
type revertingBackend struct {
	fakeBackend
	reverted   []string
	unreverted []string
}

func (r *revertingBackend) Capabilities() backend.Capabilities {
	return backend.Capabilities{Revert: true, RevertFiles: true}
}
func (r *revertingBackend) Revert(_ context.Context, _, sessionID, messageID string) error {
	r.reverted = append(r.reverted, sessionID+"@"+messageID)
	return nil
}
func (r *revertingBackend) Unrevert(_ context.Context, _, sessionID string) error {
	r.unreverted = append(r.unreverted, sessionID)
	return nil
}

func TestOpSessionRevert(t *testing.T) {
	back := &revertingBackend{}
	mc := newTestMachine(t, back)
	trackTestSession(t, mc, "s1")
	ctx := context.Background()

	if _, operr := mc.Handle(ctx, "session.revert", json.RawMessage(`{"sessionId":"s1"}`)); operr == nil || operr.Code != "invalid" {
		t.Fatalf("revert without messageId = %+v, want invalid", operr)
	}
	if _, operr := mc.Handle(ctx, "session.revert", json.RawMessage(`{"sessionId":"s1","messageId":"m2"}`)); operr != nil {
		t.Fatalf("revert: %+v", operr)
	}
	if _, operr := mc.Handle(ctx, "session.unrevert", json.RawMessage(`{"sessionId":"s1"}`)); operr != nil {
		t.Fatalf("unrevert: %+v", operr)
	}
	if len(back.reverted) != 1 || back.reverted[0] != "s1@m2" || len(back.unreverted) != 1 {
		t.Fatalf("calls = %v / %v", back.reverted, back.unreverted)
	}
}

// A mid-turn session is refused rather than rolled back under a running turn.
func TestOpSessionRevertRefusesMidTurn(t *testing.T) {
	back := &revertingBackend{}
	mc := newTestMachine(t, back)
	trackTestSession(t, mc, "s1")
	mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{
		SessionID: "s1", Event: backend.Event{Kind: backend.EventStatus, Status: backend.StatusBusy},
	})
	_, operr := mc.Handle(context.Background(), "session.revert", json.RawMessage(`{"sessionId":"s1","messageId":"m2"}`))
	if operr == nil || operr.Code != "invalid" || len(back.reverted) != 0 {
		t.Fatalf("revert mid-turn = %+v (calls %v), want invalid and no call", operr, back.reverted)
	}
}

func TestOpSessionRevertUnsupportedBackend(t *testing.T) {
	mc := newTestMachine(t, &fakeBackend{})
	trackTestSession(t, mc, "s1")
	_, operr := mc.Handle(context.Background(), "session.revert", json.RawMessage(`{"sessionId":"s1","messageId":"m2"}`))
	if operr == nil || operr.Code != "unsupported" {
		t.Fatalf("revert on a backend without it = %+v, want unsupported", operr)
	}
}
