package main

import (
	"testing"

	"galopin/internal/backend"
)

// A retry status event rides the wire with its `retry` object; busy does not.
func TestEventToWireStatusRetry(t *testing.T) {
	m := eventToWire(backend.Event{
		Kind: backend.EventStatus, Status: backend.StatusRetry,
		Retry: &backend.RetryInfo{Attempt: 3, Message: "Rate limit exceeded", Next: 99},
	})
	r, ok := m["retry"].(*backend.RetryInfo)
	if m["status"] != backend.StatusRetry || !ok || r.Attempt != 3 || r.Next != 99 {
		t.Fatalf("wire = %+v", m)
	}
	if _, has := eventToWire(backend.Event{Kind: backend.EventStatus, Status: backend.StatusBusy})["retry"]; has {
		t.Error("busy carries retry")
	}
}
