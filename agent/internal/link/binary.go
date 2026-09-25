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
)

// Wire limits (PROTOCOL.md §9.2).
const (
	MaxChannelIDLen       = 32
	MaxOutputFramePayload = 32 << 10
	MaxInputFramePayload  = 16 << 10
)

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
