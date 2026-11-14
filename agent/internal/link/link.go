// Package link is the WSS client that dials Cerea (PROTOCOL.md §3): hello,
// welcome, status, req/res, event pushes, credential-state and token-renewal
// frames, with reconnect/backoff and the machine's own confirmation gate
// (nothing is forwarded to the Handler until Cerea says "paired").
package link

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// Credential is the single in-process source of truth for the access token
// the link authenticates with (R7): the same source the shim's HTTP
// handler uses, so the shim and the link never disagree about the
// credential's state or race each other refreshing it.
type Credential interface {
	// Token returns a currently valid access token, refreshing first if
	// the cached one is within its skew of expiry.
	Token(ctx context.Context) (string, error)
	// ForceRefresh refreshes regardless of the cached token's remaining
	// lifetime — used after Cerea answers 4401, which means the token it
	// saw was already unacceptable, skew or not, and by the renewal loop,
	// whose whole point is a new token at ~70% of the old one's life.
	ForceRefresh(ctx context.Context) (string, error)
	// NextRenewal is when the link should proactively renew and push a
	// fresh auth frame — nominally ~70% of the current token's lifetime.
	NextRenewal() time.Time
}

// Rotator is implemented by a Credential that can say when its access token
// changed without the link asking: the shim's own timed refresh, a refresh a
// proxied request triggered, a newer credential file adopted. Rotated returns
// a channel that gets a signal after each change (one pending signal is
// enough: the link reads the current token when it wakes). The link then hands
// the new token to Cerea over the open connection at once. Without this an IdP
// that revokes the previous access token on refresh (GitLab's) leaves the
// link holding a token the IdP no longer accepts, and Cerea closes it with
// 4401 at its next check. A Credential that is not a Rotator keeps the old
// behaviour: renewal at ~70% of the token's lifetime only.
type Rotator interface {
	Rotated() <-chan struct{}
}

// AgentInfo, BackendInfo and PolicyInfo mirror the hello frame's nested
// objects (PROTOCOL.md §5) without this package importing internal/backend
// or internal/policy — the caller assembling a Hello already holds real
// values from both and flattens them here, so link stays a pure transport.
type AgentInfo struct {
	Version  string `json:"version"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
	Hostname string `json:"hostname"`
	// Container is true inside a container (Docker, Podman): such a galopin is upgraded by
	// pulling the new image, so the panel does not offer the installer's --upgrade for it.
	Container bool `json:"container,omitempty"`
}

// PermissionInfo is policy.json's permission block as the hello reports it.
type PermissionInfo struct {
	// Max is the ceiling, permission key → "ask" | "deny"; a key absent from
	// it is not capped.
	Max map[string]string `json:"max"`
}

type BackendInfo struct {
	ID           string          `json:"id"`
	Version      string          `json:"version"`
	Capabilities map[string]bool `json:"capabilities"`
}

type PolicyInfo struct {
	// AutoAccept is the constant "denied": auto-accept no longer exists. Cerea's
	// hello schema still requires the field, so it is sent for one more release
	// and dropped after (PROTOCOL.md §5).
	AutoAccept string `json:"autoAccept"`
	// Permission is the machine's say over opencode's permissions.
	Permission      PermissionInfo `json:"permission"`
	WorkspaceRoots  []string       `json:"workspaceRoots"`
	AllowFreeModels bool           `json:"allowFreeModels"`
	Files           string         `json:"files"`
	FileDeny        []string       `json:"fileDeny"`
	// FileWrite is the editor's save veto (PROTOCOL.md §9.3 files.write):
	// "allowed" or "denied" (default). Older machines omit it, and have no
	// files.write either.
	FileWrite    string `json:"fileWrite,omitempty"`
	Terminal     string `json:"terminal"`
	MaxTerminals int    `json:"maxTerminals"`
	// CommandShell is the slash-command shell-expansion veto (PROTOCOL.md
	// §6 session.command): "allowed" or "denied". While denied the machine
	// refuses every command whose template expands shell, and every command
	// whose shell is unknown, so the menu can grey those rows with the
	// reason instead of letting a 403 be the explanation.
	CommandShell string `json:"commandShell"`
	// AgentTools is the agent-coordination tools' opt-out (PROTOCOL.md §4/§6
	// "Agent tools"): "allowed" (default) or "denied". Older machines omit
	// it: decide from the backend's agentTools capability alone.
	AgentTools string `json:"agentTools,omitempty"`
	// ProjectConfig is whether opencode loads a workspace's own config
	// (PROTOCOL.md §4): "allowed" or "denied" (default). Older machines
	// omit it, and they load it.
	ProjectConfig string `json:"projectConfig,omitempty"`
	// BackgroundSubagents is whether opencode may run background subagents
	// (task background:true): "allowed" or "denied" (default). Older
	// machines omit it, read as denied: the env flag was never set there.
	BackgroundSubagents string `json:"backgroundSubagents,omitempty"`
	// Warnings are machine-level advisories for the device card (today:
	// opencode global config pinning a model outside Pystino). Absent when
	// there is nothing to say; a Cerea that predates the field ignores it.
	Warnings []string `json:"warnings,omitempty"`
}

// MachineInfo is hello.machine (PROTOCOL.md §5, §9): what this build can
// do on this OS, independent of the backend. The policy says whether the
// owner allows it; both must hold.
type MachineInfo struct {
	Capabilities map[string]bool `json:"capabilities"`
	// Mode is "agent" (a backend runs) or "connectors" (galopin run --backend
	// none: only the machine's MCP servers, PROTOCOL.md §10.2). An older
	// galopin omits it, read as "agent".
	Mode string `json:"mode,omitempty"`
}

// Hello is the whole first frame's payload (protocol and type are added by
// the link itself).
type Hello struct {
	Agent          AgentInfo     `json:"agent"`
	Backends       []BackendInfo `json:"backends"`
	Machine        MachineInfo   `json:"machine"`
	Policy         PolicyInfo    `json:"policy"`
	CredentialInfo string        `json:"-"` // set via SetCredentialState before each dial
}

// OpError is a req's refusal, encoded as the res frame's "error" object.
// Code is one of PROTOCOL.md §5's fixed set: not_found, invalid, forbidden,
// unavailable, backend, unsupported.
type OpError struct {
	Code    string
	Message string
	// Details is the error's optional "details" object (files.write's
	// conflict carries {revision}); nil sends none.
	Details any
}

func (e *OpError) Error() string { return e.Message }

// Handler answers one req frame's op. It runs in its own goroutine per
// request under a per-op deadline the link enforces via ctx; result is
// json.Marshal'd into the res frame's "result" field on success.
type Handler interface {
	Handle(ctx context.Context, op string, args json.RawMessage) (result any, opErr *OpError)
}

// BinaryHandler routes inbound binary frames (PROTOCOL.md §9.2): term.input
// and term.ack, both C→M. channel is whatever Cerea chose in the
// terminal.attach that opened it; the handler (internal/terminal via
// dispatch.go's machine) is what maps a channel back to its terminal.
// Frames of an unrecognized kind are dropped before ever reaching this
// (PROTOCOL.md: "unknown kinds are ignored").
type BinaryHandler interface {
	HandleBinary(kind byte, channel string, offset uint64, payload []byte)
}

// McpHandler carries the mcp frames (PROTOCOL.md §10.3). HandleMcp must not
// block: frames of one channel arrive in order and the read loop waits for it.
type McpHandler interface {
	// HandleMcp gets one C→M mcp frame's message, raw JSON-RPC.
	HandleMcp(channelID string, message json.RawMessage)
	// LinkDown is called when the connection ends: every channel is gone.
	LinkDown()
}

// Config is everything one Link needs. Defaults are applied by New for
// zero-valued timeouts/backoff so a caller only sets what it wants to
// override.
type Config struct {
	// CereaOrigin is the origin Cerea serves the link endpoint on, e.g.
	// "https://cerea.example.org" or "http://127.0.0.1:PORT" in tests. The
	// dial target is CereaOrigin + "/api/v2/code/machine", with the scheme
	// swapped for ws/wss.
	CereaOrigin string
	MachineID   string
	MachineName string
	Cred        Credential
	Hello       func() Hello
	Handler     Handler
	// Binary is consulted for every inbound binary frame (term.input,
	// term.ack). Left nil on a build/config with no terminal support, in
	// which case inbound binary frames are simply dropped.
	Binary BinaryHandler
	// Mcp receives mcp frames and the link-down signal; nil on a machine with
	// no connectors, which drops the frames.
	Mcp McpHandler

	// DialTimeout bounds one connection attempt (default 10s, PROTOCOL.md §3).
	DialTimeout time.Duration
	// MinBackoff/MaxBackoff bound reconnect backoff (default 1s / 30s).
	MinBackoff time.Duration
	MaxBackoff time.Duration
	// HealthyAfter is how long a connection must have been up for it to count
	// as healthy (default 1 minute): the next reconnect then starts from
	// MinBackoff again instead of carrying the backoff of earlier failures, and
	// the quick re-dials after a 4401 (see Run) are available again.
	HealthyAfter time.Duration
	// DefaultOpTimeout/SyncOpTimeout bound req handling (default 15s / 20s).
	DefaultOpTimeout time.Duration
	SyncOpTimeout    time.Duration
	// CallTimeout bounds one M→C call (default 20s, PROTOCOL.md §5 "Machine
	// calls"): a Cerea that predates calls ignores the frame, so a call that
	// is never answered must end on its own.
	CallTimeout time.Duration

	// PingInterval/PingTimeout drive the client-side liveness check (default
	// 20s / 10s): the link pings Cerea itself, and a ping unanswered within
	// PingTimeout ends the connection for an immediate redial. Without it a
	// half-open TCP connection (after a Mac's sleep or a network change) never
	// reports an error and the link stays "connected" forever.
	PingInterval time.Duration
	PingTimeout  time.Duration
	// TickInterval is the wake-detector's tick (default 5s); WakeJump is the
	// wall-clock jump over a tick that counts as a sleep (default 30s) and
	// triggers a ping at once. Now is the wall clock (default time.Now), so
	// tests can inject a jump.
	TickInterval time.Duration
	WakeJump     time.Duration
	Now          func() time.Time

	// Logf receives lifecycle-only messages (connecting, connected, paired,
	// reconnecting, giving up) — never frame contents (R6). Defaults to a
	// no-op.
	Logf func(format string, args ...any)
}

// ErrRevoked signals Run's caller that Cerea closed with 4403: the owner
// revoked this machine (PROTOCOL.md §4). It is terminal wherever it arrives,
// the welcome handshake included: the same machine id is refused on every
// later connect, so reconnecting only loops.
var ErrRevoked = errors.New("link: this machine was revoked (4403)")

// errGiveUp is ErrRevoked's old name inside this package.
var errGiveUp = ErrRevoked

// isRevokedClose reports whether err is Cerea's 4403 close.
func isRevokedClose(err error) bool {
	var closeErr websocket.CloseError
	return errors.As(err, &closeErr) && closeErr.Code == 4403
}

// ErrExpired signals the caller that credential refresh (on a 4401) itself
// failed permanently — the caller (run's top level) is expected to react
// the way serve.go's shim already does to a dead credential.
var ErrExpired = errors.New("link: credential refresh failed")

// redialError ends a connection Cerea closed with 4401 once the credential
// holds a token to try: there is nothing to wait for, so Run dials again at
// once (within maxQuickRedials) instead of after the reconnect backoff.
type redialError struct{ msg string }

func (e *redialError) Error() string { return e.msg }

// deadLinkError ends a connection the liveness check found dead (a ping got no
// pong, or the machine woke from sleep and the peer did not answer). The
// network is likely different now, so Run dials again at once, from the
// minimum backoff; a dial that then fails goes through the ordinary backoff.
type deadLinkError struct{ msg string }

func (e *deadLinkError) Error() string { return e.msg }

// maxQuickRedials bounds the back-to-back re-dials after a 4401, counted
// since the last healthy connection: a fresh token that Cerea keeps refusing
// is a real failure, and it goes through the ordinary backoff from the next
// one on.
const maxQuickRedials = 3

// maxEarlyFrames bounds the frames kept from before the welcome.
const maxEarlyFrames = 32

// Link is one machine's connection to Cerea. Not safe for concurrent Run
// calls; everything else is.
type Link struct {
	cfg Config

	mu      sync.Mutex
	paired  bool
	conn    *websocket.Conn
	connCtx context.Context // valid only while conn != nil; for writes issued from other goroutines
	sched   *scheduler      // the two-lane writer for the current connection; nil when not connected
	// machineCalls is welcome.features.machineCalls of the current
	// connection: the call families this Cerea answers.
	machineCalls []string
	// held is the access token Cerea has for the current connection: the one
	// dialled with, then each one handed over in an auth frame. welcomedAt is
	// when the current connection's welcome arrived (zero before it).
	held       string
	welcomedAt time.Time

	callSeq uint64
	pending map[string]chan callResult // call id -> its waiter, for the current connection
}

func New(cfg Config) *Link {
	if cfg.DialTimeout == 0 {
		cfg.DialTimeout = 10 * time.Second
	}
	if cfg.MinBackoff == 0 {
		cfg.MinBackoff = time.Second
	}
	if cfg.MaxBackoff == 0 {
		cfg.MaxBackoff = 30 * time.Second
	}
	if cfg.HealthyAfter == 0 {
		cfg.HealthyAfter = time.Minute
	}
	if cfg.DefaultOpTimeout == 0 {
		cfg.DefaultOpTimeout = 15 * time.Second
	}
	if cfg.SyncOpTimeout == 0 {
		cfg.SyncOpTimeout = 20 * time.Second
	}
	if cfg.CallTimeout == 0 {
		cfg.CallTimeout = 20 * time.Second
	}
	if cfg.PingInterval == 0 {
		cfg.PingInterval = 20 * time.Second
	}
	if cfg.PingTimeout == 0 {
		cfg.PingTimeout = 10 * time.Second
	}
	if cfg.TickInterval == 0 {
		cfg.TickInterval = 5 * time.Second
	}
	if cfg.WakeJump == 0 {
		cfg.WakeJump = 30 * time.Second
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	return &Link{cfg: cfg, pending: map[string]chan callResult{}}
}

// Paired reports whether Cerea has confirmed this machine (PROTOCOL.md §4):
// before that, every req is refused without reaching the Handler.
func (l *Link) Paired() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.paired
}

// Connected reports whether the link has a live connection that Cerea has
// welcomed (it is false while dialling, between reconnects and after Close).
func (l *Link) Connected() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.conn != nil && !l.welcomedAt.IsZero()
}

// Close sends a normal WebSocket close frame on the current connection, if
// any. Best effort and non-blocking on the network: used at shutdown so
// Cerea sees a clean close instead of the connection just dropping when
// this process exits (which still works, but leaves Cerea to notice via a
// read error or a missed ping instead of being told directly).
func (l *Link) Close() error {
	l.mu.Lock()
	conn := l.conn
	l.mu.Unlock()
	if conn == nil {
		return nil
	}
	return conn.Close(websocket.StatusNormalClosure, "agent shutting down")
}

// Run dials, serves, and reconnects with backoff until ctx is cancelled or
// Cerea closes with 4403 (revoked — PROTOCOL.md §3/§4), which Run treats as
// permanent and returns errGiveUp for.
//
// The backoff is for failures. A connection that stayed up for HealthyAfter
// starts the next wait from MinBackoff again (it used to carry every earlier
// failure's doubling, so after a few drops each one cost the maximum). And a
// 4401 that the credential could answer (the token the connection held is no
// longer acceptable, and a newer one is ready) is a redial, not a failure: it
// goes straight back, up to maxQuickRedials in a row without a healthy
// connection in between.
func (l *Link) Run(ctx context.Context) error {
	backoff := l.cfg.MinBackoff
	quick := 0
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		err := l.runOnce(ctx)
		if errors.Is(err, errGiveUp) {
			l.cfg.Logf("link: machine revoked, not reconnecting")
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if up := l.takeUptime(); up >= l.cfg.HealthyAfter {
			backoff = l.cfg.MinBackoff
			quick = 0
		}
		var dead *deadLinkError
		if errors.As(err, &dead) {
			backoff = l.cfg.MinBackoff
			quick = 0
			l.cfg.Logf("link: disconnected (%v), reconnecting now", err)
			continue
		}
		var redial *redialError
		if errors.As(err, &redial) && quick < maxQuickRedials {
			quick++
			l.cfg.Logf("link: disconnected (%v), reconnecting now", err)
			continue
		}
		// The close code and reason are the one clue to a rejected handshake
		// or hello (4000/4401/4403), so they are always worth the line.
		l.cfg.Logf("link: disconnected (%v), reconnecting in %s", err, backoff)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(jitter(backoff)):
		}
		backoff *= 2
		if backoff > l.cfg.MaxBackoff {
			backoff = l.cfg.MaxBackoff
		}
	}
}

// takeUptime is how long the connection that just ended was up (zero when it
// never got its welcome), and forgets it.
func (l *Link) takeUptime() time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	since := l.welcomedAt
	l.welcomedAt = time.Time{}
	if since.IsZero() {
		return 0
	}
	return time.Since(since)
}

// heldToken is the access token Cerea has for the current connection.
func (l *Link) heldToken() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.held
}

func (l *Link) setHeld(token string) {
	l.mu.Lock()
	l.held = token
	l.mu.Unlock()
}

func jitter(d time.Duration) time.Duration {
	// +/- 20%, so many machines reconnecting after the same outage don't
	// all knock at once.
	delta := time.Duration(rand.Int63n(int64(d)*2/5)) - d*2/10
	return d + delta
}

// MaxFrameBytes bounds one frame from Cerea (a prompt with its attachments).
const MaxFrameBytes = 160 << 20

func dialURL(origin string) (string, error) {
	origin = strings.TrimSuffix(origin, "/")
	switch {
	case strings.HasPrefix(origin, "https://"):
		return "wss://" + strings.TrimPrefix(origin, "https://") + "/api/v2/code/machine", nil
	case strings.HasPrefix(origin, "http://"):
		return "ws://" + strings.TrimPrefix(origin, "http://") + "/api/v2/code/machine", nil
	default:
		return "", fmt.Errorf("cerea origin must be http(s): %q", origin)
	}
}

// runOnce performs exactly one connection's lifecycle: dial, hello,
// welcome, then serve frames until the connection ends.
// refusalReason reads the (short) body of a refused upgrade response.
func refusalReason(resp *http.Response) string {
	if resp == nil || resp.Body == nil {
		return ""
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	reason := strings.TrimSpace(string(body))
	// A JSON error body ({"error":"..."}) reads better as its message.
	var j struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &j) == nil {
		if j.Error != "" {
			reason = j.Error
		} else if j.Message != "" {
			reason = j.Message
		}
	}
	return reason
}

func (l *Link) runOnce(ctx context.Context) error {
	target, err := dialURL(l.cfg.CereaOrigin)
	if err != nil {
		return err
	}
	token, err := l.cfg.Cred.Token(ctx)
	if err != nil {
		return fmt.Errorf("getting access token: %w", err)
	}
	l.mu.Lock()
	l.held = token
	l.welcomedAt = time.Time{}
	l.mu.Unlock()

	dialCtx, cancel := context.WithTimeout(ctx, l.cfg.DialTimeout)
	defer cancel()
	header := http.Header{}
	header.Set("Authorization", "Bearer "+token)
	header.Set("X-Pystino-Machine-Id", l.cfg.MachineID)
	header.Set("X-Pystino-Machine-Name", l.cfg.MachineName)

	l.cfg.Logf("link: dialing %s", l.cfg.CereaOrigin)
	conn, resp, err := websocket.Dial(dialCtx, target, &websocket.DialOptions{
		HTTPHeader:   header,
		Subprotocols: []string{"pystino-machine.v1"},
	})
	if err != nil {
		// A refused upgrade carries Cerea's reason in the body (for example
		// "Sign in to Cerea once before connecting a machine"): show it.
		if reason := refusalReason(resp); reason != "" {
			return fmt.Errorf("dialing cerea: %w: %s", err, reason)
		}
		return fmt.Errorf("dialing cerea: %w", err)
	}
	defer conn.CloseNow()
	// coder/websocket reads at most 32 KiB per message by default, and a prompt
	// carrying an image or a file is far larger: the frame would kill the
	// connection. Cerea caps an attachment at 10 MiB and a message at 10
	// attachments, base64 inflating them by a third.
	conn.SetReadLimit(MaxFrameBytes)

	connCtx, connCancel := context.WithCancel(ctx)
	defer connCancel()

	sched := newScheduler(conn)
	l.mu.Lock()
	l.conn = conn
	l.connCtx = connCtx
	l.sched = sched
	l.paired = false
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		l.conn = nil
		l.sched = nil
		l.paired = false
		l.machineCalls = nil
		l.mu.Unlock()
		l.failPending("the link to Cerea dropped before it answered")
		if l.cfg.Mcp != nil {
			l.cfg.Mcp.LinkDown()
		}
	}()
	go sched.run(connCtx)

	// The liveness watcher runs from the dial on (the welcome read needs it
	// too). It only cancels connCtx and closes the socket; whichever read is
	// blocked then fails, and the error is replaced by deadLinkError below.
	var dead atomic.Pointer[deadLinkError]
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		if why := l.watchLiveness(connCtx, conn); why != "" {
			dead.Store(&deadLinkError{msg: "link: " + why})
			l.cfg.Logf("link: %s, closing the connection", why)
			connCancel()
			conn.CloseNow()
		}
	}()
	defer func() { connCancel(); <-watchDone }()
	err = l.runConn(connCtx, conn, connCancel)
	if d := dead.Load(); d != nil && ctx.Err() == nil {
		return d
	}
	return err
}

// watchLiveness pings Cerea every PingInterval, and at once when the wall
// clock jumped (the machine slept) or the connection has been quiet since a
// wake. It returns "" when ctx ends, or the reason the peer is dead. conn.Ping
// is a WebSocket control frame, so a stream backlog does not delay it; the
// pong is read by the connection's ordinary read loop.
func (l *Link) watchLiveness(ctx context.Context, conn *websocket.Conn) string {
	// Round(0) drops the monotonic reading: on macOS it stops during sleep,
	// which is exactly the jump this has to see.
	last := l.cfg.Now().Round(0)
	lastPing := last
	ticker := time.NewTicker(l.cfg.TickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ""
		case <-ticker.C:
		}
		now := l.cfg.Now().Round(0)
		jumped := now.Sub(last) > l.cfg.TickInterval+l.cfg.WakeJump
		last = now
		if !jumped && now.Sub(lastPing) < l.cfg.PingInterval {
			continue
		}
		lastPing = now
		pctx, cancel := context.WithTimeout(ctx, l.cfg.PingTimeout)
		err := conn.Ping(pctx)
		cancel()
		if ctx.Err() != nil {
			return ""
		}
		if err != nil {
			// A close the peer sent (4401, 4403, ...) is the read loop's to
			// act on, not a dead link.
			var closeErr websocket.CloseError
			if errors.As(err, &closeErr) {
				return ""
			}
			if jumped {
				return fmt.Sprintf("no answer after the machine woke (%v)", err)
			}
			return fmt.Sprintf("no answer to ping (%v)", err)
		}
		lastPing = l.cfg.Now().Round(0)
	}
}

// runConn is the connection's protocol part: hello, welcome, serve.
func (l *Link) runConn(connCtx context.Context, conn *websocket.Conn, connCancel context.CancelFunc) error {
	hello := l.cfg.Hello()
	if err := l.writeFrame(connCtx, map[string]any{
		"type":     "hello",
		"protocol": 1,
		"agent":    hello.Agent,
		"backends": hello.Backends,
		"machine":  hello.Machine,
		"policy":   hello.Policy,
		"credential": map[string]string{
			"state": defaultString(hello.CredentialInfo, "ok"),
		},
	}); err != nil {
		return fmt.Errorf("sending hello: %w", err)
	}

	var welcome struct {
		Type     string `json:"type"`
		DeviceID string `json:"deviceId"`
		Status   string `json:"status"`
		Features struct {
			MachineCalls []string `json:"machineCalls"`
		} `json:"features"`
	}
	// A server may put a frame of its own (a req about a session it is
	// watching, a status) ahead of the welcome: Cerea's connection listeners
	// used to run before the welcome was sent. Those frames are kept and
	// handled once the machine is paired, as if they had come after it; a
	// frame that is not JSON is dropped, and a server that sends more than
	// maxEarlyFrames without ever welcoming is not speaking the protocol.
	var early [][]byte
	for {
		typ, raw, err := l.readTyped(connCtx, conn)
		if err != nil {
			if isRevokedClose(err) {
				return errGiveUp
			}
			return fmt.Errorf("reading welcome: %w", err)
		}
		if typ == websocket.MessageBinary {
			continue
		}
		var head struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &head) != nil {
			continue
		}
		if head.Type == "welcome" {
			if err := json.Unmarshal(raw, &welcome); err != nil {
				return fmt.Errorf("reading welcome: %w", err)
			}
			break
		}
		if len(early) >= maxEarlyFrames {
			return fmt.Errorf("expected welcome, got %q", head.Type)
		}
		early = append(early, raw)
	}
	l.setPaired(welcome.Status == "paired")
	l.mu.Lock()
	l.machineCalls = welcome.Features.MachineCalls
	l.welcomedAt = time.Now()
	l.mu.Unlock()
	l.cfg.Logf("link: connected (device %s, status %s)", welcome.DeviceID, welcome.Status)

	renewalDone := make(chan struct{})
	go func() {
		defer close(renewalDone)
		l.renewalLoop(connCtx)
	}()
	defer func() { connCancel(); <-renewalDone }()

	for _, raw := range early {
		l.dispatch(connCtx, websocket.MessageText, raw)
	}
	return l.serve(connCtx, conn)
}

func defaultString(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func (l *Link) setPaired(v bool) {
	l.mu.Lock()
	l.paired = v
	l.mu.Unlock()
}

// minRenewalGap bounds how often the loop may push an auth frame, whatever
// NextRenewal says: a renewal instant that stays in the past (a credential
// that cannot move it on) must cost one frame a minute, not a flood.
const minRenewalGap = time.Minute

// renewalLoop keeps Cerea holding a token the IdP will still accept, for as
// long as this connection lives, by pushing auth frames (PROTOCOL.md §3). Two
// things make it push:
//
//   - the token reaches ~70% of its lifetime: it ROTATES the token
//     (ForceRefresh) and pushes the new one. It used to ask Token, which hands
//     back the cached token until its last minute: the same token was pushed,
//     NextRenewal stayed in the past, and the loop pushed it again with no wait
//     until the token nearly expired, thousands of frames the chat checked one
//     by one (for GitLab's opaque tokens, a token-info call each). The real
//     rotation then queued behind them, while GitLab, which revokes the old
//     access token on refresh, already refused the token the chat still held,
//     so the chat's revalidation revoked the device.
//   - the credential rotated on its own (a Rotator): the shim refreshes every
//     15 minutes and on a request that finds the token near expiry, without
//     asking the link. Against GitLab that refresh revokes the token Cerea
//     holds for this connection, and Cerea closes the link with 4401 at its
//     next check: the machine went offline for 30 s about every 15 minutes. The
//     current token is handed over at once (no rotation: Token, not
//     ForceRefresh), when it is not the one Cerea already has.
//
// The wait for the 70% mark is worked out again after every wake-up, so it
// follows a token that rotated meanwhile.
func (l *Link) renewalLoop(ctx context.Context) {
	var rotated <-chan struct{}
	if r, ok := l.cfg.Cred.(Rotator); ok {
		rotated = r.Rotated()
	}
	var last time.Time
	for {
		wait := time.Until(l.cfg.Cred.NextRenewal())
		if gap := minRenewalGap - time.Since(last); !last.IsZero() && wait < gap {
			wait = gap
		}
		if wait < 0 {
			wait = 0
		}
		timer := time.NewTimer(wait)
		var token string
		var err error
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-rotated:
			timer.Stop()
			token, err = l.cfg.Cred.Token(ctx)
			if err == nil && (token == "" || token == l.heldToken()) {
				continue // nothing new to hand over
			}
			if err != nil {
				last = time.Now()
			}
		case <-timer.C:
			last = time.Now()
			token, err = l.cfg.Cred.ForceRefresh(ctx)
		}
		if err != nil {
			l.cfg.Logf("link: token renewal failed: %v", err)
			continue
		}
		if err := l.writeFrame(ctx, map[string]any{"type": "auth", "token": token}); err != nil {
			return
		}
		l.setHeld(token)
	}
}

// serve reads frames until the connection ends, dispatching each.
func (l *Link) serve(ctx context.Context, conn *websocket.Conn) error {
	for {
		typ, raw, err := l.readTyped(ctx, conn)
		if err != nil {
			var closeErr websocket.CloseError
			if errors.As(err, &closeErr) {
				switch closeErr.Code {
				case 4403:
					return errGiveUp
				case 4404:
					// ADR 0095: the join gate refused this account. The device
					// stays enrolled; Run's ordinary backoff retries, and the
					// link comes back when the groups say so. Not a refresh (the
					// token is fine), not a revocation.
					return fmt.Errorf("link: outside the access groups (4404), retrying")
				case 4401:
					return l.reauthAfter4401(ctx)
				}
			}
			return err
		}
		l.dispatch(ctx, typ, raw)
	}
}

// reauthAfter4401 answers Cerea closing the link with 4401: the token it held
// for this connection is not acceptable any more. If the credential has moved
// on since (the shim refreshed on its own), the newer token is what the next
// dial uses and no further rotation is made (each one revokes the previous
// token at an IdP like GitLab). Otherwise the token is rotated now. Either way
// the result is a redialError, which Run dials again at once; a refresh that
// fails is ErrExpired, and the ordinary backoff.
func (l *Link) reauthAfter4401(ctx context.Context) error {
	held := l.heldToken()
	if current, err := l.cfg.Cred.Token(ctx); err == nil && current != "" && current != held {
		return &redialError{msg: "link: token rejected (4401), a newer token is ready"}
	}
	if _, err := l.cfg.Cred.ForceRefresh(ctx); err != nil {
		return fmt.Errorf("%w: %v", ErrExpired, err)
	}
	return &redialError{msg: "link: token rejected (4401), refreshed for next dial"}
}

// dispatch handles one frame from Cerea.
func (l *Link) dispatch(ctx context.Context, typ websocket.MessageType, raw []byte) {
	if typ == websocket.MessageBinary {
		l.handleBinaryFrame(raw)
		return
	}
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return // malformed frame: ignore, per PROTOCOL.md §5 forward-compat rule
	}
	switch envelope.Type {
	case "status":
		var status struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(raw, &status) == nil && status.Status == "paired" {
			l.setPaired(true)
			l.cfg.Logf("link: paired")
		}
	case "req":
		var req struct {
			ID   string          `json:"id"`
			Op   string          `json:"op"`
			Args json.RawMessage `json:"args"`
		}
		if json.Unmarshal(raw, &req) != nil {
			return
		}
		go l.handleReq(ctx, req.ID, req.Op, req.Args)
	case "mcp":
		if !l.Paired() || l.cfg.Mcp == nil {
			return
		}
		var f struct {
			ChannelID string          `json:"channelId"`
			Message   json.RawMessage `json:"message"`
		}
		if json.Unmarshal(raw, &f) != nil || f.ChannelID == "" || len(f.Message) == 0 {
			return
		}
		l.cfg.Mcp.HandleMcp(f.ChannelID, f.Message)
	case "callres":
		l.handleCallRes(raw)
	default:
		// Unknown frame types are ignored (forward compatibility,
		// PROTOCOL.md §5).
	}
}

func opTimeout(cfg Config, op string) time.Duration {
	if op == "session.sync" {
		return cfg.SyncOpTimeout
	}
	return cfg.DefaultOpTimeout
}

func (l *Link) handleReq(ctx context.Context, id, op string, args json.RawMessage) {
	reqCtx, cancel := context.WithTimeout(ctx, opTimeout(l.cfg, op))
	defer cancel()

	if !l.Paired() {
		l.sendError(ctx, id, "forbidden", "awaiting confirmation in the browser")
		return
	}
	result, opErr := l.cfg.Handler.Handle(reqCtx, op, args)
	if opErr != nil {
		l.sendErrorDetails(ctx, id, opErr.Code, opErr.Message, opErr.Details)
		return
	}
	if err := l.writeFrame(ctx, map[string]any{
		"type": "res", "id": id, "ok": true, "result": result,
	}); err != nil {
		l.cfg.Logf("link: sending res for %s failed: %v", id, err)
	}
}

func (l *Link) sendError(ctx context.Context, id, code, message string) {
	l.sendErrorDetails(ctx, id, code, message, nil)
}

func (l *Link) sendErrorDetails(ctx context.Context, id, code, message string, details any) {
	body := map[string]any{"code": code, "message": message}
	if details != nil {
		body["details"] = details
	}
	_ = l.writeFrame(ctx, map[string]any{"type": "res", "id": id, "ok": false, "error": body})
}

// PublishEvent sends one event frame. Best-effort: if there is no live
// connection, it returns an error and the caller drops it — the
// materializer's ring buffer and session.sync are the actual gap-recovery
// path (PROTOCOL.md §7), not this send succeeding. rootSessionID names
// the session's top-level ancestor (itself for a top-level session), so
// Cerea can fan a child's envelopes out to its root's watchers.
func (l *Link) PublishEvent(sessionID, epoch string, seq int64, rootSessionID string, event json.RawMessage) error {
	l.mu.Lock()
	ctx := l.connCtx
	l.mu.Unlock()
	if ctx == nil {
		return errors.New("link: not connected")
	}
	return l.writeFrame(ctx, map[string]any{
		"type": "event", "sessionId": sessionID, "epoch": epoch, "seq": seq, "rootSessionId": rootSessionID, "event": json.RawMessage(event),
	})
}

// PublishMcp sends one M→C mcp frame: a server's message on a channel,
// passed through unchanged (PROTOCOL.md §10.3).
func (l *Link) PublishMcp(channelID string, message json.RawMessage) error {
	l.mu.Lock()
	ctx := l.connCtx
	l.mu.Unlock()
	if ctx == nil {
		return errors.New("link: not connected")
	}
	return l.writeFrame(ctx, map[string]any{"type": "mcp", "channelId": channelID, "message": message})
}

// PublishMcpClosed tells Cerea a channel has ended (PROTOCOL.md §10.3);
// detail may be nil.
func (l *Link) PublishMcpClosed(channelID, reason string, detail *string) error {
	l.mu.Lock()
	ctx := l.connCtx
	l.mu.Unlock()
	if ctx == nil {
		return errors.New("link: not connected")
	}
	return l.writeFrame(ctx, map[string]any{
		"type": "mcp", "channelId": channelID,
		"closed": map[string]any{"reason": reason, "detail": detail},
	})
}

// PublishCredentialState sends a credential frame (PROTOCOL.md §5) — used
// so Cerea learns "expired" before the socket necessarily dies, letting it
// show the re-enroll card immediately rather than waiting for a timeout.
func (l *Link) PublishCredentialState(state, detail string) error {
	l.mu.Lock()
	ctx := l.connCtx
	l.mu.Unlock()
	if ctx == nil {
		return errors.New("link: not connected")
	}
	return l.writeFrame(ctx, map[string]any{"type": "credential", "state": state, "detail": detail})
}

// writeFrame marshals v and sends it on the control lane (PROTOCOL.md §9.2:
// res, event, notice, credential and auth are all control — always drained
// before any queued term.output stream frame).
func (l *Link) writeFrame(ctx context.Context, v any) error {
	body, err := json.Marshal(v)
	if err != nil {
		return err
	}
	l.mu.Lock()
	sched := l.sched
	l.mu.Unlock()
	if sched == nil {
		return errors.New("link: not connected")
	}
	return sched.writeControl(ctx, websocket.MessageText, body)
}

// SendTerminalOutput sends one term.output binary frame on the stream lane
// (PROTOCOL.md §9.2). payload must already be at most link.MaxOutputFrame;
// internal/terminal's flushViewer is what guarantees that.
func (l *Link) SendTerminalOutput(channel string, offset uint64, payload []byte) error {
	l.mu.Lock()
	sched := l.sched
	ctx := l.connCtx
	l.mu.Unlock()
	if sched == nil || ctx == nil {
		return errors.New("link: not connected")
	}
	frame, err := EncodeBinaryFrame(BinaryFrame{Kind: BinTermOutput, Channel: channel, Offset: offset, Payload: payload})
	if err != nil {
		return err
	}
	return sched.writeStream(ctx, websocket.MessageBinary, frame)
}

// PublishNotice sends a machine-level, lossy notice frame (PROTOCOL.md
// §9.5): no epoch or seq, never replayed.
func (l *Link) PublishNotice(scope map[string]string, event any) error {
	l.mu.Lock()
	ctx := l.connCtx
	l.mu.Unlock()
	if ctx == nil {
		return errors.New("link: not connected")
	}
	return l.writeFrame(ctx, map[string]any{"type": "notice", "scope": scope, "event": event})
}

func (l *Link) readFrame(ctx context.Context, v any) error {
	l.mu.Lock()
	conn := l.conn
	l.mu.Unlock()
	if conn == nil {
		return errors.New("link: not connected")
	}
	raw, err := l.readRaw(ctx, conn)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, v)
}

func (l *Link) readRaw(ctx context.Context, conn *websocket.Conn) ([]byte, error) {
	_, raw, err := conn.Read(ctx)
	return raw, err
}

func (l *Link) readTyped(ctx context.Context, conn *websocket.Conn) (websocket.MessageType, []byte, error) {
	return conn.Read(ctx)
}

// handleBinaryFrame decodes and routes one inbound binary frame
// (PROTOCOL.md §9.2): term.input and term.ack, both C→M. A malformed
// header or an unrecognized kind is dropped silently, per spec ("unknown
// kinds are ignored") — the same forward-compatibility rule unknown JSON
// frame types get.
func (l *Link) handleBinaryFrame(raw []byte) {
	frame, err := DecodeBinaryFrame(raw)
	if err != nil {
		return
	}
	if frame.Kind != BinTermInput && frame.Kind != BinTermAck {
		return
	}
	if l.cfg.Binary == nil {
		return
	}
	l.cfg.Binary.HandleBinary(frame.Kind, frame.Channel, frame.Offset, frame.Payload)
}
