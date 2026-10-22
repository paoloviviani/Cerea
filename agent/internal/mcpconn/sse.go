package mcpconn

import (
	"bufio"
	"bytes"
	"io"
	"strings"
)

// sseEvent is one server-sent event.
type sseEvent struct {
	Event string
	Data  []byte
	ID    string
}

// readSSE reads events from r until it ends, calling fn for each one that
// has data. A data field over limit is dropped (the event is skipped).
func readSSE(r io.Reader, limit int, fn func(sseEvent)) error {
	br := bufio.NewReaderSize(r, 64<<10)
	var ev sseEvent
	var data bytes.Buffer
	var haveData, oversize bool
	var lastID string
	dispatch := func() {
		if haveData && !oversize {
			ev.Data = append([]byte(nil), data.Bytes()...)
			ev.ID = lastID
			fn(ev)
		}
		ev, haveData, oversize = sseEvent{}, false, false
		data.Reset()
	}
	for {
		line, tooLong, err := readLimitedLine(br, limit+64)
		if err != nil {
			if err == io.EOF {
				dispatch()
			}
			return err
		}
		if tooLong {
			oversize = true
			continue
		}
		if len(line) == 0 {
			dispatch()
			continue
		}
		if line[0] == ':' {
			continue
		}
		name, value, _ := strings.Cut(string(line), ":")
		value = strings.TrimPrefix(value, " ")
		switch name {
		case "event":
			ev.Event = value
		case "data":
			if data.Len()+len(value)+1 > limit {
				oversize = true
				continue
			}
			if haveData {
				data.WriteByte('\n')
			}
			data.WriteString(value)
			haveData = true
		case "id":
			lastID = value
		}
	}
}

// readLimitedLine reads one line without its terminator; a line longer than
// limit is consumed and reported as tooLong.
func readLimitedLine(br *bufio.Reader, limit int) (line []byte, tooLong bool, err error) {
	var buf []byte
	for {
		chunk, isPrefix, err := br.ReadLine()
		if err != nil {
			return nil, false, err
		}
		if !tooLong {
			if len(buf)+len(chunk) > limit {
				tooLong = true
				buf = nil
			} else {
				buf = append(buf, chunk...)
			}
		}
		if !isPrefix {
			return buf, tooLong, nil
		}
	}
}
