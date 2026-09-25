package main

import (
	"context"
	"encoding/json"
	"testing"

	"galopin/internal/backend"
)

type effortBackend struct {
	fakeBackend
	efforts []string
}

func (e *effortBackend) Capabilities() backend.Capabilities {
	return backend.Capabilities{Efforts: true}
}
func (e *effortBackend) SetEffort(_ context.Context, _, sessionID, effort string) (backend.Session, error) {
	e.efforts = append(e.efforts, effort)
	return backend.Session{ID: sessionID, Effort: effort}, nil
}

func TestOpSessionSetEffort(t *testing.T) {
	back := &effortBackend{}
	mc := newTestMachine(t, back)
	trackTestSession(t, mc, "s1")
	ctx := context.Background()

	if _, operr := mc.Handle(ctx, "session.setEffort", json.RawMessage(`{"sessionId":"s1","effort":"high"}`)); operr != nil {
		t.Fatalf("setEffort: %+v", operr)
	}
	if _, operr := mc.Handle(ctx, "session.setEffort", json.RawMessage(`{"sessionId":"s1","effort":null}`)); operr != nil {
		t.Fatalf("clearing: %+v", operr)
	}
	if _, operr := mc.Handle(ctx, "session.setEffort", json.RawMessage(`{"sessionId":"s1","effort":""}`)); operr == nil || operr.Code != "invalid" {
		t.Fatalf("empty effort = %+v, want invalid", operr)
	}
	if len(back.efforts) != 2 || back.efforts[0] != "high" || back.efforts[1] != "" {
		t.Fatalf("SetEffort calls = %q", back.efforts)
	}
}

func TestOpSessionSetEffortUnsupportedBackend(t *testing.T) {
	mc := newTestMachine(t, &fakeBackend{})
	trackTestSession(t, mc, "s1")
	_, operr := mc.Handle(context.Background(), "session.setEffort", json.RawMessage(`{"sessionId":"s1","effort":"high"}`))
	if operr == nil || operr.Code != "unsupported" {
		t.Fatalf("setEffort on a backend without it = %+v, want unsupported", operr)
	}
}
