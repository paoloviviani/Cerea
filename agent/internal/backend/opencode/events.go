package opencode

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"galopin/internal/backend"
)

const (
	eventStreamMinBackoff = time.Second
	eventStreamMaxBackoff = 30 * time.Second
)

// Subscribe streams every session's events from GET /global/event (SSE,
// all directories). It reconnects on its own with backoff whenever the
// stream ends — including every time opencode itself restarts underneath
// it — for as long as ctx lives; the returned channel only closes when ctx
// is done.
//
// Backend-generated events (a late command failure) merge into the same
// stream through an internal channel, so a subscriber sees one ordered
// event flow per process and needs no second path for them.
func (b *Backend) Subscribe(ctx context.Context) (<-chan backend.BackendEvent, error) {
	out := make(chan backend.BackendEvent, 256)
	sse := make(chan backend.BackendEvent, 256)
	inject := make(chan backend.BackendEvent, 64)
	b.injectMu.Lock()
	b.injectCh = inject
	b.injectMu.Unlock()
	go func() {
		// subscribeLoop closes sse itself when it ends (its own defer); the
		// pump below only drains.
		b.subscribeLoop(ctx, sse)
	}()
	go func() {
		defer close(out)
		for sse != nil || inject != nil {
			select {
			case <-ctx.Done():
				return
			case ev, ok := <-sse:
				if !ok {
					sse = nil
					continue
				}
				select {
				case out <- ev:
				case <-ctx.Done():
					return
				}
			case ev, ok := <-inject:
				if !ok {
					inject = nil
					continue
				}
				select {
				case out <- ev:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out, nil
}

func (b *Backend) subscribeLoop(ctx context.Context, out chan<- backend.BackendEvent) {
	defer close(out)
	delay := eventStreamMinBackoff
	for {
		if ctx.Err() != nil {
			return
		}
		err := b.streamOnce(ctx, out)
		if ctx.Err() != nil {
			return
		}
		b.cfg.Logf("opencode: event stream ended (%v), reconnecting in %s", err, delay)
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		delay *= 2
		if delay > eventStreamMaxBackoff {
			delay = eventStreamMaxBackoff
		}
	}
}

func (b *Backend) streamOnce(ctx context.Context, out chan<- backend.BackendEvent) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, b.baseURL()+"/global/event", nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth("opencode", b.cfg.Password)
	resp, err := b.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	// Lines are read with a bounded reader, not bufio.Scanner: a tool part
	// carries its images inline as data: URLs, so one message.part.updated
	// line can be tens of MiB, and Scanner's ErrTooLong would end the stream
	// for every session. An oversized line is skipped and its session resynced.
	reader := bufio.NewReaderSize(resp.Body, 64*1024)
	limit := b.cfg.SSEMaxLineBytes
	if limit <= 0 {
		limit = defaultSSEMaxLine
	}
	var dataLines []string
	var oversized *oversizedLine
	flush := func() {
		if oversized != nil {
			b.resyncAfterOversized(oversized, out)
			oversized = nil
		}
		if len(dataLines) == 0 {
			return
		}
		raw := strings.Join(dataLines, "\n")
		dataLines = nil
		b.handleSSEData(raw, out)
	}
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		line, big, err := readBoundedLine(reader, limit)
		switch {
		case big != nil:
			oversized = big
		case line == "":
			if err == nil {
				flush()
			}
		case strings.HasPrefix(line, "data:"):
			dataLines = append(dataLines, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		default:
			// event:/id:/comment lines and anything else are not needed.
		}
		if err != nil {
			flush()
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

// sseFrame is GET /global/event's per-message envelope: {directory,
// payload:{id,type,properties}}.
type sseFrame struct {
	Directory string         `json:"directory"`
	Payload   map[string]any `json:"payload"`
}

func (b *Backend) handleSSEData(raw string, out chan<- backend.BackendEvent) {
	var frame sseFrame
	if json.Unmarshal([]byte(raw), &frame) != nil || frame.Payload == nil {
		return
	}
	typ, _ := frame.Payload["type"].(string)
	props, _ := frame.Payload["properties"].(map[string]any)
	if props == nil {
		props = map[string]any{}
	}
	for _, be := range b.translateEvent(frame.Directory, typ, props) {
		out <- be
	}
}

// translateEvent turns one opencode SSE payload into zero or more
// normalized BackendEvents. Unknown types are dropped (PROTOCOL.md §5:
// unknown event kinds are ignored by both sides).
func (b *Backend) translateEvent(directory, typ string, props map[string]any) []backend.BackendEvent {
	sessionID := getStr(props, "sessionID", "sessionId", "id")

	wrap := func(sessionID string, ev backend.Event) backend.BackendEvent {
		return backend.BackendEvent{WorkspaceDir: directory, SessionID: sessionID, Event: ev}
	}

	switch typ {
	case "session.created", "session.updated":
		info := getMap(props, "info")
		if info == nil {
			info = props
		}
		sess := sessionFromMap(info)
		if sess.ID == "" {
			return nil
		}
		return []backend.BackendEvent{wrap(sess.ID, backend.Event{Kind: backend.EventSession, Session: &sess})}

	case "session.status":
		status := getMap(props, "status")
		state := getStr(status, "type")
		var s backend.SessionStatus
		switch state {
		case "busy":
			s = backend.StatusBusy
		case "retry":
			s = backend.StatusRetry
		default:
			s = backend.StatusIdle
		}
		return []backend.BackendEvent{wrap(sessionID, backend.Event{Kind: backend.EventStatus, Status: s})}

	case "session.idle":
		return []backend.BackendEvent{wrap(sessionID, backend.Event{Kind: backend.EventStatus, Status: backend.StatusIdle})}

	case "session.error":
		return []backend.BackendEvent{wrap(sessionID, backend.Event{
			Kind:         backend.EventError,
			ErrorMessage: getStr(props, "message"),
			ErrorCode:    getStr(props, "code"),
		})}

	case "session.diff":
		// Surfaced through the Differ capability's own poll (session.diff
		// op), not the event stream — opencode tells us a diff changed, but
		// the normalized Event set has no diff-content event; dropped here
		// deliberately rather than approximated.
		return nil

	case "message.updated":
		info := getMap(props, "info")
		if info == nil {
			return nil
		}
		msg := messageFromMap(info)
		if msg.ID == "" {
			return nil
		}
		sid := getStr(info, "sessionID", "sessionId")
		if sid == "" {
			sid = sessionID
		}
		b.resolveClientMessageID(sid, &msg)
		events := []backend.BackendEvent{wrap(sid, backend.Event{Kind: backend.EventMessage, Message: &msg})}
		if msg.Role == "assistant" {
			if u := usageFromMessageMap(info); u != nil {
				b.fillContextMax(info, u)
				b.setSessionUsage(sid, u)
				events = append(events, wrap(sid, backend.Event{Kind: backend.EventUsage, Usage: u}))
			}
		}
		return events

	case "message.part.updated":
		partMap := getMap(props, "part")
		if partMap == nil {
			return nil
		}
		sid := getStr(partMap, "sessionID", "sessionId")
		if sid == "" {
			sid = sessionID
		}
		part := b.mapPart(sid, partMap)
		return []backend.BackendEvent{wrap(sid, backend.Event{Kind: backend.EventPart, Part: &part})}

	case "message.part.delta":
		return []backend.BackendEvent{wrap(sessionID, backend.Event{
			Kind:      backend.EventDelta,
			MessageID: getStr(props, "messageID", "messageId"),
			PartID:    getStr(props, "partID", "partId"),
			Field:     getStr(props, "field"),
			Delta:     getStr(props, "delta"),
		})}

	case "message.part.removed":
		return []backend.BackendEvent{wrap(sessionID, backend.Event{
			Kind:      backend.EventPartRemoved,
			MessageID: getStr(props, "messageID", "messageId"),
			PartID:    getStr(props, "partID", "partId"),
		})}

	case "permission.asked":
		req := permissionFromMap(props)
		if req.ID == "" {
			return nil
		}
		return []backend.BackendEvent{wrap(req.SessionID, backend.Event{Kind: backend.EventPermissionAsked, Request: &req})}

	case "permission.replied":
		return []backend.BackendEvent{wrap(sessionID, backend.Event{
			Kind:      backend.EventPermissionReplied,
			RequestID: getStr(props, "requestID", "requestId"),
			Decision:  backend.Decision(getStr(props, "reply")),
			By:        "user",
		})}

	case "question.asked":
		req := questionRequestFromMap(props)
		if req.id == "" {
			return nil
		}
		return []backend.BackendEvent{wrap(req.sessionID, backend.Event{
			Kind:              backend.EventQuestionAsked,
			QuestionRequestID: req.id,
			Questions:         req.questions,
			QuestionCallID:    req.callID,
		})}

	case "question.replied":
		var answers [][]string
		for _, raw := range getSlice(props, "answers") {
			answers = append(answers, asStrings(raw))
		}
		return []backend.BackendEvent{wrap(sessionID, backend.Event{
			Kind:              backend.EventQuestionResolved,
			QuestionRequestID: getStr(props, "requestID", "requestId"),
			QuestionDecision:  "answered",
			QuestionAnswers:   answers,
		})}

	case "question.rejected":
		return []backend.BackendEvent{wrap(sessionID, backend.Event{
			Kind:              backend.EventQuestionResolved,
			QuestionRequestID: getStr(props, "requestID", "requestId"),
			QuestionDecision:  "rejected",
		})}

	case "todo.updated":
		var todos []backend.Todo
		for _, tm := range asMaps(getSlice(props, "todos")) {
			todos = append(todos, todoFromMap(tm))
		}
		return []backend.BackendEvent{wrap(sessionID, backend.Event{Kind: backend.EventTodo, Todos: todos})}

	case "server.heartbeat":
		return nil

	default:
		return nil
	}
}

// fillContextMax looks up the model's published context window (cached
// from the last Models() call) and sets u.ContextMax from it, when the
// message names a model this process has seen.
func (b *Backend) fillContextMax(info map[string]any, u *backend.Usage) {
	providerID := getStr(info, "providerID", "providerId")
	modelID := getStr(info, "modelID", "modelId")
	if providerID == "" || modelID == "" {
		return
	}
	b.modelsMu.Lock()
	limit, ok := b.modelLimit[providerID+"/"+modelID]
	b.modelsMu.Unlock()
	if ok {
		max := limit
		u.ContextMax = &max
	}
}

// defaultSSEMaxLine bounds one SSE line. It sits inside the link's own frame
// limit (160 MiB) and above what eight full-size screenshots need inline.
const defaultSSEMaxLine = 128 << 20

// oversizedLine is what is kept of a line past the limit: enough of its head
// to say whose event it was.
type oversizedLine struct {
	head string
	size int
}

// readBoundedLine reads one line (without its newline). A line longer than
// limit is consumed to its end without being kept and reported in big, so the
// stream carries on; err is the reader's, with a final unterminated line still
// returned alongside io.EOF.
func readBoundedLine(r *bufio.Reader, limit int) (line string, big *oversizedLine, err error) {
	var buf []byte
	total := 0
	for {
		chunk, e := r.ReadSlice('\n')
		total += len(chunk)
		if total <= limit {
			buf = append(buf, chunk...)
		} else {
			if big == nil {
				buf = append(buf, chunk...)
				head := buf
				if len(head) > 64*1024 {
					head = head[:64*1024]
				}
				big = &oversizedLine{head: string(head)}
				buf = nil
			}
		}
		if e == bufio.ErrBufferFull {
			continue
		}
		err = e
		break
	}
	if big != nil {
		big.size = total
		return "", big, err
	}
	return strings.TrimRight(string(buf), "\r\n"), nil, err
}

var (
	sseSessionRe   = regexp.MustCompile(`"sessionI[Dd]":"([^"]+)"`)
	sseDirectoryRe = regexp.MustCompile(`"directory":"((?:[^"\\]|\\.)*)"`)
)

// resyncAfterOversized drops the unreadable event and asks for the session's
// transcript to be re-read, so what it carried (the images, the tool's final
// state) arrives through the snapshot path instead. The session is named by
// the head of the line; a line that never says is only logged.
func (b *Backend) resyncAfterOversized(o *oversizedLine, out chan<- backend.BackendEvent) {
	m := sseSessionRe.FindStringSubmatch(o.head)
	b.cfg.Logf("opencode: skipped an oversized event line (%d bytes)", o.size)
	if m == nil {
		return
	}
	dir := ""
	if d := sseDirectoryRe.FindStringSubmatch(o.head); d != nil {
		var s string
		if json.Unmarshal([]byte(`"`+d[1]+`"`), &s) == nil {
			dir = s
		}
	}
	out <- backend.BackendEvent{WorkspaceDir: dir, SessionID: m[1], Event: backend.Event{Kind: backend.EventResync}}
}
