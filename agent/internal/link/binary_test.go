package link

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestBinaryFrameRoundTrip(t *testing.T) {
	cases := []BinaryFrame{
		{Kind: BinTermOutput, Channel: "c1", Offset: 0, Payload: nil},
		{Kind: BinTermOutput, Channel: "abcXYZ_-09", Offset: 1<<63 - 1, Payload: []byte("hello world")},
		{Kind: BinTermInput, Channel: "x", Offset: 0, Payload: []byte{0x1b, '[', 'A'}},
		{Kind: BinTermAck, Channel: "channel-32-chars-long-exactly32", Offset: 12345, Payload: nil},
	}
	for _, c := range cases {
		encoded, err := EncodeBinaryFrame(c)
		if err != nil {
			t.Fatalf("encode %+v: %v", c, err)
		}
		decoded, err := DecodeBinaryFrame(encoded)
		if err != nil {
			t.Fatalf("decode %+v: %v", c, err)
		}
		if decoded.Kind != c.Kind || decoded.Channel != c.Channel || decoded.Offset != c.Offset || !bytes.Equal(decoded.Payload, c.Payload) {
			t.Fatalf("round trip mismatch: got %+v, want %+v", decoded, c)
		}
	}
}

func TestEncodeBinaryFrameRejectsBadChannel(t *testing.T) {
	if _, err := EncodeBinaryFrame(BinaryFrame{Kind: BinTermOutput, Channel: "", Payload: nil}); err == nil {
		t.Fatal("expected an error for an empty channel id")
	}
	tooLong := make([]byte, MaxChannelIDLen+1)
	for i := range tooLong {
		tooLong[i] = 'a'
	}
	if _, err := EncodeBinaryFrame(BinaryFrame{Kind: BinTermOutput, Channel: string(tooLong)}); err == nil {
		t.Fatal("expected an error for an over-length channel id")
	}
}

func TestDecodeBinaryFrameRejectsShortAndMalformed(t *testing.T) {
	cases := [][]byte{
		nil,
		{},
		{0x01},
		{0x01, 5}, // says channel len 5 but nothing follows
		{0x01, 0}, // channel len 0 is out of range (min 1)
		{0x01, 33},
		append([]byte{0x01, 2, 'a', 'b'}, make([]byte, 7)...), // 7 bytes of an 8-byte offset
	}
	for i, raw := range cases {
		if _, err := DecodeBinaryFrame(raw); err == nil {
			t.Fatalf("case %d: expected an error for %x", i, raw)
		}
	}
}

// FuzzBinaryHeader is the header-parser fuzz test the brief requires
// (`go test -run=NONE -fuzz=FuzzBinaryHeader`): DecodeBinaryFrame must
// never panic on any byte sequence, however malformed.
func FuzzBinaryHeader(f *testing.F) {
	seeds := [][]byte{
		nil,
		{},
		{0x01},
		{0x01, 0},
		{0x01, 1, 'a'},
		{0x01, 1, 'a', 0, 0, 0, 0, 0, 0, 0, 1},
		{0x01, 2, 'a', 'b', 0, 0, 0, 0, 0, 0, 0, 0, 'h', 'i'},
		{0x02, 32, 'c', 'h', 'a', 'n', 'n', 'e', 'l', '-', '3', '2', '-', 'c', 'h', 'a', 'r', 's', '-', 'l', 'o', 'n', 'g', '-', 'e', 'x', 'a', 'c', 't', 'l', 'y', '3', '2', 0, 0, 0, 0, 0, 0, 0, 0},
		{0x03, 200},
		{0xff, 255, 0, 0},
		bytes.Repeat([]byte{0xaa}, 200),
	}
	for _, s := range seeds {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		frame, err := DecodeBinaryFrame(data)
		if err != nil {
			return
		}
		// A successful decode must round trip through Encode without losing
		// or corrupting anything the header claimed.
		reencoded, encErr := EncodeBinaryFrame(frame)
		if encErr != nil {
			t.Fatalf("re-encoding a successfully decoded frame failed: %v (frame=%+v)", encErr, frame)
		}
		redecoded, err := DecodeBinaryFrame(reencoded)
		if err != nil {
			t.Fatalf("re-decoding a re-encoded frame failed: %v", err)
		}
		if redecoded.Kind != frame.Kind || redecoded.Channel != frame.Channel || redecoded.Offset != frame.Offset || !bytes.Equal(redecoded.Payload, frame.Payload) {
			t.Fatalf("re-decoded frame mismatch: got %+v, want %+v", redecoded, frame)
		}
	})
}

func TestBrowserFramePartsCutALargeFrameIntoStreamLaneChunks(t *testing.T) {
	if BrowserFrameParts(make([]byte, MaxOutputFramePayload)) != nil {
		t.Fatal("a frame that fits is sent whole")
	}
	payload := make([]byte, 700_000)
	for i := range payload {
		payload[i] = byte(i * 7)
	}
	parts := BrowserFrameParts(payload)
	var back []byte
	for i, p := range parts {
		if len(p) > MaxOutputFramePayload {
			t.Fatalf("chunk %d is %d bytes, over the 32 KiB stream-lane cap", i, len(p))
		}
		wire, err := EncodeBinaryFrame(BinaryFrame{Kind: BinBrowserFramePart, Channel: "ch_0123456789ab", Offset: 1, Payload: p})
		if err != nil || len(wire) > MaxOutputFramePayload+2+MaxChannelIDLen+8 {
			t.Fatalf("chunk %d: frame of %d bytes (%v)", i, len(wire), err)
		}
		if int(binary.BigEndian.Uint16(p[0:])) != i || int(binary.BigEndian.Uint16(p[2:])) != len(parts) {
			t.Fatalf("chunk %d header = % x (of %d)", i, p[:4], len(parts))
		}
		back = append(back, p[4:]...)
	}
	if !bytes.Equal(back, payload) {
		t.Fatal("the chunks do not add up to the frame")
	}
}
