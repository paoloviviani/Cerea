package mcpconn

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// authSource supplies the OAuth sign-in kept on the machine (§10.5).
type authSource interface {
	Header(ctx context.Context) (string, error)
	Refresh(ctx context.Context) error
}

type storeAuth struct {
	store *TokenStore
	name  string
	url   string
}

func (a storeAuth) Header(ctx context.Context) (string, error) {
	return a.store.Header(ctx, a.name, a.url)
}
func (a storeAuth) Refresh(ctx context.Context) error { return a.store.Refresh(ctx, a.name, a.url) }

func newHTTPClient() *http.Client {
	return &http.Client{Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		ResponseHeaderTimeout: 2 * time.Minute,
		TLSHandshakeTimeout:   15 * time.Second,
		IdleConnTimeout:       time.Minute,
	}}
}

// httpConn is one MCP session over Streamable HTTP, or over the legacy
// HTTP+SSE transport when legacy is set (PROTOCOL.md §10.1): a thin client
// that POSTs the messages it is given and hands back whatever the server
// answers, JSON or event stream, without looking inside.
type httpConn struct {
	e      *Entry
	sink   *sink
	client *http.Client
	auth   authSource
	legacy bool

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	done   chan struct{}

	closing atomic.Bool

	mu        sync.Mutex
	sessionID string
	protoVer  string
	initIDs   map[string]bool // ids of initialize requests in flight
	postURL   string          // legacy: the endpoint event's URL
	getting   bool
}

func newHTTPConn(e *Entry, s *sink, client *http.Client, auth authSource) *httpConn {
	ctx, cancel := context.WithCancel(context.Background())
	c := &httpConn{e: e, sink: s, client: client, auth: auth, legacy: e.Transport == TransportSSE,
		ctx: ctx, cancel: cancel, done: make(chan struct{}), initIDs: map[string]bool{}}
	return c
}

func (c *httpConn) Done() <-chan struct{} { return c.done }

func (c *httpConn) Close() {
	if !c.closing.CompareAndSwap(false, true) {
		return
	}
	c.mu.Lock()
	sid := c.sessionID
	c.mu.Unlock()
	go func() {
		if sid != "" && !c.legacy {
			// End the session politely; the server may answer 405.
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			if req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.e.URL, nil); err == nil {
				c.decorate(ctx, req)
				if resp, err := c.client.Do(req); err == nil {
					resp.Body.Close()
				}
			}
			cancel()
		}
		c.cancel()
		c.wg.Wait()
		close(c.done)
	}()
}

// decorate adds the configured headers, the session and protocol headers and
// the stored sign-in (a configured Authorization header wins).
func (c *httpConn) decorate(ctx context.Context, req *http.Request) {
	hasAuth := false
	for k, v := range c.e.Headers {
		req.Header.Set(k, v)
		if strings.EqualFold(k, "Authorization") {
			hasAuth = true
		}
	}
	c.mu.Lock()
	if c.sessionID != "" {
		req.Header.Set("Mcp-Session-Id", c.sessionID)
	}
	if c.protoVer != "" {
		req.Header.Set("MCP-Protocol-Version", c.protoVer)
	}
	c.mu.Unlock()
	if !hasAuth && c.auth != nil {
		if h, err := c.auth.Header(ctx); err == nil && h != "" {
			req.Header.Set("Authorization", h)
		}
	}
}

// connectLegacy opens the SSE stream of the legacy transport and waits for
// the endpoint event.
func (c *httpConn) connectLegacy() error {
	req, err := http.NewRequestWithContext(c.ctx, http.MethodGet, c.e.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	c.decorate(c.ctx, req)
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach the server: %w", urlErr(err))
	}
	if resp.StatusCode/100 != 2 {
		defer resp.Body.Close()
		if c.unauthorized(resp) {
			return errAuthRequired
		}
		return fmt.Errorf("the server answered %s", resp.Status)
	}
	ready := make(chan error, 1)
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		defer resp.Body.Close()
		err := readSSE(resp.Body, maxReadBytes, func(ev sseEvent) {
			switch ev.Event {
			case "endpoint":
				u, perr := req.URL.Parse(strings.TrimSpace(string(ev.Data)))
				if perr != nil {
					return
				}
				c.mu.Lock()
				first := c.postURL == ""
				c.postURL = u.String()
				c.mu.Unlock()
				if first {
					ready <- nil
				}
			case "message", "":
				c.deliver(ev.Data)
			}
		})
		select {
		case ready <- errors.New("the stream ended before the server named its endpoint"):
		default:
		}
		if !c.closing.Load() && c.ctx.Err() == nil {
			detail := "the server closed its event stream"
			if err != nil && !errors.Is(err, io.EOF) {
				detail = "the event stream failed: " + urlErr(err).Error()
			}
			c.sink.closed("crashed", detail)
		}
	}()
	select {
	case err := <-ready:
		return err
	case <-time.After(15 * time.Second):
		return errors.New("the server did not name its endpoint within 15 s")
	case <-c.ctx.Done():
		return c.ctx.Err()
	}
}

var errAuthRequired = errors.New("sign-in required")

// unauthorized reports a 401 that asks for OAuth (a WWW-Authenticate
// challenge, no Authorization header of the person's own to blame) and tells
// the channel.
func (c *httpConn) unauthorized(resp *http.Response) bool {
	if !oauthChallenge(resp, c.e) {
		return false
	}
	c.sink.authRequired()
	return true
}

// oauthChallenge reports a 401 with WWW-Authenticate from a server whose
// entry configures no Authorization header of its own.
func oauthChallenge(resp *http.Response, e *Entry) bool {
	if resp.StatusCode != http.StatusUnauthorized || resp.Header.Get("WWW-Authenticate") == "" {
		return false
	}
	for k := range e.Headers {
		if strings.EqualFold(k, "Authorization") {
			return false
		}
	}
	return true
}

func (c *httpConn) Send(msg []byte) {
	c.noteOutgoing(msg)
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		c.post(msg)
	}()
}

// noteOutgoing remembers initialize requests, whose answer carries the
// protocol version the following requests must name.
func (c *httpConn) noteOutgoing(msg []byte) {
	for _, m := range splitBatch(msg) {
		var h struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if json.Unmarshal(m, &h) == nil && h.Method == "initialize" && len(h.ID) > 0 {
			c.mu.Lock()
			c.initIDs[string(h.ID)] = true
			c.mu.Unlock()
		}
	}
}

func (c *httpConn) isInitialized(msg []byte) bool {
	var h struct {
		Method string `json:"method"`
	}
	return json.Unmarshal(msg, &h) == nil && h.Method == "notifications/initialized"
}

func (c *httpConn) failRequests(msg []byte, code int, text string) {
	for _, id := range requestIDs(msg) {
		c.deliver(rpcError(id, code, text))
	}
}

// RPC error codes galopin answers with when the server cannot be reached.
const (
	codeServerError   = -32000
	codeSignInNeeded  = -32002
	codeResponseLarge = -32603
)

func (c *httpConn) post(msg []byte) {
	target := c.e.URL
	if c.legacy {
		c.mu.Lock()
		target = c.postURL
		c.mu.Unlock()
	}
	refreshed := false
	for {
		req, err := http.NewRequestWithContext(c.ctx, http.MethodPost, target, bytes.NewReader(msg))
		if err != nil {
			c.failRequests(msg, codeServerError, "cannot build the request: "+urlErr(err).Error())
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		c.decorate(c.ctx, req)
		resp, err := c.client.Do(req)
		if err != nil {
			if c.ctx.Err() == nil {
				c.failRequests(msg, codeServerError, "cannot reach the server: "+urlErr(err).Error())
			}
			return
		}
		if resp.StatusCode == http.StatusUnauthorized {
			resp.Body.Close()
			if c.auth != nil && !refreshed {
				refreshed = true
				if c.auth.Refresh(c.ctx) == nil {
					continue
				}
			}
			if c.unauthorized(resp) {
				c.failRequests(msg, codeSignInNeeded, "the server asks for a sign-in: run `galopin connectors login "+c.e.Name+"` on this machine")
			} else {
				c.failRequests(msg, codeServerError, "the server answered 401 Unauthorized")
			}
			return
		}
		c.handleResponse(msg, resp)
		return
	}
}

func (c *httpConn) handleResponse(msg []byte, resp *http.Response) {
	defer resp.Body.Close()
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" && !c.legacy {
		c.mu.Lock()
		c.sessionID = sid
		c.mu.Unlock()
	}
	switch {
	case resp.StatusCode == http.StatusNotFound && c.hasSession():
		c.sink.closed("crashed", "the server no longer knows this session (HTTP 404)")
		return
	case resp.StatusCode/100 != 2:
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		text := "the server answered " + resp.Status
		if s := strings.TrimSpace(string(snippet)); s != "" && !strings.HasPrefix(s, "<") {
			text += ": " + s
		}
		c.failRequests(msg, codeServerError, text)
		return
	case resp.StatusCode == http.StatusAccepted || resp.StatusCode == http.StatusNoContent:
		c.afterAccepted(msg)
		return
	}
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	switch {
	case strings.HasPrefix(ct, "text/event-stream"):
		_ = readSSE(resp.Body, maxReadBytes, func(ev sseEvent) {
			if ev.Event == "message" || ev.Event == "" {
				c.deliver(ev.Data)
			}
		})
		c.afterAccepted(msg)
	case c.legacy:
		// The legacy transport answers on the stream; the POST's body is noise.
	default:
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxReadBytes+1))
		if err != nil {
			c.failRequests(msg, codeServerError, "reading the server's answer failed: "+urlErr(err).Error())
			return
		}
		if len(bytes.TrimSpace(body)) > 0 {
			c.deliver(body)
		}
		c.afterAccepted(msg)
	}
}

func (c *httpConn) hasSession() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sessionID != ""
}

// afterAccepted: once the client has said it is initialized the server may
// push messages on a GET stream.
func (c *httpConn) afterAccepted(msg []byte) {
	if c.legacy || !c.isInitialized(msg) {
		return
	}
	c.mu.Lock()
	start := !c.getting
	c.getting = true
	c.mu.Unlock()
	if start {
		c.wg.Add(1)
		go func() {
			defer c.wg.Done()
			c.getLoop()
		}()
	}
}

// getLoop holds the optional GET stream for server-initiated messages,
// resuming after a break; a server that does not offer one (405) is left be.
func (c *httpConn) getLoop() {
	lastID := ""
	fails := 0
	for c.ctx.Err() == nil && fails < 5 {
		req, err := http.NewRequestWithContext(c.ctx, http.MethodGet, c.e.URL, nil)
		if err != nil {
			return
		}
		req.Header.Set("Accept", "text/event-stream")
		if lastID != "" {
			req.Header.Set("Last-Event-ID", lastID)
		}
		c.decorate(c.ctx, req)
		resp, err := c.client.Do(req)
		if err == nil && resp.StatusCode/100 == 2 && strings.HasPrefix(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
			fails = 0
			_ = readSSE(resp.Body, maxReadBytes, func(ev sseEvent) {
				if ev.ID != "" {
					lastID = ev.ID
				}
				if ev.Event == "message" || ev.Event == "" {
					c.deliver(ev.Data)
				}
			})
			resp.Body.Close()
		} else {
			if resp != nil {
				resp.Body.Close()
				if resp.StatusCode >= 400 && resp.StatusCode < 500 {
					return // 405 and friends: no stream on offer
				}
			}
			fails++
		}
		select {
		case <-c.ctx.Done():
			return
		case <-time.After(time.Duration(fails+1) * time.Second):
		}
	}
}

// deliver passes a message to the channel, first noting the protocol version
// an initialize answer names.
func (c *httpConn) deliver(raw []byte) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return
	}
	c.mu.Lock()
	pending := len(c.initIDs) > 0
	c.mu.Unlock()
	if pending {
		for _, m := range splitBatch(raw) {
			var h struct {
				ID     json.RawMessage `json:"id"`
				Result struct {
					ProtocolVersion string `json:"protocolVersion"`
				} `json:"result"`
			}
			if json.Unmarshal(m, &h) == nil && len(h.ID) > 0 {
				c.mu.Lock()
				if c.initIDs[string(h.ID)] {
					delete(c.initIDs, string(h.ID))
					if h.Result.ProtocolVersion != "" {
						c.protoVer = h.Result.ProtocolVersion
					}
				}
				c.mu.Unlock()
			}
		}
	}
	c.sink.message(raw)
}

// urlErr drops the url (it may carry a token) from a transport error.
func urlErr(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}
