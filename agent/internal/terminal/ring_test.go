package terminal

import (
	"bytes"
	"testing"
)

func TestRingReadWithinBounds(t *testing.T) {
	r := NewRing()
	r.Write([]byte("hello "))
	r.Write([]byte("world"))
	data, evicted := r.Read(0)
	if evicted {
		t.Fatal("nothing evicted yet")
	}
	if string(data) != "hello world" {
		t.Fatalf("got %q", data)
	}
	data, evicted = r.Read(6)
	if evicted {
		t.Fatal("6 is still within bounds")
	}
	if string(data) != "world" {
		t.Fatalf("got %q", data)
	}
}

// TestRingEvictionAndNewlineAlignedStart exercises PROTOCOL.md §9.2's ring
// eviction rule: once the ring exceeds RingCapacity, its start advances past
// the raw overflow and then further, to just after a '\n' found in the
// first newlineAlignWindow bytes — so a reattach after eviction resumes on
// a line boundary rather than mid-line.
func TestRingEvictionAndNewlineAlignedStart(t *testing.T) {
	r := NewRing()
	line := append(bytes.Repeat([]byte("x"), 100), '\n')
	written := 0
	for written < RingCapacity+10*len(line) {
		r.Write(line)
		written += len(line)
	}
	start, end := r.Bounds()
	if start == 0 {
		t.Fatal("expected eviction to have advanced the ring start")
	}
	if end-start > RingCapacity {
		t.Fatalf("ring holds more than capacity: %d bytes", end-start)
	}
	data, evicted := r.Read(start)
	if evicted {
		t.Fatal("the ring's own start should not itself be reported evicted")
	}
	// Every write is the identical 101-byte line ('x'*100 + '\n'), so a
	// properly newline-aligned start must begin with a complete, unbroken
	// copy of that line — not a partial tail of one.
	if !bytes.HasPrefix(data, line) {
		got := data
		if len(got) > len(line) {
			got = got[:len(line)]
		}
		t.Fatalf("ring start %d does not begin a fresh line: got %q, want prefix %q", start, got, line)
	}
}

func TestRingReadEvictedOffsetReportsEviction(t *testing.T) {
	r := NewRing()
	r.Write(bytes.Repeat([]byte("a"), RingCapacity+1000))
	start, _ := r.Bounds()
	if start == 0 {
		t.Fatal("expected some eviction")
	}
	if _, evicted := r.Read(0); !evicted {
		t.Fatal("offset 0 should be reported evicted")
	}
	if _, evicted := r.Read(start); evicted {
		t.Fatal("the ring's own start should not be reported evicted")
	}
}
