package link

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// movingCred models the shim against an IdP that revokes the previous access
// token on every refresh (GitLab): the token changes when the shim refreshes
// on its own timer, and says so on Rotated.
type movingCred struct {
	mu     sync.Mutex
	n      int
	next   time.Time
	forced int
	rot    chan struct{}
}

func newMovingCred(next time.Time) *movingCred {
	return &movingCred{next: next, rot: make(chan struct{}, 1)}
}

func (c *movingCred) tokenLocked() string { return fmt.Sprintf("tok-%d", c.n) }

func (c *movingCred) Token(context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.tokenLocked(), nil
}

func (c *movingCred) ForceRefresh(context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.forced++
	c.n++
	c.next = time.Now().Add(time.Hour)
	c.signal()
	return c.tokenLocked(), nil
}

func (c *movingCred) NextRenewal() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.next
}

func (c *movingCred) Rotated() <-chan struct{} { return c.rot }

func (c *movingCred) signal() {
	select {
	case c.rot <- struct{}{}:
	default:
	}
}

// rotate is the shim's own timer refreshing behind the link's back: a new
// token, the 70% mark moved on, a signal.
func (c *movingCred) rotate() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n++
	c.next = time.Now().Add(time.Hour)
	c.signal()
	return c.tokenLocked()
}

func (c *movingCred) forcedCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.forced
}

// plainCred is a Credential that is not a Rotator: the link cannot be told
// that the token changed, only ask for it.
type plainCred struct{ c *movingCred }

func (p plainCred) Token(ctx context.Context) (string, error)        { return p.c.Token(ctx) }
func (p plainCred) ForceRefresh(ctx context.Context) (string, error) { return p.c.ForceRefresh(ctx) }
func (p plainCred) NextRenewal() time.Time                           { return p.c.NextRenewal() }

func newTestLink(srvURL string, cred Credential, mut func(*Config)) *Link {
	cfg := Config{
		CereaOrigin: srvURL,
		MachineID:   "machine-1",
		MachineName: "box",
		Cred:        cred,
		Hello:       func() Hello { return Hello{} },
		Handler:     &fakeHandler{calls: make(chan string, 16)},
	}
	if mut != nil {
		mut(&cfg)
	}
	return New(cfg)
}

func runLink(t *testing.T, l *Link) (stop func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = l.Run(ctx); close(done) }()
	stopped := false
	stop = func() {
		if !stopped {
			stopped = true
			cancel()
			<-done
		}
	}
	t.Cleanup(stop)
	return stop
}

func waitUntil(t *testing.T, what string, within time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out after %s waiting for %s", within, what)
}

func decode(raw []byte) map[string]any {
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return m
}

// authDrain reads a live connection, forwarding each auth frame's token.
func authDrain(sc *serverConn, auths chan<- string) {
	for {
		_, raw, err := sc.conn.Read(context.Background())
		if err != nil {
			return
		}
		if m := decode(raw); m["type"] == "auth" {
			auths <- fmt.Sprint(m["token"])
		}
	}
}

// A refresh the shim makes on its own (its 15 minute timer, a request that
// found the token near expiry) is handed to Cerea over the open link at once.
// This is the bug: against GitLab the old token stops working at the refresh,
// and Cerea, still holding it, closed the link with 4401 at its next check.
func TestRotationBehindTheLinksBackIsHandedOverOnTheOpenLink(t *testing.T) {
	cred := newMovingCred(time.Now().Add(time.Hour))
	auths := make(chan string, 8)
	srv := newFakeCereaServer(t, func(sc *serverConn, r *http.Request) {
		sc.readType("hello")
		sc.send(map[string]any{"type": "welcome", "deviceId": "d", "status": "paired"})
		authDrain(sc, auths)
	})
	runLink(t, newTestLink(srv.URL, cred, nil))
	time.Sleep(100 * time.Millisecond)

	want := cred.rotate()
	select {
	case got := <-auths:
		if got != want {
			t.Fatalf("auth token = %q, want the rotated %q", got, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the rotated token was not handed over")
	}
	if n := cred.forcedCount(); n != 0 {
		t.Errorf("ForceRefresh calls = %d: handing a token over must not rotate it again", n)
	}
	// A second rotation is handed over too, and nothing else is pushed.
	want = cred.rotate()
	if got := <-auths; got != want {
		t.Fatalf("second auth token = %q, want %q", got, want)
	}
	select {
	case extra := <-auths:
		t.Fatalf("unexpected extra auth frame %q", extra)
	case <-time.After(300 * time.Millisecond):
	}
}

// A signal for the token Cerea already has pushes nothing: the renewal's own
// rotation signals too, and must not be sent twice.
func TestRotationSignalForTheHeldTokenPushesNothing(t *testing.T) {
	cred := newMovingCred(time.Now().Add(time.Hour))
	auths := make(chan string, 8)
	srv := newFakeCereaServer(t, func(sc *serverConn, r *http.Request) {
		sc.readType("hello")
		sc.send(map[string]any{"type": "welcome", "deviceId": "d", "status": "paired"})
		authDrain(sc, auths)
	})
	runLink(t, newTestLink(srv.URL, cred, nil))
	time.Sleep(100 * time.Millisecond)
	cred.signal() // the token is still tok-0, the one dialled with
	select {
	case got := <-auths:
		t.Fatalf("pushed %q for a token Cerea already holds", got)
	case <-time.After(300 * time.Millisecond):
	}
}

// The wait for the 70% mark follows a token that rotated meanwhile: with the
// mark 300 ms away at dial and a rotation that moves it to an hour away, no
// second rotation (ForceRefresh) happens at 300 ms.
func TestRenewalMarkFollowsARotation(t *testing.T) {
	cred := newMovingCred(time.Now().Add(300 * time.Millisecond))
	auths := make(chan string, 8)
	srv := newFakeCereaServer(t, func(sc *serverConn, r *http.Request) {
		sc.readType("hello")
		sc.send(map[string]any{"type": "welcome", "deviceId": "d", "status": "paired"})
		authDrain(sc, auths)
	})
	runLink(t, newTestLink(srv.URL, cred, nil))
	time.Sleep(100 * time.Millisecond)
	cred.rotate()
	<-auths
	time.Sleep(500 * time.Millisecond) // past the old mark
	if n := cred.forcedCount(); n != 0 {
		t.Fatalf("ForceRefresh ran %d time(s) at the old mark of a token that had already been replaced", n)
	}
}

// A Credential that is not a Rotator keeps the 70% renewal only.
func TestCredentialWithoutRotatedStillRenewsAtTheMark(t *testing.T) {
	cred := plainCred{newMovingCred(time.Now().Add(100 * time.Millisecond))}
	auths := make(chan string, 8)
	srv := newFakeCereaServer(t, func(sc *serverConn, r *http.Request) {
		sc.readType("hello")
		sc.send(map[string]any{"type": "welcome", "deviceId": "d", "status": "paired"})
		authDrain(sc, auths)
	})
	runLink(t, newTestLink(srv.URL, cred, nil))
	select {
	case got := <-auths:
		if got != "tok-1" {
			t.Fatalf("renewal token = %q, want tok-1", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no renewal at the mark")
	}
}

// connLog records when each connection to a test server started.
type connLog struct {
	mu     sync.Mutex
	starts []time.Time
}

func (c *connLog) add() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.starts = append(c.starts, time.Now())
	return len(c.starts)
}

func (c *connLog) all() []time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]time.Time(nil), c.starts...)
}

// After a 4401 with a newer token already in the credential (a refresh the
// link was not told about), the link dials again at once, with no backoff and
// no second rotation: at an IdP like GitLab every rotation revokes the
// previous token.
func TestAfter4401WithANewerTokenRedialsAtOnce(t *testing.T) {
	mc := newMovingCred(time.Now().Add(time.Hour))
	cred := plainCred{mc}
	log := &connLog{}
	srv := newFakeCereaServer(t, func(sc *serverConn, r *http.Request) {
		sc.readType("hello")
		n := log.add()
		sc.send(map[string]any{"type": "welcome", "deviceId": "d", "status": "paired"})
		if n == 1 {
			mc.rotate() // the refresh that revoked the token this connection holds
			time.Sleep(50 * time.Millisecond)
			_ = sc.conn.Close(4401, "token no longer valid; renew and reconnect")
			return
		}
		for {
			if _, _, err := sc.conn.Read(context.Background()); err != nil {
				return
			}
		}
	})
	l := newTestLink(srv.URL, cred, func(c *Config) { c.MinBackoff = 10 * time.Second; c.MaxBackoff = 30 * time.Second })
	runLink(t, l)
	waitUntil(t, "the second connection", 3*time.Second, func() bool { return len(log.all()) >= 2 })
	starts := log.all()
	if gap := starts[1].Sub(starts[0]); gap > 2*time.Second {
		t.Fatalf("redialled after %s, want at once (the backoff is 10s)", gap)
	}
	if n := mc.forcedCount(); n != 0 {
		t.Errorf("ForceRefresh calls = %d, want 0: a newer token was already there", n)
	}
}

// A 4401 with nothing newer in the credential (also: Cerea refused the token
// the link had just handed over) rotates it once, then redials at once.
func TestAfter4401RotatesOnceAndRedialsAtOnce(t *testing.T) {
	cred := newMovingCred(time.Now().Add(time.Hour))
	log := &connLog{}
	srv := newFakeCereaServer(t, func(sc *serverConn, r *http.Request) {
		sc.readType("hello")
		n := log.add()
		sc.send(map[string]any{"type": "welcome", "deviceId": "d", "status": "paired"})
		if n == 1 {
			time.Sleep(50 * time.Millisecond)
			_ = sc.conn.Close(4401, "token expired and was not renewed")
			return
		}
		for {
			if _, _, err := sc.conn.Read(context.Background()); err != nil {
				return
			}
		}
	})
	runLink(t, newTestLink(srv.URL, cred, func(c *Config) { c.MinBackoff = 10 * time.Second }))
	waitUntil(t, "the second connection", 3*time.Second, func() bool { return len(log.all()) >= 2 })
	if n := cred.forcedCount(); n != 1 {
		t.Errorf("ForceRefresh calls = %d, want exactly 1", n)
	}
	starts := log.all()
	if gap := starts[1].Sub(starts[0]); gap > 2*time.Second {
		t.Fatalf("redialled after %s, want at once", gap)
	}
}

// A fresh token that Cerea keeps refusing is a real failure: after
// maxQuickRedials back-to-back redials the ordinary backoff applies.
func TestRepeated4401GoesThroughTheBackoffAfterAFewQuickRedials(t *testing.T) {
	cred := newMovingCred(time.Now().Add(time.Hour))
	log := &connLog{}
	srv := newFakeCereaServer(t, func(sc *serverConn, r *http.Request) {
		sc.readType("hello")
		log.add()
		sc.send(map[string]any{"type": "welcome", "deviceId": "d", "status": "paired"})
		_ = sc.conn.Close(4401, "token no longer valid")
	})
	runLink(t, newTestLink(srv.URL, cred, func(c *Config) {
		c.MinBackoff = 600 * time.Millisecond
		c.MaxBackoff = 600 * time.Millisecond
	}))
	waitUntil(t, "the quick redials", 3*time.Second, func() bool { return len(log.all()) >= 1+maxQuickRedials })
	time.Sleep(200 * time.Millisecond) // well inside the 600 ms ±20% backoff
	if n := len(log.all()); n != 1+maxQuickRedials {
		t.Fatalf("%d connections soon after the first, want %d (the first and %d quick redials), then a wait", n, 1+maxQuickRedials, maxQuickRedials)
	}
	waitUntil(t, "a dial after the backoff", 3*time.Second, func() bool { return len(log.all()) > 1+maxQuickRedials })
	starts := log.all()
	if gap := starts[1+maxQuickRedials].Sub(starts[maxQuickRedials]); gap < 450*time.Millisecond {
		t.Fatalf("the dial after the quick ones came %s later, want about the 600ms backoff", gap)
	}
}

// A connection that stayed up resets the backoff: the failures before it must
// not make every later drop cost the maximum wait (it used to: a link that
// dropped once an hour waited 30 s each time).
func TestBackoffResetsAfterAHealthyConnection(t *testing.T) {
	cred := newMovingCred(time.Now().Add(time.Hour))
	log := &connLog{}
	srv := newFakeCereaServer(t, func(sc *serverConn, r *http.Request) {
		sc.readType("hello")
		log.add()
		sc.send(map[string]any{"type": "welcome", "deviceId": "d", "status": "paired"})
		time.Sleep(150 * time.Millisecond) // up for longer than HealthyAfter
		_ = sc.conn.Close(websocket.StatusInternalError, "restarting")
	})
	runLink(t, newTestLink(srv.URL, cred, func(c *Config) {
		c.MinBackoff = 100 * time.Millisecond
		c.MaxBackoff = 10 * time.Second
		c.HealthyAfter = 50 * time.Millisecond
	}))
	waitUntil(t, "five connections", 6*time.Second, func() bool { return len(log.all()) >= 5 })
	starts := log.all()
	// Without the reset the waits are 100, 200, 400, 800 ms: the last gap would be ~950 ms.
	for i := 1; i < 5; i++ {
		if gap := starts[i].Sub(starts[i-1]); gap > 450*time.Millisecond {
			t.Fatalf("gap %d = %s: the backoff was not reset by a healthy connection", i, gap)
		}
	}
}

// A short-lived connection does not reset it.
func TestBackoffKeepsGrowingWhileConnectionsDoNotLast(t *testing.T) {
	cred := newMovingCred(time.Now().Add(time.Hour))
	log := &connLog{}
	srv := newFakeCereaServer(t, func(sc *serverConn, r *http.Request) {
		sc.readType("hello")
		log.add()
		sc.send(map[string]any{"type": "welcome", "deviceId": "d", "status": "paired"})
		_ = sc.conn.Close(websocket.StatusInternalError, "going away")
	})
	runLink(t, newTestLink(srv.URL, cred, func(c *Config) {
		c.MinBackoff = 100 * time.Millisecond
		c.MaxBackoff = 10 * time.Second
		c.HealthyAfter = time.Minute
	}))
	waitUntil(t, "four connections", 6*time.Second, func() bool { return len(log.all()) >= 4 })
	starts := log.all()
	if gap := starts[3].Sub(starts[2]); gap < 250*time.Millisecond {
		t.Fatalf("third gap = %s, want it to have doubled to ~400ms", gap)
	}
}

// A request that arrives before the welcome (Cerea's connection listeners
// used to run first) is not an error: it is answered once the machine is
// paired, like any other.
func TestRequestBeforeTheWelcomeIsAnsweredAfterIt(t *testing.T) {
	cred := newMovingCred(time.Now().Add(time.Hour))
	handler := &fakeHandler{calls: make(chan string, 4)}
	res := make(chan map[string]any, 1)
	srv := newFakeCereaServer(t, func(sc *serverConn, r *http.Request) {
		sc.readType("hello")
		sc.send(map[string]any{"type": "req", "id": "r1", "op": "session.list", "args": map[string]any{}})
		sc.send(map[string]any{"type": "welcome", "deviceId": "d", "status": "paired"})
		res <- sc.readType("res")
		for {
			if _, _, err := sc.conn.Read(context.Background()); err != nil {
				return
			}
		}
	})
	logs := &syncLog{}
	runLink(t, newTestLink(srv.URL, cred, func(c *Config) {
		c.Handler = handler
		c.Logf = logs.logf
	}))
	select {
	case got := <-res:
		if got["id"] != "r1" || got["ok"] != true {
			t.Fatalf("res = %v, want ok for r1", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the request sent before the welcome was never answered")
	}
	if strings.Contains(logs.text(), "expected welcome") {
		t.Fatalf("the early request was treated as a handshake error:\n%s", logs.text())
	}
}

// A pending machine's early request is refused the ordinary way (not paired
// yet), still not a handshake error.
func TestEarlyRequestOnAPendingMachineIsRefusedNotFatal(t *testing.T) {
	cred := newMovingCred(time.Now().Add(time.Hour))
	res := make(chan map[string]any, 1)
	srv := newFakeCereaServer(t, func(sc *serverConn, r *http.Request) {
		sc.readType("hello")
		sc.send(map[string]any{"type": "status", "status": "noise"})
		sc.send(map[string]any{"type": "req", "id": "r1", "op": "session.list", "args": map[string]any{}})
		sc.send(map[string]any{"type": "welcome", "deviceId": "d", "status": "pending"})
		res <- sc.readType("res")
		for {
			if _, _, err := sc.conn.Read(context.Background()); err != nil {
				return
			}
		}
	})
	runLink(t, newTestLink(srv.URL, cred, nil))
	select {
	case got := <-res:
		errObj, _ := got["error"].(map[string]any)
		if got["ok"] != false || errObj["code"] != "forbidden" {
			t.Fatalf("res = %v, want forbidden", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no answer")
	}
}

// A server that never welcomes still ends the connection, with the old message.
func TestTooManyFramesBeforeTheWelcomeIsAnError(t *testing.T) {
	cred := newMovingCred(time.Now().Add(time.Hour))
	srv := newFakeCereaServer(t, func(sc *serverConn, r *http.Request) {
		sc.readType("hello")
		for i := 0; i <= maxEarlyFrames; i++ {
			sc.send(map[string]any{"type": "req", "id": fmt.Sprint(i), "op": "session.list", "args": map[string]any{}})
		}
		time.Sleep(time.Second)
	})
	l := newTestLink(srv.URL, cred, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := l.runOnce(ctx)
	if err == nil || !strings.Contains(err.Error(), `expected welcome, got "req"`) {
		t.Fatalf("runOnce = %v, want the expected-welcome error", err)
	}
}

type syncLog struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncLog) logf(format string, args ...any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fmt.Fprintf(&s.b, format+"\n", args...)
}

func (s *syncLog) text() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}
