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

type forkBackend struct {
	fakeBackend
	got []string
}

func (f *forkBackend) Capabilities() backend.Capabilities {
	return backend.Capabilities{Fork: true, Revert: true}
}
func (f *forkBackend) Fork(_ context.Context, _, sessionID, messageID, title string) (backend.Session, error) {
	f.got = append(f.got, sessionID+"|"+messageID+"|"+title)
	return backend.Session{ID: "forked", Title: title}, nil
}
func (f *forkBackend) Revert(context.Context, string, string, string) error { return nil }
func (f *forkBackend) Unrevert(context.Context, string, string) error {
	return backend.ErrUnrevertUnsupported
}

func TestOpSessionForkAndUnrevertGating(t *testing.T) {
	back := &forkBackend{}
	mc := newTestMachine(t, back)
	trackTestSession(t, mc, "s1")
	ctx := context.Background()
	if _, operr := mc.Handle(ctx, "session.fork", json.RawMessage(`{"sessionId":"s1","messageId":"m3","title":"Fork: x"}`)); operr != nil {
		t.Fatalf("fork: %+v", operr)
	}
	if len(back.got) != 1 || back.got[0] != "s1|m3|Fork: x" {
		t.Fatalf("fork calls = %v", back.got)
	}
	if _, operr := mc.Handle(ctx, "session.unrevert", json.RawMessage(`{"sessionId":"s1"}`)); operr == nil || operr.Code != "unsupported" {
		t.Fatalf("unrevert on an engine that cannot undo = %+v, want unsupported", operr)
	}
	mc2 := newTestMachine(t, &fakeBackend{})
	trackTestSession(t, mc2, "s1")
	if _, operr := mc2.Handle(ctx, "session.fork", json.RawMessage(`{"sessionId":"s1"}`)); operr == nil || operr.Code != "unsupported" {
		t.Fatalf("fork without the capability = %+v", operr)
	}
}
