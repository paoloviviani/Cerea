package mcpconn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"
)

// The in-process client (ADR 0108, item 3): galopin serves the machine's own
// connectors to a coding agent without a trip through Cerea. It opens an
// ordinary channel to the server and speaks MCP over it itself, so the
// machine's ceiling (allowedTools), the audit line, the size cap and the
// sign-in state apply exactly as they do for the chat. Nothing is sent to
// Cerea: the channel's output is this client's.

// Tool is one tool a connector lists.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

// CallResult is a tools/call result.
type CallResult struct {
	IsError bool
	// Content is the result's content blocks, as the server sent them.
	Content []json.RawMessage
}

// LocalError is a JSON-RPC error from the server, or a refusal to talk to it.
type LocalError struct{ Message string }

func (e *LocalError) Error() string { return e.Message }

const (
	localListPages    = 5
	localDefaultLimit = 60 * time.Second
)

// localSession is one open channel and the requests waiting on it.
type localSession struct {
	ch *channel

	mu      sync.Mutex
	next    int64
	pending map[string]chan localReply
	ready   bool
	dead    bool
}

type localReply struct {
	result json.RawMessage
	err    *LocalError
}

func (s *localSession) onMessage(raw []byte) {
	for _, m := range splitBatch(raw) {
		var h struct {
			msgHeader
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(m, &h) != nil || !h.hasID() {
			continue // a notification, or not JSON-RPC
		}
		if h.Method != "" {
			// A request from the server (sampling, elicitation, roots): there is
			// no person behind this client to answer it.
			s.ch.fromClient(rpcError(h.ID, -32601, "this client does not support "+h.Method))
			continue
		}
		s.mu.Lock()
		w := s.pending[string(h.ID)]
		delete(s.pending, string(h.ID))
		s.mu.Unlock()
		if w == nil {
			continue
		}
		if h.Error != nil {
			w <- localReply{err: &LocalError{Message: h.Error.Message}}
		} else {
			w <- localReply{result: h.Result}
		}
	}
}

func (s *localSession) closed() {
	s.mu.Lock()
	s.dead = true
	waiting := s.pending
	s.pending = map[string]chan localReply{}
	s.mu.Unlock()
	for _, w := range waiting {
		w <- localReply{err: &LocalError{Message: "the connector closed the connection"}}
	}
}

// request sends one request and waits for its answer.
func (s *localSession) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	s.mu.Lock()
	if s.dead {
		s.mu.Unlock()
		return nil, &LocalError{Message: "the connector closed the connection"}
	}
	s.next++
	id := strconv.FormatInt(s.next, 10)
	w := make(chan localReply, 1)
	s.pending[id] = w
	s.mu.Unlock()
	msg, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": s.next, "method": method, "params": params})
	s.ch.fromClient(msg)
	select {
	case r := <-w:
		if r.err != nil {
			return nil, r.err
		}
		return r.result, nil
	case <-ctx.Done():
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
		cancel, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "notifications/cancelled",
			"params": map[string]any{"requestId": s.next, "reason": "the caller gave up"}})
		s.ch.fromClient(cancel)
		return nil, ctx.Err()
	}
}

func (s *localSession) initialize(ctx context.Context) error {
	if _, err := s.request(ctx, "initialize", map[string]any{
		"protocolVersion": "2025-03-26",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "galopin", "version": "1"},
	}); err != nil {
		return err
	}
	note, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
	s.ch.fromClient(note)
	s.mu.Lock()
	s.ready = true
	s.mu.Unlock()
	return nil
}

// session returns the live session for a server, opening one when there is
// none. One per server, shared by every agent session on the machine: the
// channel's own idle timeout closes it, and the next use reopens it.
func (h *Hub) session(ctx context.Context, name string) (*localSession, error) {
	h.localMu.Lock()
	defer h.localMu.Unlock()
	if s := h.localSessions[name]; s != nil {
		s.mu.Lock()
		ok := !s.dead && s.ready
		s.mu.Unlock()
		if ok && !s.ch.isClosed() {
			return s, nil
		}
		delete(h.localSessions, name)
		s.ch.shutdown("closed", nil, false)
	}
	s := &localSession{pending: map[string]chan localReply{}}
	ch, oerr := h.open(ctx, name, func(c *channel) {
		s.ch = c
		c.local = s.onMessage
		c.localClosed = s.closed
	})
	if oerr != nil {
		return nil, &LocalError{Message: oerr.Message}
	}
	s.ch = ch
	if err := s.initialize(ctx); err != nil {
		ch.shutdown("closed", nil, false)
		return nil, err
	}
	if h.localSessions == nil {
		h.localSessions = map[string]*localSession{}
	}
	h.localSessions[name] = s
	return s, nil
}

func withLimit(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	if d <= 0 {
		d = localDefaultLimit
	}
	return context.WithTimeout(ctx, d)
}

// LocalTools lists a connector's tools (the machine's allowedTools applies).
func (h *Hub) LocalTools(ctx context.Context, name string) ([]Tool, error) {
	ctx, cancel := withLimit(ctx, 0)
	defer cancel()
	s, err := h.session(ctx, name)
	if err != nil {
		return nil, err
	}
	var all []Tool
	cursor := ""
	for page := 0; page < localListPages; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := s.request(ctx, "tools/list", params)
		if err != nil {
			return nil, err
		}
		var res struct {
			Tools      []Tool `json:"tools"`
			NextCursor string `json:"nextCursor"`
		}
		if json.Unmarshal(raw, &res) != nil {
			return nil, &LocalError{Message: "the connector's tool list was not readable"}
		}
		all = append(all, res.Tools...)
		if res.NextCursor == "" {
			break
		}
		cursor = res.NextCursor
	}
	return all, nil
}

// LocalCall runs one tool of a connector. limit bounds the whole call.
func (h *Hub) LocalCall(ctx context.Context, name, tool string, args json.RawMessage, limit time.Duration) (CallResult, error) {
	ctx, cancel := withLimit(ctx, limit)
	defer cancel()
	s, err := h.session(ctx, name)
	if err != nil {
		return CallResult{}, err
	}
	if len(args) == 0 {
		args = json.RawMessage(`{}`)
	}
	raw, err := s.request(ctx, "tools/call", map[string]any{"name": tool, "arguments": args})
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return CallResult{}, &LocalError{Message: fmt.Sprintf("the connector did not answer within %s", limit.Round(time.Second))}
		}
		return CallResult{}, err
	}
	var res struct {
		IsError bool              `json:"isError"`
		Content []json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &res) != nil {
		return CallResult{}, &LocalError{Message: "the connector's result was not readable"}
	}
	return CallResult{IsError: res.IsError, Content: res.Content}, nil
}
