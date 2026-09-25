package link

import (
	"bytes"
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
