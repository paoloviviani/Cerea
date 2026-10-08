package link

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// startCallLink runs a Link against a fake Cerea whose script is drive, and
// waits until the link is paired (or, with paired false, connected).
func startCallLink(t *testing.T, welcome map[string]any, drive func(*serverConn)) *Link {
	t.Helper()
	srv := newFakeCereaServer(t, func(sc *serverConn, _ *http.Request) {
		sc.readType("hello")
		sc.send(welcome)
		drive(sc)
	})
	l := New(Config{
		CereaOrigin: srv.URL, MachineID: "m", MachineName: "n", Cred: &fakeCred{token: "t"},
		Hello:       func() Hello { return Hello{} },
		Handler:     &fakeHandler{calls: make(chan string, 4)},
		CallTimeout: 300 * time.Millisecond,
		MinBackoff:  time.Hour, // one connection per test
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = l.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	deadline := time.Now().Add(3 * time.Second)
	for {
		l.mu.Lock()
		up := l.sched != nil && (l.paired || welcome["status"] != "paired")
		l.mu.Unlock()
		if up {
			return l
		}
		if time.Now().After(deadline) {
			t.Fatal("link never came up")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

var pairedWelcome = map[string]any{
	"type": "welcome", "deviceId": "d", "status": "paired",
	"features": map[string]any{"machineCalls": []string{"schedule"}},
}

func TestCallRoundTripAndFeatures(t *testing.T) {
	got := make(chan map[string]any, 1)
	l := startCallLink(t, pairedWelcome, func(sc *serverConn) {
		call := sc.readType("call")
		got <- call
		// An answer to an id nobody waits for is dropped, not misdelivered.
		sc.send(map[string]any{"type": "callres", "id": "nobody", "ok": true, "result": map[string]any{"wrong": true}})
		sc.send(map[string]any{"type": "callres", "id": call["id"], "ok": true, "result": map[string]any{"enabled": true}})
		_, _, _ = sc.conn.Read(context.Background())
	})
	if !l.Supports("schedule") || l.Supports("other") {
		t.Fatalf("Supports: schedule=%v other=%v", l.Supports("schedule"), l.Supports("other"))
	}
	res, err := l.Call(context.Background(), Call{
		Op: "schedule.context", SessionID: "s1", RootSessionID: "r1",
		Caller: map[string]any{"workspaceId": "w"},
	})
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if string(res) != `{"enabled":true}` {
		t.Fatalf("result = %s", res)
	}
	call := <-got
	if call["op"] != "schedule.context" || call["sessionId"] != "s1" || call["rootSessionId"] != "r1" || call["id"] == "" {
		t.Fatalf("frame = %v", call)
	}
	if args, ok := call["args"].(map[string]any); !ok || len(args) != 0 {
		t.Fatalf("args = %v, want {}", call["args"])
	}
}

func TestCallIDsAreUniqueAndErrorsCarryTheirCode(t *testing.T) {
	ids := make(chan string, 2)
	l := startCallLink(t, pairedWelcome, func(sc *serverConn) {
		for i := 0; i < 2; i++ {
			call := sc.readType("call")
			ids <- call["id"].(string)
			sc.send(map[string]any{"type": "callres", "id": call["id"], "ok": false,
				"error": map[string]any{"code": "forbidden", "message": "no looser than ask"}})
		}
		_, _, _ = sc.conn.Read(context.Background())
	})
	for i := 0; i < 2; i++ {
		_, err := l.Call(context.Background(), Call{Op: "schedule.create"})
		if err == nil || err.Code != "forbidden" || err.Message != "no looser than ask" {
			t.Fatalf("err = %#v", err)
		}
	}
	if a, b := <-ids, <-ids; a == b {
		t.Fatalf("two calls shared id %q", a)
	}
}

func TestCallTimesOutUnavailable(t *testing.T) {
	// A Cerea that predates calls: reads the frame and never answers.
	l := startCallLink(t, map[string]any{"type": "welcome", "deviceId": "d", "status": "paired"}, func(sc *serverConn) {
		sc.readType("call")
		_, _, _ = sc.conn.Read(context.Background())
	})
	if l.Supports("schedule") {
		t.Fatal("a welcome without features must not advertise schedule calls")
	}
	start := time.Now()
	_, err := l.Call(context.Background(), Call{Op: "schedule.list"})
	if err == nil || err.Code != "unavailable" {
		t.Fatalf("err = %#v, want unavailable", err)
	}
	if time.Since(start) < 250*time.Millisecond {
		t.Fatalf("returned after %s, before the timeout", time.Since(start))
	}
	l.mu.Lock()
	n := len(l.pending)
	l.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d calls still pending after a timeout", n)
	}
}

func TestCallFailsOnDisconnect(t *testing.T) {
	l := startCallLink(t, pairedWelcome, func(sc *serverConn) {
		sc.readType("call")
		sc.conn.Close(websocket.StatusGoingAway, "bye")
	})
	l.cfg.CallTimeout = 5 * time.Second
	start := time.Now()
	_, err := l.Call(context.Background(), Call{Op: "schedule.list"})
	if err == nil || err.Code != "unavailable" || !strings.Contains(err.Message, "dropped") {
		t.Fatalf("err = %#v, want unavailable (dropped)", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("a disconnect must end the call, not the timeout")
	}
	if l.Supports("schedule") {
		t.Fatal("features must be forgotten with the connection")
	}
	// And with no connection, a call is refused at once.
	if _, err := l.Call(context.Background(), Call{Op: "schedule.list"}); err == nil || err.Code != "unavailable" {
		t.Fatalf("disconnected call: %#v", err)
	}
}

func TestCallRefusedWhileUnpaired(t *testing.T) {
	l := startCallLink(t, map[string]any{"type": "welcome", "deviceId": "d", "status": "pending",
		"features": map[string]any{"machineCalls": []string{"schedule"}}}, func(sc *serverConn) {
		_, raw, err := sc.conn.Read(context.Background())
		if err == nil {
			t.Errorf("an unpaired link sent a frame: %s", raw)
		}
	})
	_, err := l.Call(context.Background(), Call{Op: "schedule.list"})
	if err == nil || err.Code != "unavailable" || !strings.Contains(err.Message, "not paired") {
		t.Fatalf("err = %#v", err)
	}
}
