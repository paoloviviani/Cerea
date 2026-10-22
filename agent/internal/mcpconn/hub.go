package mcpconn

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// Config wires a Hub to its machine.
type Config struct {
	// Path is mcp.json; a missing file is no servers.
	Path string
	// StateDir holds the OAuth sign-ins (<StateDir>/connectors).
	StateDir string
	// Lookup is galopin's own environment (default os.LookupEnv).
	Lookup func(string) (string, bool)
	Logf   func(format string, args ...any)
	// Audit records one tools/call: server, tool, outcome (ok, error,
	// refused). Never arguments or results (PROTOCOL.md §10.4).
	Audit func(server, tool, outcome string)
	// Send delivers a message to Cerea on a channel.
	Send func(channelID string, message []byte) error
	// Closed tells Cerea a channel ended (PROTOCOL.md §10.3).
	Closed func(channelID, reason string, detail *string)

	IdleTimeout time.Duration // default 10 min
	PollEvery   time.Duration // default 3 s
	MaxChannels int           // per server, default 4
	// OpenCheck is how long an opened process is watched for an immediate
	// exit (default 150 ms).
	OpenCheck  time.Duration
	HTTPClient *http.Client
}

// ServerView is one McpServer of mcp.list (PROTOCOL.md §10.3).
type ServerView struct {
	Name         string    `json:"name"`
	Transport    Transport `json:"transport"`
	Description  *string   `json:"description"`
	State        string    `json:"state"`
	Detail       *string   `json:"detail"`
	AllowedTools []string  `json:"allowedTools"`
	OpenChannels int       `json:"openChannels"`
}

// OpenError is an mcp.open refusal, carrying the op error code.
type OpenError struct {
	Code    string
	Message string
}

func (e *OpenError) Error() string { return e.Message }

// Hub owns the machine's servers and their open channels.
type Hub struct {
	cfg    Config
	tokens *TokenStore
	client *http.Client

	mu          sync.Mutex
	entries     map[string]*Entry
	order       []string
	channels    map[string]*channel
	needsLogin  map[string]time.Time // name -> when it was flagged
	probed      map[string]bool      // name -> the server answered a probe without asking for a sign-in
	fileSig     string
	loadErr     string
	reloadCount int
	stopping    sync.WaitGroup // transports closing, for Shutdown to wait on
}

// New loads mcp.json and returns the hub.
func New(cfg Config) *Hub {
	if cfg.Lookup == nil {
		cfg.Lookup = os.LookupEnv
	}
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	if cfg.IdleTimeout == 0 {
		cfg.IdleTimeout = 10 * time.Minute
	}
	if cfg.PollEvery == 0 {
		cfg.PollEvery = 3 * time.Second
	}
	if cfg.MaxChannels == 0 {
		cfg.MaxChannels = 4
	}
	if cfg.OpenCheck == 0 {
		cfg.OpenCheck = 150 * time.Millisecond
	}
	if cfg.Send == nil {
		cfg.Send = func(string, []byte) error { return nil }
	}
	if cfg.Closed == nil {
		cfg.Closed = func(string, string, *string) {}
	}
	if cfg.Audit == nil {
		cfg.Audit = func(string, string, string) {}
	}
	client := cfg.HTTPClient
	if client == nil {
		client = newHTTPClient()
	}
	h := &Hub{cfg: cfg, client: client, entries: map[string]*Entry{}, channels: map[string]*channel{},
		needsLogin: map[string]time.Time{}, probed: map[string]bool{}}
	h.tokens = NewTokenStore(cfg.StateDir, client)
	h.Reload()
	return h
}

// Tokens is the hub's sign-in store (for galopin connectors login).
func (h *Hub) Tokens() *TokenStore { return h.tokens }

// Configured reports whether mcp.json exists, which is what makes an agent
// machine say mcp in its hello.
func (h *Hub) Configured() bool {
	_, err := os.Stat(h.cfg.Path)
	return err == nil
}

func (h *Hub) fileSignature() string {
	st, err := os.Stat(h.cfg.Path)
	if err != nil {
		return "absent"
	}
	return fmt.Sprintf("%d:%d", st.ModTime().UnixNano(), st.Size())
}

// Reload re-reads mcp.json. A file that does not parse leaves the servers as
// they were. Channels whose entry was removed or changed are closed with
// reason "config".
func (h *Hub) Reload() {
	sig := h.fileSignature()
	entries, err := Load(h.cfg.Path, h.cfg.Lookup)
	h.mu.Lock()
	h.fileSig = sig
	if err != nil {
		if h.loadErr != err.Error() {
			h.cfg.Logf("connectors: %v (keeping the previous servers)", err)
		}
		h.loadErr = err.Error()
		h.mu.Unlock()
		return
	}
	h.loadErr = ""
	next := map[string]*Entry{}
	order := make([]string, 0, len(entries))
	for _, e := range entries {
		next[e.Name] = e
		order = append(order, e.Name)
	}
	sort.Strings(order)
	var stale []*channel
	for name, old := range h.entries {
		if cur, ok := next[name]; !ok || !cur.Same(old) {
			delete(h.needsLogin, name)
			delete(h.probed, name)
		}
	}
	for _, ch := range h.channels {
		cur, ok := next[ch.entry.Name]
		if !ok || !cur.Same(ch.entry) || cur.State() != StateReady {
			stale = append(stale, ch)
		}
	}
	h.entries, h.order = next, order
	h.reloadCount++
	h.mu.Unlock()
	for _, ch := range stale {
		detail := "mcp.json changed"
		ch.shutdown("config", &detail, true)
	}
	if len(entries) > 0 || sig != "absent" {
		h.cfg.Logf("connectors: %d server(s) in mcp.json", len(entries))
	}
}

// Watch re-reads mcp.json when it changes (a poll of its mtime and size: no
// file-watching dependency) until ctx ends.
func (h *Hub) Watch(ctx context.Context) {
	t := time.NewTicker(h.cfg.PollEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.mu.Lock()
			same := h.fileSig == h.fileSignature()
			h.mu.Unlock()
			if !same {
				h.Reload()
			}
		}
	}
}

func loginSentence(name string) string {
	return "Run `galopin connectors login " + name + "` on this machine."
}

// loginNeeded reports whether name is waiting for a sign-in; a sign-in stored
// since it was flagged clears it.
func (h *Hub) loginNeeded(e *Entry) bool {
	h.mu.Lock()
	at, flagged := h.needsLogin[e.Name]
	h.mu.Unlock()
	if !flagged {
		return false
	}
	if mt := h.tokens.ModTime(e.Name); mt.After(at) && h.tokens.Load(e.Name, e.URL) != nil {
		h.mu.Lock()
		delete(h.needsLogin, e.Name)
		delete(h.probed, e.Name)
		h.mu.Unlock()
		return false
	}
	return true
}

func (h *Hub) flagLogin(name string) {
	h.mu.Lock()
	h.needsLogin[name] = time.Now()
	h.mu.Unlock()
}

// List is mcp.list.
func (h *Hub) List() []ServerView {
	h.mu.Lock()
	entries := make([]*Entry, 0, len(h.order))
	counts := map[string]int{}
	for _, n := range h.order {
		entries = append(entries, h.entries[n])
	}
	for _, ch := range h.channels {
		counts[ch.entry.Name]++
	}
	h.mu.Unlock()
	out := make([]ServerView, 0, len(entries))
	for _, e := range entries {
		v := ServerView{Name: e.Name, Transport: e.Transport, Description: e.Description,
			State: e.State(), AllowedTools: e.AllowedTools, OpenChannels: counts[e.Name]}
		if e.Invalid != "" {
			d := e.Invalid
			v.Detail = &d
		} else if v.State == StateReady && e.Transport != TransportStdio && h.loginNeeded(e) {
			v.State = StateNeedsLogin
			d := loginSentence(e.Name)
			v.Detail = &d
		}
		out = append(out, v)
	}
	return out
}

// Entry returns the named entry.
func (h *Hub) Entry(name string) *Entry {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.entries[name]
}

func newChannelID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return "ch_" + hex.EncodeToString(b)
}

// Open is mcp.open: a new channel to the named server.
func (h *Hub) Open(ctx context.Context, name string) (string, *OpenError) {
	h.mu.Lock()
	e := h.entries[name]
	open := 0
	for _, ch := range h.channels {
		if ch.entry.Name == name {
			open++
		}
	}
	h.mu.Unlock()
	switch {
	case e == nil:
		return "", &OpenError{"not_found", "no connector named " + name}
	case e.Invalid != "":
		return "", &OpenError{"forbidden", "the connector " + name + " is invalid: " + e.Invalid}
	case e.Disabled:
		return "", &OpenError{"forbidden", "the connector " + name + " is disabled on this machine"}
	case e.Transport != TransportStdio && h.loginNeeded(e):
		return "", &OpenError{"forbidden", "the connector " + name + " needs a sign-in. " + loginSentence(name)}
	case open >= h.cfg.MaxChannels:
		return "", &OpenError{"unavailable", fmt.Sprintf("the connector %s already has %d open channels", name, open)}
	}
	if e.Transport == TransportHTTP {
		if err := h.probe(ctx, e); err != nil {
			return "", err
		}
	}
	ch := newChannel(h, e)
	if oerr := ch.start(ctx); oerr != nil {
		return "", oerr
	}
	return ch.id, nil
}

// probe asks an http server once whether it wants a sign-in: a bare ping,
// answered or not, whose only use is a 401 with WWW-Authenticate or a
// connection error, both of which are better said at open than at the first
// request. Done once per entry until the file changes.
func (h *Hub) probe(ctx context.Context, e *Entry) *OpenError {
	h.mu.Lock()
	done := h.probed[e.Name]
	h.mu.Unlock()
	if done {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.URL,
		bytes.NewReader([]byte(`{"jsonrpc":"2.0","id":"galopin-probe","method":"ping"}`)))
	if err != nil {
		return &OpenError{"unavailable", "cannot build the request: " + urlErr(err).Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	hasAuth := false
	for k, v := range e.Headers {
		req.Header.Set(k, v)
		if strings.EqualFold(k, "Authorization") {
			hasAuth = true
		}
	}
	if !hasAuth {
		if hv, err := h.tokens.Header(ctx, e.Name, e.URL); err == nil && hv != "" {
			req.Header.Set("Authorization", hv)
		}
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return &OpenError{"unavailable", "cannot reach the server: " + urlErr(err).Error()}
	}
	resp.Body.Close()
	if oauthChallenge(resp, e) {
		h.flagLogin(e.Name)
		return &OpenError{"forbidden", "the connector " + e.Name + " needs a sign-in. " + loginSentence(e.Name)}
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return &OpenError{"unavailable", "the server answered 401 Unauthorized: check the Authorization header of " + e.Name + " in mcp.json"}
	}
	if resp.StatusCode >= 500 {
		return &OpenError{"unavailable", "the server answered " + resp.Status}
	}
	h.mu.Lock()
	h.probed[e.Name] = true
	h.mu.Unlock()
	return nil
}

// Close is mcp.close: an unknown or closed channel is fine.
func (h *Hub) Close(channelID string) {
	h.mu.Lock()
	ch := h.channels[channelID]
	h.mu.Unlock()
	if ch != nil {
		ch.shutdown("closed", nil, false)
	}
}

// Message is one mcp frame from Cerea.
func (h *Hub) Message(channelID string, raw []byte) {
	h.mu.Lock()
	ch := h.channels[channelID]
	h.mu.Unlock()
	if ch == nil {
		// Cerea may be holding a channel galopin has closed: say so.
		h.cfg.Closed(channelID, "closed", nil)
		return
	}
	ch.fromClient(raw)
}

// LinkDown closes every channel (PROTOCOL.md §10.6): nobody is left to hear
// a closed frame.
func (h *Hub) LinkDown() { h.closeAll() }

// Shutdown closes every channel and waits for the servers to stop.
func (h *Hub) Shutdown() { h.closeAll() }

func (h *Hub) closeAll() {
	h.mu.Lock()
	all := make([]*channel, 0, len(h.channels))
	for _, ch := range h.channels {
		all = append(all, ch)
	}
	h.mu.Unlock()
	for _, ch := range all {
		ch.shutdown("closed", nil, false)
	}
	done := make(chan struct{})
	go func() { h.stopping.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(6 * time.Second):
	}
}

// OpenChannels is the number of channels open now.
func (h *Hub) OpenChannels() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.channels)
}
