package acp

import (
	"context"
	"testing"

	"galopin/internal/backend"
)

func TestUsageAndCompactAreOffOnlyWhenConfigured(t *testing.T) {
	plain := New(Config{Logf: func(string, ...any) {}})
	if c := plain.Capabilities(); c.Usage || c.Compact {
		t.Errorf("a plain ACP agent advertises usage=%v compact=%v", c.Usage, c.Compact)
	}
	if err := plain.Compact(context.Background(), "/w", "s"); err == nil {
		t.Error("Compact without a command succeeded")
	}
	goose := New(Config{Usage: true, CompactCommand: "/compact", Logf: func(string, ...any) {}})
	if c := goose.Capabilities(); !c.Usage || !c.Compact {
		t.Errorf("configured: usage=%v compact=%v", c.Usage, c.Compact)
	}
}

func TestRecordUsageEmitsAndKeepsTheLatest(t *testing.T) {
	b := New(Config{Usage: true, Logf: func(string, ...any) {}})
	ch, _ := b.Subscribe(context.Background())
	b.reg.getOrCreate("s1", "/w")
	b.RecordUsage("nope", backend.Usage{Input: 1}) // unknown session: nothing
	max := 1000
	b.RecordUsage("s1", backend.Usage{Input: 5, ContextUsed: 5, ContextMax: &max})
	ev := <-ch
	if ev.SessionID != "s1" || ev.Event.Kind != backend.EventUsage || ev.Event.Usage.ContextUsed != 5 {
		t.Fatalf("event = %+v", ev)
	}
	st, _ := b.reg.get("s1")
	if s := st.toSession("acp"); s.Usage == nil || s.Usage.Input != 5 {
		t.Errorf("session usage = %+v", s.Usage)
	}
}
