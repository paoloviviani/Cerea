package mcpconn

import (
	"bytes"
	"encoding/json"
)

// MaxMessageBytes is the largest message that crosses the link (PROTOCOL.md
// §10.3, the 1 MiB frame cap). A transport reads up to maxReadBytes so that a
// message over the cap can still be recognised and answered.
const (
	MaxMessageBytes = 1 << 20
	maxReadBytes    = 16 << 20
)

// transport is one channel's connection to its server.
type transport interface {
	// Send hands one JSON-RPC message (or batch) to the server. It may block
	// on the server's pipe; the channel calls it from its own goroutine.
	Send(msg []byte)
	// Close ends the connection; it returns at once and the transport is
	// finished when Done is closed.
	Close()
	Done() <-chan struct{}
}

// sink is what a transport reports to its channel.
type sink struct {
	// message: one message or batch from the server, exactly as it came.
	message func(raw []byte)
	// closed: the connection ended on its own (never after Close).
	closed func(reason, detail string)
	// authRequired: the server answered 401 with WWW-Authenticate and no
	// stored sign-in could answer it.
	authRequired func()
	logf         func(format string, args ...any)
}

// lineSplitter is an io.Writer that hands each newline-terminated line to
// fn, dropping (and counting) lines over limit.
type lineSplitter struct {
	buf     []byte
	limit   int
	skip    bool
	dropped int
	fn      func(line []byte)
}

func (w *lineSplitter) Write(p []byte) (int, error) {
	n := len(p)
	for len(p) > 0 {
		i := bytes.IndexByte(p, '\n')
		if i < 0 {
			w.add(p)
			break
		}
		w.add(p[:i])
		w.flush()
		p = p[i+1:]
	}
	return n, nil
}

func (w *lineSplitter) add(p []byte) {
	if w.skip {
		return
	}
	if len(w.buf)+len(p) > w.limit {
		w.skip = true
		w.buf = w.buf[:0]
		return
	}
	w.buf = append(w.buf, p...)
}

func (w *lineSplitter) flush() {
	if w.skip {
		w.dropped++
	} else if line := bytes.TrimSpace(w.buf); len(line) > 0 {
		w.fn(line)
	}
	w.buf = w.buf[:0]
	w.skip = false
}

// idsOf returns the compact raw ids of the requests in a message or batch
// (messages with an id and a method).
func requestIDs(raw []byte) []json.RawMessage {
	var out []json.RawMessage
	for _, m := range splitBatch(raw) {
		var h struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if json.Unmarshal(m, &h) == nil && h.Method != "" && len(h.ID) > 0 && string(h.ID) != "null" {
			out = append(out, h.ID)
		}
	}
	return out
}

// splitBatch returns the messages of a batch, or the message itself.
func splitBatch(raw []byte) []json.RawMessage {
	raw = bytes.TrimSpace(raw)
	if len(raw) > 0 && raw[0] == '[' {
		var arr []json.RawMessage
		if json.Unmarshal(raw, &arr) == nil {
			return arr
		}
		return nil
	}
	return []json.RawMessage{raw}
}

// rpcError builds a JSON-RPC error response.
func rpcError(id json.RawMessage, code int, message string) []byte {
	b, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   map[string]any{"code": code, "message": message},
	})
	return b
}
