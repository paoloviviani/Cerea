package mcpconn

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
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
	adopt *parkedConn // a kept process this channel takes over instead of starting one

	queue chan []byte
	stop  chan struct{}

	mu         sync.Mutex
	registered bool
	early      *closeInfo
	closed     bool
	idle       *time.Timer
	listIDs    map[string]bool
	callIDs    map[string]string // request id -> tool
	reqIDs     map[string]bool   // every request id of the client still unanswered
	gen        int64             // generation of a kept process's channel; ids are remapped when > 0

	// local, when set, takes what would go to Cerea: the channel belongs to
	// galopin's own in-process client (local.go), not to a Cerea chat.
	local func(raw []byte)
	// localClosed tells that client the channel ended.
	localClosed func()
}

func newChannel(h *Hub, e *Entry) *channel {
	return &channel{id: newChannelID(), hub: h, entry: e, queue: make(chan []byte, 256), stop: make(chan struct{}),
		listIDs: map[string]bool{}, callIDs: map[string]string{}, reqIDs: map[string]bool{}}
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
	switch {
	case c.adopt != nil:
		// A kept process (the browser runtime): same process, same Chrome. The new
		// channel's client sends its own initialize, which the server answers
		// afresh; nothing in the process is restarted.
		c.tr = c.adopt.sc
		c.gen = c.adopt.sc.gen.Add(1) // before the process can reach this channel
		c.adopt.sc.rebind(c.sink())
		c.adopt = nil
		select {
		case <-c.tr.Done():
			return &OpenError{"unavailable", "cannot start " + e.Name + ": the kept process ended"}
		default:
		}
	case e.Transport == TransportStdio:
		sc, err := startStdio(e, c.sink())
		if err != nil {
			return &OpenError{"unavailable", "cannot start " + e.Name + ": " + startError(err)}
		}
		c.tr = sc
		if c.hub.keeps(e.Name) {
			c.gen = sc.gen.Add(1)
		}
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
	c.idle = time.AfterFunc(c.idleFor(), func() { c.shutdown("idle", nil, true) })
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

// idleFor: a kept server's channel idles for an hour and then parks its process.
func (c *channel) idleFor() time.Duration {
	if c.hub.keeps(c.entry.Name) {
		return c.hub.cfg.KeepAliveIdle
	}
	return c.hub.cfg.IdleTimeout
}

func (c *channel) touch() {
	c.mu.Lock()
	if c.idle != nil && !c.closed {
		c.idle.Reset(c.idleFor())
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
	close(c.stop)
	parked := false
	if sc, ok := c.tr.(*stdioConn); ok && c.hub.keeps(c.entry.Name) && parkable(why) {
		select {
		case <-sc.Done():
		default:
			// The link went away (or the channel went quiet), not the user: keep the
			// process and its Chrome. park also removes the channel from the hub.
			c.hub.park(c, sc, why)
			parked = true
		}
	}
	if !parked {
		c.hub.mu.Lock()
		delete(c.hub.channels, c.id)
		c.hub.mu.Unlock()
	}
	for _, tool := range pending {
		c.hub.cfg.Audit(c.entry.Name, tool, "error")
	}
	if !parked {
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
			c.answeredHere(c.clientID(id))
			c.toCerea(rpcError(c.clientID(id), codeServerError, "the connector is busy: too many messages waiting"))
		}
	}
}

type msgHeader struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params struct {
		Name      string          `json:"name"`
		RequestID json.RawMessage `json:"requestId"`
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
	remapped := false
	for _, m := range parts {
		var h msgHeader
		if json.Unmarshal(m, &h) != nil {
			c.logf("connectors: %s: dropping a message that is not JSON-RPC", c.entry.Name)
			continue
		}
		if h.Method != "" && h.hasID() {
			c.mu.Lock()
			c.reqIDs[string(h.ID)] = true
			c.mu.Unlock()
		}
		switch h.Method {
		case "tools/call":
			tool := h.Params.Name
			if c.entry.AllowedTools != nil && !contains(c.entry.AllowedTools, tool) {
				c.hub.cfg.Audit(c.entry.Name, tool, "refused")
				if h.hasID() {
					c.answeredHere(h.ID)
					c.toCerea(rpcError(h.ID, -32001, "this tool is not allowed on this machine"))
				}
				continue
			}
			if h.hasID() {
				c.mu.Lock()
				c.callIDs[string(h.ID)] = tool
				c.mu.Unlock()
			} else {
				c.hub.cfg.Audit(c.entry.Name, tool, "ok")
			}
		case "tools/list":
			if h.hasID() {
				c.mu.Lock()
				c.listIDs[string(h.ID)] = true
				c.mu.Unlock()
			}
		}
		if c.gen > 0 && h.Method == "notifications/cancelled" && len(h.Params.RequestID) > 0 {
			m = setRequestID(m, wrapID(c.gen, h.Params.RequestID))
			remapped = true
		}
		if c.gen > 0 && h.Method != "" && h.hasID() {
			// A kept process outlives its channels: ids are made unique per generation
			// so a late answer to an earlier client's request cannot pass as this one's.
			m = setID(m, wrapID(c.gen, h.ID))
			remapped = true
		}
		keep = append(keep, m)
	}
	if len(keep) == 0 {
		return
	}
	out := raw
	if len(keep) != len(parts) || remapped {
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
			id := c.clientID(h.ID)
			c.answeredHere(id)
			c.toCerea(rpcError(id, codeResponseLarge, tooLargeText(len(m))))
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
	parts := splitBatch(raw)
	if len(parts) == 0 {
		c.logf("connectors: %s: dropping a message that is not JSON", c.entry.Name)
		return
	}
	if c.gen > 0 {
		var ok bool
		if raw, parts, ok = c.unwrapResponses(raw, parts); !ok {
			return
		}
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
		delete(c.reqIDs, key)
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

// wrapID is the id a kept process sees: "g<generation>:" and the client's id as
// JSON text.
func wrapID(gen int64, id json.RawMessage) json.RawMessage {
	b, _ := json.Marshal(fmt.Sprintf("g%d:%s", gen, string(id)))
	return b
}

// setID returns msg with its id replaced.
func setID(msg, id json.RawMessage) json.RawMessage {
	var top map[string]json.RawMessage
	if json.Unmarshal(msg, &top) != nil {
		return msg
	}
	top["id"] = id
	out, err := json.Marshal(top)
	if err != nil {
		return msg
	}
	return out
}

// unwrapID undoes wrapID for this channel's generation.
func (c *channel) unwrapID(id json.RawMessage) (json.RawMessage, bool) {
	var s string
	if json.Unmarshal(id, &s) != nil {
		return nil, false
	}
	prefix := fmt.Sprintf("g%d:", c.gen)
	if !strings.HasPrefix(s, prefix) {
		return nil, false
	}
	return json.RawMessage(s[len(prefix):]), true
}

// clientID is the id as the client sent it, for an answer made here.
func (c *channel) clientID(id json.RawMessage) json.RawMessage {
	if c.gen > 0 {
		if orig, ok := c.unwrapID(id); ok {
			return orig
		}
	}
	return id
}

// unwrapResponses gives the responses of a kept process back their client ids and
// drops those of an earlier generation, or to a request nobody here is waiting
// for. ok is false when nothing is left to deliver.
func (c *channel) unwrapResponses(raw []byte, parts []json.RawMessage) ([]byte, []json.RawMessage, bool) {
	out := make([]json.RawMessage, 0, len(parts))
	rewritten := false
	for _, m := range parts {
		var h msgHeader
		if json.Unmarshal(m, &h) != nil || h.Method != "" || !h.hasID() {
			out = append(out, m)
			continue
		}
		orig, ok := c.unwrapID(h.ID)
		if ok {
			c.mu.Lock()
			ok = c.reqIDs[string(orig)]
			c.mu.Unlock()
		}
		rewritten = true
		if !ok {
			c.logf("connectors: %s: dropping a response to an earlier client's request", c.entry.Name)
			continue
		}
		out = append(out, setID(m, orig))
	}
	if !rewritten {
		return raw, parts, true
	}
	if len(out) == 0 {
		return nil, nil, false
	}
	if raw[0] == '[' {
		b, _ := json.Marshal(out)
		return b, out, true
	}
	return out[0], out, true
}

// answeredHere forgets a request this channel answered itself: no response will
// come from the server for it.
func (c *channel) answeredHere(id json.RawMessage) {
	c.mu.Lock()
	delete(c.reqIDs, string(id))
	delete(c.callIDs, string(id))
	delete(c.listIDs, string(id))
	c.mu.Unlock()
}

// setRequestID returns a notifications/cancelled message with params.requestId replaced.
func setRequestID(msg, id json.RawMessage) json.RawMessage {
	var top map[string]json.RawMessage
	if json.Unmarshal(msg, &top) != nil {
		return msg
	}
	var params map[string]json.RawMessage
	if json.Unmarshal(top["params"], &params) != nil {
		return msg
	}
	params["requestId"] = id
	top["params"], _ = json.Marshal(params)
	out, err := json.Marshal(top)
	if err != nil {
		return msg
	}
	return out
}
