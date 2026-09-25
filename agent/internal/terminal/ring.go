package terminal

import (
	"bytes"
	"sync"
)

// RingCapacity is the byte ring's size (PROTOCOL.md §9.2, §5.2 of the plan):
// enough scrollback for a viewer to reattach without a gap, small enough to
// bound one terminal's memory.
const RingCapacity = 2 << 20

// newlineAlignWindow is how far into a freshly evicted ring Ring looks for a
// '\n' to advance past, so a replay after eviction rarely begins mid-escape
// or mid-line (PROTOCOL.md §9.2, plan §5.2).
const newlineAlignWindow = 4 << 10

// Ring is a fixed-capacity byte buffer with absolute offsets: byte i of
// everything ever written lives at buf[i-start] while start <= i < total,
// and is gone once evicted. Safe for concurrent use.
type Ring struct {
	mu    sync.Mutex
	buf   []byte
	start int64 // absolute offset of buf[0]
	total int64 // absolute offset one past the last byte written
}

// NewRing builds an empty ring of RingCapacity bytes.
func NewRing() *Ring { return &Ring{} }

// Write appends p, evicting from the front once the buffer exceeds
// RingCapacity, then aligning the new start just after a '\n' found in the
// first newlineAlignWindow bytes of what remains (if any).
func (r *Ring) Write(p []byte) {
	if len(p) == 0 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf = append(r.buf, p...)
	r.total += int64(len(p))
	if len(r.buf) > RingCapacity {
		overflow := len(r.buf) - RingCapacity
		r.buf = r.buf[overflow:]
		r.start += int64(overflow)
		r.alignStartLocked()
	}
}

func (r *Ring) alignStartLocked() {
	limit := newlineAlignWindow
	if limit > len(r.buf) {
		limit = len(r.buf)
	}
	if idx := bytes.IndexByte(r.buf[:limit], '\n'); idx >= 0 {
		r.buf = r.buf[idx+1:]
		r.start += int64(idx + 1)
	}
}

// Bounds returns the offset range the ring currently holds: [start, total).
func (r *Ring) Bounds() (start, total int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.start, r.total
}

// Read returns everything held from max(from, ring start) to the current
// total, plus whether from had already been evicted (or was negative,
// which reattach never sends but which Manager also treats as "no offset
// given") — the wire's `reset` (PROTOCOL.md §9.3 terminal.attach). The
// caller layer additionally treats "no `from` at all" as reset regardless of
// the ring's start, since a request with no offset is asking to start over.
func (r *Ring) Read(from int64) (data []byte, evicted bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	evicted = from < r.start
	effective := from
	if effective < r.start {
		effective = r.start
	}
	if effective > r.total {
		effective = r.total
	}
	out := make([]byte, r.total-effective)
	copy(out, r.buf[effective-r.start:])
	return out, evicted
}
