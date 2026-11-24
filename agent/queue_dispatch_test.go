package main

import (
	"context"
	"encoding/json"
	"testing"

	"galopin/internal/backend"
)

type queueBackend struct {
	fakeBackend
	dequeued []string
}

func (q *queueBackend) Capabilities() backend.Capabilities { return backend.Capabilities{Queue: true} }
func (q *queueBackend) Dequeue(_ context.Context, _, _, id string) error {
	if id == "gone" {
		return backend.ErrNotQueued
	}
	q.dequeued = append(q.dequeued, id)
	return nil
}

func TestOpSessionDequeue(t *testing.T) {
	back := &queueBackend{}
	mc := newTestMachine(t, back)
	trackTestSession(t, mc, "s1")
	ctx := context.Background()
	if _, operr := mc.Handle(ctx, "session.dequeue", json.RawMessage(`{"sessionId":"s1","id":"c2"}`)); operr != nil {
		t.Fatalf("dequeue: %+v", operr)
	}
	if len(back.dequeued) != 1 || back.dequeued[0] != "c2" {
		t.Fatalf("dequeued = %v", back.dequeued)
	}
	if _, operr := mc.Handle(ctx, "session.dequeue", json.RawMessage(`{"sessionId":"s1","id":"gone"}`)); operr == nil || operr.Code != "not_found" {
		t.Fatalf("a prompt already sent = %+v, want not_found", operr)
	}
	if _, operr := mc.Handle(ctx, "session.dequeue", json.RawMessage(`{"sessionId":"s1"}`)); operr == nil || operr.Code != "invalid" {
		t.Fatalf("no id = %+v, want invalid", operr)
	}
}

func TestOpSessionDequeueUnsupportedBackend(t *testing.T) {
	mc := newTestMachine(t, &fakeBackend{})
	trackTestSession(t, mc, "s1")
	_, operr := mc.Handle(context.Background(), "session.dequeue", json.RawMessage(`{"sessionId":"s1","id":"c2"}`))
	if operr == nil || operr.Code != "unsupported" {
		t.Fatalf("dequeue on a backend without a queue = %+v, want unsupported", operr)
	}
}
