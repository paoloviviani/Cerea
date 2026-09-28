package opencode

import (
	"crypto/rand"
	"fmt"
	"sync"
	"time"
)

// mintMessageID mints an opencode-style ascending message id: "msg_" plus
// 26 characters, the first 12 of which are the hex of (milliseconds since
// the epoch * 0x1000 + a same-millisecond counter) big-endian, and the rest
// random base62. That is byte-for-byte the shape opencode's own
// Identifier.ascending mints (packages/opencode/src/id/id.ts, verified at
// 1.18.32), so an id this package mints sorts among opencode's own the same
// way opencode itself would place it: later creations sort after earlier
// ones. galopin sends one on every prompt_async (and, in batch A,
// session.command) so the user message's id is known before the turn
// starts, and the clientMessageId can be mapped to it exactly instead of
// guessed from "whichever new user message shows up next".
//
// The counter state mirrors opencode's own process-local monotonic scheme;
// galopin and opencode run on the same machine, so their clocks agree and
// ids minted here interleave with opencode's by creation time.

const (
	msgIDLength     = 26 // total characters after the prefix, as opencode's LENGTH
	msgIDRandom     = msgIDLength - 12
	msgIDTimeHexLen = 12
)

const msgIDBase62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

var (
	msgIDMu         sync.Mutex
	msgIDLastMillis int64
	msgIDCounter    int64
)

func mintMessageID() string {
	msgIDMu.Lock()
	millis := time.Now().UnixMilli()
	if millis != msgIDLastMillis {
		msgIDLastMillis = millis
		msgIDCounter = 0
	}
	msgIDCounter++
	// opencode packs the encoded time into 6 bytes: only the low 48 bits
	// survive, high bits of the timestamp truncated away — monotonicity is
	// preserved (the wrap is a 2^36 ms cycle), and matching the truncation
	// is what makes ids minted here sort among opencode's own.
	encoded := uint64(millis*0x1000+msgIDCounter) & 0xFFFFFFFFFFFF
	msgIDMu.Unlock()

	// The random tail is bytes % 62, same as opencode's randomBase62 — the
	// tiny modulo bias is opencode's own, and matching it exactly is the
	// point.
	raw := make([]byte, msgIDRandom)
	if _, err := rand.Read(raw); err != nil {
		// crypto/rand only fails when the OS entropy source is broken; an
		// all-zero tail is a poorer id but still a valid, ascending one.
		raw = make([]byte, msgIDRandom)
	}
	id := make([]byte, 0, len("msg_")+msgIDLength)
	id = append(id, "msg_"...)
	id = append(id, []byte(fmt.Sprintf("%0*x", msgIDTimeHexLen, encoded))...)
	for _, b := range raw {
		id = append(id, msgIDBase62[int(b)%62])
	}
	return string(id)
}
