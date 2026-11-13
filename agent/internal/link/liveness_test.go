package link

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func livenessLink(srvURL string, mut func(*Config)) *Link {
	cfg := Config{
		CereaOrigin:  srvURL,
		MachineID:    "m",
		MachineName:  "n",
		Cred:         &fakeCred{token: "t"},
		Hello:        func() Hello { return Hello{} },
		Handler:      &fakeHandler{calls: make(chan string, 4)},
		MinBackoff:   time.Hour, // a redial that waited out the backoff would fail the test
		MaxBackoff:   time.Hour,
		PingInterval: 200 * time.Millisecond,
		PingTimeout:  300 * time.Millisecond,
		TickInterval: 50 * time.Millisecond,
	}
	if mut != nil {
		mut(&cfg)
	}
	return New(cfg)
}

// silentServer welcomes, then stops reading: pings are never answered, as on a
// half-open or blackholed connection. Each accepted connection bumps conns.
func silentServer(t *testing.T, conns *atomic.Int32) string {
	srv := newFakeCereaServer(t, func(sc *serverConn, r *http.Request) {
		conns.Add(1)
		sc.readType("hello")
		sc.send(map[string]any{"type": "welcome", "deviceId": "d", "status": "paired"})
		<-r.Context().Done() // never read again
		time.Sleep(10 * time.Second)
	})
	return srv.URL
}

func TestDeadPeerIsRedialledImmediately(t *testing.T) {
	var conns atomic.Int32
	l := livenessLink(silentServer(t, &conns), nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go l.Run(ctx)

	waitFor(t, func() bool { return l.Connected() }, "first connect")
	waitFor(t, func() bool { return conns.Load() >= 2 }, "redial after unanswered pings")
}

func TestStatusDropsWhenPeerStopsAnswering(t *testing.T) {
	var conns atomic.Int32
	l := livenessLink(silentServer(t, &conns), func(c *Config) { c.PingInterval = 100 * time.Millisecond })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go l.Run(ctx)
	waitFor(t, func() bool { return l.Connected() }, "connect")
	waitFor(t, func() bool { return !l.Connected() || conns.Load() >= 2 }, "not connected after the drop")
}

func TestClockJumpPingsAtOnce(t *testing.T) {
	var conns atomic.Int32
	var offset atomic.Int64
	l := livenessLink(silentServer(t, &conns), func(c *Config) {
		c.PingInterval = time.Hour // only a wake may trigger the ping
		c.PingTimeout = 200 * time.Millisecond
		c.Now = func() time.Time { return time.Now().Add(time.Duration(offset.Load())) }
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go l.Run(ctx)
	waitFor(t, func() bool { return l.Connected() }, "connect")
	time.Sleep(400 * time.Millisecond)
	if conns.Load() != 1 {
		t.Fatalf("redialled without a jump: %d connections", conns.Load())
	}
	offset.Store(int64(10 * time.Minute)) // the Mac slept
	waitFor(t, func() bool { return conns.Load() >= 2 }, "redial after the clock jump")
}

// A healthy peer that answers pings is left alone.
func TestHealthyPeerIsNotRedialled(t *testing.T) {
	var conns atomic.Int32
	srv := newFakeCereaServer(t, func(sc *serverConn, r *http.Request) {
		conns.Add(1)
		sc.readType("hello")
		sc.send(map[string]any{"type": "welcome", "deviceId": "d", "status": "paired"})
		for {
			if _, _, err := sc.conn.Read(context.Background()); err != nil {
				return
			}
		}
	})
	l := livenessLink(srv.URL, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go l.Run(ctx)
	waitFor(t, func() bool { return l.Connected() }, "connect")
	time.Sleep(time.Second)
	if conns.Load() != 1 || !l.Connected() {
		t.Fatalf("healthy link was dropped: conns=%d connected=%v", conns.Load(), l.Connected())
	}
}
