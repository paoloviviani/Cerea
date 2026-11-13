package mcpconn

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"time"

	"galopin/internal/link"
)

type closeInfo struct {
	reason, detail string
}

// channel is one open connection to a server and the ceiling in front of it.
type channel struct {
	id    string
	hub   *Hub
	entry *Entry
	tr    transport

	queue chan []byte
	stop  chan struct{}

	mu         sync.Mutex
	registered bool
	early      *closeInfo
	closed     bool
	idle       *time.Timer
	listIDs    map[string]bool
	callIDs    map[string]string // request id -> tool

	// Live-view bookkeeping for the audit log (liveCall): whether a screencast
	// is running, and the input calls of the current takeover.
	casting    bool
	inputCalls int
	inputSince time.Time

	// frames is the one-slot, latest-wins mailbox of the screencast sender
	// goroutine (frameSender); frameOnce starts it with the first frame.
	frames    chan outFrame
	frameOnce sync.Once

	// local, when set, takes what would go to Cerea: the channel belongs to
	// galopin's own in-process client (local.go), not to a Cerea chat.
	local func(raw []byte)
	// localClosed tells that client the channel ended.
	localClosed func()
}

func newChannel(h *Hub, e *Entry) *channel {
	return &channel{id: newChannelID(), hub: h, entry: e, queue: make(chan []byte, 256), stop: make(chan struct{}),
		frames:  make(chan outFrame, 1),
		listIDs: map[string]bool{}, callIDs: map[string]string{}}
}

func (c *channel) logf(format string, args ...any) { c.hub.cfg.Logf(format, args...) }

func (c *channel) sink() *sink {
	return &sink{
		message: c.fromServer,
		closed:  c.transportClosed,
		authRequired: func() {
			c.hub.flagLogin(c.entry.Name)
		},
		logf: c.logf,
	}
}

// start opens the transport and registers the channel with the hub.
func (c *channel) start(ctx context.Context) *OpenError {
	e := c.entry
	switch e.Transport {
	case TransportStdio:
		sc, err := startStdio(e, c.sink())
		if err != nil {
			return &OpenError{"unavailable", "cannot start " + e.Name + ": " + startError(err)}
		}
		c.tr = sc
		select {
		case <-sc.Done():
			// It ended before it could be used: say why now, not as a closed
			// frame on a channel nobody has heard of.
			_, detail := sc.Exit()
			return &OpenError{"unavailable", "cannot start " + e.Name + ": " + detail}
		case <-time.After(c.hub.cfg.OpenCheck):
		case <-ctx.Done():
			sc.Close()
			return &OpenError{"unavailable", "cancelled"}
		}
	default:
		var auth authSource
		if c.hub.tokens != nil {
			auth = storeAuth{c.hub.tokens, e.Name, e.URL}
		}
		hc := newHTTPConn(e, c.sink(), c.hub.client, auth)
		if hc.legacy {
			if err := hc.connectLegacy(); err != nil {
				hc.Close()
				if errors.Is(err, errAuthRequired) {
					return &OpenError{"forbidden", "the connector " + e.Name + " needs a sign-in. " + loginSentence(e.Name)}
				}
				return &OpenError{"unavailable", "cannot connect to " + e.Name + ": " + err.Error()}
			}
		}
		c.tr = hc
	}
	c.hub.mu.Lock()
	c.hub.channels[c.id] = c
	c.hub.mu.Unlock()
	c.mu.Lock()
	c.registered = true
	early := c.early
	c.idle = time.AfterFunc(c.hub.cfg.IdleTimeout, func() { c.shutdown("idle", nil, true) })
	c.mu.Unlock()
	if sc, ok := c.tr.(*stdioConn); ok {
		c.logf("connectors: %s: started (pid %d, channel %s)", e.Name, sc.Pid(), c.id)
	}
	go c.writer()
	if early != nil {
		c.shutdown(early.reason, &early.detail, true)
	}
	return nil
}

func startError(err error) string {
	var pe *exec.Error
	if errors.As(err, &pe) {
		return fmt.Sprintf("%s: %v", pe.Name, pe.Err)
	}
	return err.Error()
}

func (c *channel) writer() {
	for {
		select {
		case <-c.stop:
			return
		case m := <-c.queue:
			c.tr.Send(m)
		}
	}
}

func (c *channel) touch() {
	c.mu.Lock()
	if c.idle != nil && !c.closed {
		c.idle.Reset(c.hub.cfg.IdleTimeout)
	}
	c.mu.Unlock()
}

// transportClosed is the transport ending on its own.
func (c *channel) transportClosed(reason, detail string) {
	c.mu.Lock()
	if !c.registered {
		c.early = &closeInfo{reason, detail}
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()
	c.shutdown(reason, &detail, true)
}

// shutdown ends the channel once. emit sends the closed frame.
func (c *channel) shutdown(reason string, detail *string, emit bool) {
	c.end("", reason, detail, emit)
}

// end is shutdown with the reason to log when it is not the one sent to
// Cerea (the link going down is a "closed" frame nobody hears).
func (c *channel) end(why, reason string, detail *string, emit bool) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	if why == "" {
		why = reason
	}
	if c.idle != nil {
		c.idle.Stop()
	}
	pending := c.callIDs
	c.callIDs = map[string]string{}
	c.mu.Unlock()
	c.flushInputAudit()
	if c.hub.cfg.FrameFrom[c.entry.Name] {
		c.mu.Lock()
		was := c.casting
		c.casting = false
		c.mu.Unlock()
		if was {
			c.hub.cfg.Audit(c.entry.Name, "screencast.stop", "ok")
		}
	}
	close(c.stop)
	c.hub.mu.Lock()
	delete(c.hub.channels, c.id)
	c.hub.mu.Unlock()
	for _, tool := range pending {
		c.hub.cfg.Audit(c.entry.Name, tool, "error")
	}
	c.hub.stopping.Add(1)
	go func() { <-c.tr.Done(); c.hub.stopping.Done() }()
	c.tr.Close()
	if sc, ok := c.tr.(*stdioConn); ok {
		// Only the reason and, for a process that died, its exit status: never
		// its arguments, environment or output.
		stopped := why
		if reason == "crashed" || reason == "exited" {
			<-sc.Done()
			stopped += ": " + sc.ExitStatus()
		}
		c.logf("connectors: %s: stopped (channel %s, %s)", c.entry.Name, c.id, stopped)
	}
	if c.localClosed != nil {
		c.localClosed()
	}
	if emit && c.local == nil {
		c.hub.cfg.Closed(c.id, reason, detail)
	}
}

func (c *channel) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

func (c *channel) toCerea(raw []byte) {
	if c.isClosed() {
		return
	}
	if c.local != nil {
		c.local(raw)
		return
	}
	if err := c.hub.cfg.Send(c.id, raw); err != nil {
		c.logf("connectors: %s: dropping a message for Cerea: %v", c.entry.Name, err)
	}
}

func (c *channel) toServer(raw []byte) {
	select {
	case c.queue <- raw:
	default:
		for _, id := range requestIDs(raw) {
			c.toCerea(rpcError(id, codeServerError, "the connector is busy: too many messages waiting"))
		}
	}
}

type msgHeader struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"params"`
}

func (h *msgHeader) hasID() bool { return len(h.ID) > 0 && string(h.ID) != "null" }

// fromClient handles one frame's message from Cerea: the ceiling (§10.4), the
// size cap, then the server.
func (c *channel) fromClient(raw []byte) {
	c.touch()
	raw = bytes.TrimSpace(raw)
	parts := splitBatch(raw)
	if len(parts) == 0 {
		c.logf("connectors: %s: dropping a message that is not JSON-RPC", c.entry.Name)
		return
	}
	isBatch := raw[0] == '['
	var keep []json.RawMessage
	for _, m := range parts {
		var h msgHeader
		if json.Unmarshal(m, &h) != nil {
			c.logf("connectors: %s: dropping a message that is not JSON-RPC", c.entry.Name)
			continue
		}
		switch h.Method {
		case "tools/call":
			tool := h.Params.Name
			if c.entry.AllowedTools != nil && !contains(c.entry.AllowedTools, tool) {
				c.hub.cfg.Audit(c.entry.Name, tool, "refused")
				if h.hasID() {
					c.toCerea(rpcError(h.ID, -32001, "this tool is not allowed on this machine"))
				}
				continue
			}
			// A live-view call is audited in aggregate (auditPerCall), not per call.
			if c.auditPerCall(tool, h.Params.Arguments) {
				if h.hasID() {
					c.mu.Lock()
					c.callIDs[string(h.ID)] = tool
					c.mu.Unlock()
				} else {
					c.hub.cfg.Audit(c.entry.Name, tool, "ok")
				}
			}
		case "tools/list":
			if h.hasID() {
				c.mu.Lock()
				c.listIDs[string(h.ID)] = true
				c.mu.Unlock()
			}
		}
		keep = append(keep, m)
	}
	if len(keep) == 0 {
		return
	}
	out := raw
	if len(keep) != len(parts) {
		if isBatch {
			out, _ = json.Marshal(keep)
		} else {
			out = keep[0]
		}
	}
	if len(out) > MaxMessageBytes {
		c.oversizeFromClient(keep)
		return
	}
	c.toServer(append([]byte(nil), out...))
}

// auditPerCall reports whether a tools/call gets its own audit row. For the
// browser runtime's live-view tools it does not: a screencast acks ten times a
// second and the user's input is a stream of calls, so one row each would
// rotate every real entry out of the log. Instead the screencast is recorded
// once per start and stop, and the input once per takeover (the number of
// calls and how long it lasted), when control goes back or the channel ends.
// The "state" poll of control is not recorded at all.
func (c *channel) auditPerCall(tool string, args json.RawMessage) bool {
	if !c.hub.cfg.FrameFrom[c.entry.Name] {
		return true
	}
	var a struct {
		Action string `json:"action"`
	}
	_ = json.Unmarshal(args, &a)
	switch tool {
	case "screencast":
		c.mu.Lock()
		was := c.casting
		switch a.Action {
		case "start":
			c.casting = true
		case "stop":
			c.casting = false
		}
		now := c.casting
		c.mu.Unlock()
		if a.Action == "start" && !was {
			c.hub.cfg.Audit(c.entry.Name, "screencast.start", "ok")
		} else if a.Action == "stop" && was && !now {
			c.hub.cfg.Audit(c.entry.Name, "screencast.stop", "ok")
		}
		return false
	case "input":
		c.mu.Lock()
		if c.inputCalls == 0 {
			c.inputSince = time.Now()
		}
		c.inputCalls++
		c.mu.Unlock()
		return false
	case "control":
		switch a.Action {
		case "state":
			return false
		case "handback":
			c.flushInputAudit()
		}
	}
	return true
}

// flushInputAudit writes the takeover's one input row, if there was input.
func (c *channel) flushInputAudit() {
	c.mu.Lock()
	n, since := c.inputCalls, c.inputSince
	c.inputCalls = 0
	c.mu.Unlock()
	if n == 0 {
		return
	}
	secs := int(time.Since(since).Round(time.Second) / time.Second)
	c.hub.cfg.Audit(c.entry.Name, "input", fmt.Sprintf("ok (%d calls, %ds)", n, secs))
}

// oversizeFromClient: a message too large for the link is not forwarded; a
// request is answered with an error, anything else dropped.
func (c *channel) oversizeFromClient(parts []json.RawMessage) {
	for _, m := range parts {
		var h msgHeader
		_ = json.Unmarshal(m, &h)
		if len(m) <= MaxMessageBytes {
			c.toServer(append([]byte(nil), m...))
			continue
		}
		c.logf("connectors: %s: dropping a %d-byte message from Cerea (limit %d)", c.entry.Name, len(m), MaxMessageBytes)
		if h.Method != "" && h.hasID() {
			c.toCerea(rpcError(h.ID, codeResponseLarge, tooLargeText(len(m))))
		}
	}
}

func tooLargeText(n int) string {
	return fmt.Sprintf("message too large for the link (%d bytes, limit %d)", n, MaxMessageBytes)
}

// fromServer handles one message from the server: tools/list results are
// filtered by allowedTools, tools/call outcomes audited, and what is too large
// for the link is answered with an error instead.
func (c *channel) fromServer(raw []byte) {
	c.touch()
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return
	}
	if c.hub.cfg.FrameFrom[c.entry.Name] && c.frame(raw) {
		return
	}
	parts := splitBatch(raw)
	if len(parts) == 0 {
		c.logf("connectors: %s: dropping a message that is not JSON", c.entry.Name)
		return
	}
	changed := false
	for i, m := range parts {
		var h struct {
			msgHeader
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(m, &h) != nil || h.Method != "" || !h.hasID() {
			continue
		}
		key := string(h.ID)
		c.mu.Lock()
		isList := c.listIDs[key]
		delete(c.listIDs, key)
		tool, isCall := c.callIDs[key]
		delete(c.callIDs, key)
		c.mu.Unlock()
		if isCall {
			c.hub.cfg.Audit(c.entry.Name, tool, callOutcome(h.Result, h.Error))
		}
		if isList && c.entry.AllowedTools != nil && len(h.Result) > 0 {
			if filtered, ok := filterTools(m, c.entry.AllowedTools); ok {
				parts[i] = filtered
				changed = true
			}
		}
	}
	out := raw
	if changed {
		if raw[0] == '[' {
			out, _ = json.Marshal(parts)
		} else {
			out = parts[0]
		}
	}
	if len(out) <= MaxMessageBytes {
		c.toCerea(append([]byte(nil), out...))
		return
	}
	for _, m := range parts {
		if len(m) <= MaxMessageBytes {
			c.toCerea(append([]byte(nil), m...))
			continue
		}
		var h msgHeader
		_ = json.Unmarshal(m, &h)
		c.logf("connectors: %s: a %d-byte message from the server does not fit the link (limit %d)", c.entry.Name, len(m), MaxMessageBytes)
		if !h.hasID() {
			continue
		}
		if h.Method == "" { // a response: Cerea is waiting for it
			c.toCerea(rpcError(h.ID, codeResponseLarge, tooLargeText(len(m))))
		} else { // a request from the server: it gets the answer
			c.toServer(rpcError(h.ID, codeResponseLarge, tooLargeText(len(m))))
		}
	}
}

// frameMethod is the MCP notification the browser runtime sends a screencast
// frame in (ADR 0116 phase 2a). MCP is JSON, so the JPEG is base64 there; on
// the link it travels as a binary frame instead, without the third.
const frameMethod = "notifications/cerea/frame"

// outFrame is one screencast frame waiting for the sender goroutine.
type outFrame struct {
	seq     uint64
	payload []byte
}

// frame hands a screencast frame notification to the channel's sender and
// reports whether raw was one. The runtime's stdout reader must never wait on
// the link (a stalled link would stall every tool answer behind the frames), so
// this only parses and files the frame in a one-slot mailbox: a frame still
// waiting there when a newer one arrives is replaced (latest wins), and one the
// link cannot take is dropped by the sender; the next follows. A frame is
// never logged or kept.
func (c *channel) frame(raw []byte) bool {
	if len(raw) == 0 || raw[0] != '{' || !bytes.Contains(raw, []byte(frameMethod)) {
		return false
	}
	var n struct {
		Method string `json:"method"`
		Params struct {
			Seq  uint64 `json:"seq"`
			W    int    `json:"w"`
			H    int    `json:"h"`
			Mime string `json:"mime"`
			Data string `json:"data"`
		} `json:"params"`
	}
	if json.Unmarshal(raw, &n) != nil || n.Method != frameMethod {
		return false
	}
	if c.isClosed() || c.local != nil || c.hub.cfg.Frame == nil {
		return true
	}
	jpeg, err := base64.StdEncoding.DecodeString(n.Params.Data)
	if err != nil || len(jpeg) == 0 || n.Params.Mime != "image/jpeg" || n.Params.W <= 0 || n.Params.H <= 0 ||
		n.Params.W > 65535 || n.Params.H > 65535 || len(jpeg) > link.MaxBrowserFramePayload-4 {
		return true
	}
	c.frameOnce.Do(func() { go c.frameSender() })
	out := outFrame{n.Params.Seq, link.BrowserFramePayload(uint16(n.Params.W), uint16(n.Params.H), jpeg)}
	for {
		select {
		case c.frames <- out:
			return true
		default:
		}
		select {
		case <-c.frames: // an older frame nobody sent yet: the newer one replaces it
		default:
		}
	}
}

// frameSender writes the mailbox's frames to the link, one at a time, until the
// channel ends. A write that fails loses its frame, silently.
func (c *channel) frameSender() {
	for {
		select {
		case <-c.stop:
			return
		case f := <-c.frames:
			if c.isClosed() {
				return
			}
			_ = c.hub.cfg.Frame(c.id, f.seq, f.payload)
		}
	}
}

func callOutcome(result, errObj json.RawMessage) string {
	if len(errObj) > 0 && string(errObj) != "null" {
		return "error"
	}
	var r struct {
		IsError bool `json:"isError"`
	}
	if json.Unmarshal(result, &r) == nil && r.IsError {
		return "error"
	}
	return "ok"
}

// filterTools keeps the allowed tools of a tools/list response, leaving every
// other field of the response as it was.
func filterTools(msg json.RawMessage, allowed []string) (json.RawMessage, bool) {
	var top map[string]json.RawMessage
	if json.Unmarshal(msg, &top) != nil {
		return nil, false
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(top["result"], &result) != nil {
		return nil, false
	}
	var tools []json.RawMessage
	if json.Unmarshal(result["tools"], &tools) != nil {
		return nil, false
	}
	kept := make([]json.RawMessage, 0, len(tools))
	for _, t := range tools {
		var n struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(t, &n) == nil && contains(allowed, n.Name) {
			kept = append(kept, t)
		}
	}
	result["tools"], _ = json.Marshal(kept)
	top["result"], _ = json.Marshal(result)
	out, err := json.Marshal(top)
	return out, err == nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
