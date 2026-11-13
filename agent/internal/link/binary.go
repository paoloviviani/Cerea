package link

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// Binary frame kinds (PROTOCOL.md §9.2). Sent only on a channel Cerea opened
// with terminal.attach, so a peer that predates them never receives one.
const (
	BinTermOutput byte = 0x01 // M→C
	BinTermInput  byte = 0x02 // C→M
	BinTermAck    byte = 0x03 // C→M
	// BinBrowserFrame is one screencast frame of the browser runtime's live
	// view (ADR 0116 phase 2a). M→C only, on the channel of the mcp
	// connection to the runtime: offset is the frame's sequence number and the
	// payload is BrowserFramePayload.
	BinBrowserFrame byte = 0x04 // M→C
	// BinBrowserFramePart is one chunk of a screencast frame too large for
	// one stream-lane write (at most MaxStreamChunk). offset is the frame's
	// sequence number; the payload is u16 BE chunk index, u16 BE chunk count,
	// then that slice of the BinBrowserFrame payload. M→C only.
	BinBrowserFramePart byte = 0x05 // M→C
)

// Wire limits (PROTOCOL.md §9.2).
const (
	MaxChannelIDLen       = 32
	MaxOutputFramePayload = 32 << 10
	MaxInputFramePayload  = 16 << 10
)

// MaxBrowserFramePayload bounds one screencast frame's payload, so a frame
// (header plus payload) stays within the 1 MiB frame cap.
const MaxBrowserFramePayload = 1<<20 - 128

// BrowserFrameParts cuts a BrowserFramePayload into chunk payloads
// (BinBrowserFramePart) of at most MaxOutputFramePayload bytes each, so every
// stream-lane write stays within the 32 KiB rule. A payload that fits is sent
// whole as a BinBrowserFrame instead, and this returns nil.
func BrowserFrameParts(payload []byte) [][]byte {
	if len(payload) <= MaxOutputFramePayload {
		return nil
	}
	const data = MaxOutputFramePayload - 4
	count := (len(payload) + data - 1) / data
	parts := make([][]byte, 0, count)
	for i := 0; i < count; i++ {
		end := (i + 1) * data
		if end > len(payload) {
			end = len(payload)
		}
		part := make([]byte, 4+end-i*data)
		binary.BigEndian.PutUint16(part[0:], uint16(i))
		binary.BigEndian.PutUint16(part[2:], uint16(count))
		copy(part[4:], payload[i*data:end])
		parts = append(parts, part)
	}
	return parts
}

// BrowserFramePayload lays out a BinBrowserFrame payload: u16 big-endian page
// viewport width, u16 height (CSS pixels, the coordinate space of the user's
// input), then the JPEG bytes.
func BrowserFramePayload(width, height uint16, jpeg []byte) []byte {
	out := make([]byte, 4+len(jpeg))
	binary.BigEndian.PutUint16(out[0:], width)
	binary.BigEndian.PutUint16(out[2:], height)
	copy(out[4:], jpeg)
	return out
}

// ErrShortFrame and ErrBadChannelLen are BinaryFrame decode failures — never
// a panic, whatever bytes arrive (this header parser is fuzzed).
var (
	ErrShortFrame    = errors.New("link: binary frame too short")
	ErrBadChannelLen = errors.New("link: binary frame channel id length out of range")
)

// BinaryFrame is one decoded terminal-stream frame (PROTOCOL.md §9.2):
//
//	byte 0        kind
//	byte 1        L (channel id length, 1..32)
//	bytes 2..L+1  channel id
//	next 8 bytes  u64 big-endian offset
//	rest          payload
type BinaryFrame struct {
	Kind    byte
	Channel string
	Offset  uint64
	Payload []byte
}

// EncodeBinaryFrame renders f as wire bytes.
func EncodeBinaryFrame(f BinaryFrame) ([]byte, error) {
	if len(f.Channel) < 1 || len(f.Channel) > MaxChannelIDLen {
		return nil, fmt.Errorf("%w: got %d", ErrBadChannelLen, len(f.Channel))
	}
	buf := make([]byte, 2+len(f.Channel)+8+len(f.Payload))
	buf[0] = f.Kind
	buf[1] = byte(len(f.Channel))
	copy(buf[2:], f.Channel)
	binary.BigEndian.PutUint64(buf[2+len(f.Channel):], f.Offset)
	copy(buf[2+len(f.Channel)+8:], f.Payload)
	return buf, nil
}

// DecodeBinaryFrame parses raw wire bytes into a BinaryFrame. It never
// panics on any input, including truncated or adversarial data (this is the
// header parser FuzzBinaryHeader exercises) — every malformed shape returns
// an error instead. Payload aliases raw; callers that retain it past the
// read buffer's reuse must copy.
func DecodeBinaryFrame(raw []byte) (BinaryFrame, error) {
	if len(raw) < 2 {
		return BinaryFrame{}, ErrShortFrame
	}
	kind := raw[0]
	l := int(raw[1])
	if l < 1 || l > MaxChannelIDLen {
		return BinaryFrame{}, ErrBadChannelLen
	}
	if len(raw) < 2+l+8 {
		return BinaryFrame{}, ErrShortFrame
	}
	channel := string(raw[2 : 2+l])
	offset := binary.BigEndian.Uint64(raw[2+l : 2+l+8])
	payload := raw[2+l+8:]
	return BinaryFrame{Kind: kind, Channel: channel, Offset: offset, Payload: payload}, nil
}
