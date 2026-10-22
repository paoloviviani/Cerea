package link

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"galopin/internal/protofix"
)

// The link's side of the shared wire fixtures (agent/protocol-fixtures): the
// frames this package assembles must equal the fixtures, and the frames it
// reads must decode from them, through the real Link over a real WebSocket.

type fixtureServer struct {
	t      *testing.T
	in     chan []byte // frames the link sent
	out    chan []byte // frames to send to the link
	closed chan struct{}
}

func (s *fixtureServer) recv() []byte {
	s.t.Helper()
	select {
	case raw := <-s.in:
		return raw
	case <-time.After(3 * time.Second):
		s.t.Fatal("the link sent nothing")
		return nil
	}
}

func (s *fixtureServer) send(raw []byte) {
	s.t.Helper()
	s.out <- raw
}

func fixtureHelloFrom(t *testing.T, f protofix.Fixture) Hello {
	t.Helper()
	var h Hello
	if err := protofix.DecodeStrict(protofix.Strip(f.Frame, "type", "protocol", "credential"), &h); err != nil {
		t.Fatalf("%s does not decode into Hello: %v", f.File, err)
	}
	return h
}

func idOf(t *testing.T, raw []byte) string {
	t.Helper()
	var h struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &h); err != nil {
		t.Fatal(err)
	}
	return h.ID
}

// withID rewrites a frame's id.
func withID(t *testing.T, raw []byte, id string) []byte {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	m["id"] = id
	out, _ := json.Marshal(m)
	return out
}

type fixtureHandler struct {
	t      *testing.T
	byOp   map[string]json.RawMessage // op -> the res fixture's result
	errs   map[string]*OpError        // "err:<code>" -> the error fixture's error
	gotOps chan struct {
		op   string
		args json.RawMessage
	}
}

func (h *fixtureHandler) Handle(_ context.Context, op string, args json.RawMessage) (any, *OpError) {
	h.gotOps <- struct {
		op   string
		args json.RawMessage
	}{op, args}
	if e, ok := h.errs[op]; ok {
		return nil, e
	}
	if r, ok := h.byOp[op]; ok {
		return r, nil
	}
	return nil, &OpError{Code: "unsupported", Message: "no fixture for " + op}
}

type renewingCred struct{ token string }

func (c *renewingCred) Token(context.Context) (string, error)        { return c.token, nil }
func (c *renewingCred) ForceRefresh(context.Context) (string, error) { return c.token, nil }
func (c *renewingCred) NextRenewal() time.Time                       { return time.Now() }

func TestProtocolFixturesThroughTheLink(t *testing.T) {
	fixtures := protofix.Load(t)
	by := func(file string) protofix.Fixture {
		for _, f := range fixtures {
			if f.File == file {
				return f
			}
		}
		t.Fatalf("missing fixture %s", file)
		return protofix.Fixture{}
	}

	handler := &fixtureHandler{
		t: t, byOp: map[string]json.RawMessage{}, errs: map[string]*OpError{},
		gotOps: make(chan struct {
			op   string
			args json.RawMessage
		}, 256),
	}
	for _, f := range fixtures {
		h := f.Head(t)
		switch {
		case h.Type == "res" && h.OK != nil && *h.OK && f.Meta.Variant == "":
			handler.byOp[f.Meta.Op] = protofix.Field(f.Frame, "result")
		case h.Type == "res" && h.OK != nil && !*h.OK:
			var e struct {
				Error struct{ Code, Message string } `json:"error"`
			}
			if err := json.Unmarshal(f.Frame, &e); err != nil {
				t.Fatal(err)
			}
			handler.errs["err:"+e.Error.Code] = &OpError{Code: e.Error.Code, Message: e.Error.Message}
		}
	}

	srv := &fixtureServer{t: t, in: make(chan []byte, 256), out: make(chan []byte, 256), closed: make(chan struct{})}
	httpSrv := newFakeCereaServer(t, func(sc *serverConn, _ *http.Request) {
		go func() {
			for {
				_, raw, err := sc.conn.Read(context.Background())
				if err != nil {
					close(srv.closed)
					return
				}
				srv.in <- raw
			}
		}()
		for {
			select {
			case raw := <-srv.out:
				if err := sc.conn.Write(context.Background(), websocket.MessageText, raw); err != nil {
					return
				}
			case <-srv.closed:
				return
			}
		}
	})

	srv.send(by("frames/welcome.json").Frame)
	l := New(Config{
		CereaOrigin: httpSrv.URL, MachineID: "m", MachineName: "n", Cred: &renewingCred{token: "eyJhbGciOi.renewed.token"},
		Hello:       func() Hello { return fixtureHelloFrom(t, by("frames/hello.json")) },
		Handler:     handler,
		CallTimeout: 3 * time.Second,
		MinBackoff:  time.Hour,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = l.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	// hello: the link's own assembly of the frame equals the fixture; the auth
	// renewal can interleave, so frames are matched by type.
	pending := [][]byte{}
	next := func(want string) []byte {
		t.Helper()
		for i, raw := range pending {
			var h struct{ Type string }
			_ = json.Unmarshal(raw, &h)
			if h.Type == want {
				pending = append(pending[:i], pending[i+1:]...)
				return raw
			}
		}
		for {
			raw := srv.recv()
			var h struct{ Type string }
			_ = json.Unmarshal(raw, &h)
			if h.Type == want {
				return raw
			}
			pending = append(pending, raw)
		}
	}
	if err := protofix.Same(by("frames/hello.json").Frame, next("hello")); err != nil {
		t.Errorf("hello frame: %v", err)
	}

	// welcome (paired, with features): the link pairs and lists the call families.
	waitFor(t, func() bool { return l.Paired() && l.Supports("schedule") }, "paired welcome with features")

	// auth renewal frame.
	if err := protofix.Same(by("frames/auth.json").Frame, next("auth")); err != nil {
		t.Errorf("auth frame: %v", err)
	}

	// credential frames.
	for _, name := range []string{"frames/credential.json", "frames/credential.expired.json"} {
		var c struct{ State, Detail string }
		_ = json.Unmarshal(by(name).Frame, &c)
		if err := l.PublishCredentialState(c.State, c.Detail); err != nil {
			t.Fatal(err)
		}
		if err := protofix.Same(by(name).Frame, next("credential")); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}

	// notice frames.
	for _, f := range fixtures {
		if f.Head(t).Type != "notice" {
			continue
		}
		var n struct {
			Scope map[string]string `json:"scope"`
			Event json.RawMessage   `json:"event"`
		}
		if err := json.Unmarshal(f.Frame, &n); err != nil {
			t.Fatal(err)
		}
		if err := l.PublishNotice(n.Scope, n.Event); err != nil {
			t.Fatal(err)
		}
		if err := protofix.Same(f.Frame, next("notice")); err != nil {
			t.Errorf("%s: %v", f.File, err)
		}
	}

	// event frames: the envelope the link assembles around an event.
	for _, f := range fixtures {
		if f.Head(t).Type != "event" {
			continue
		}
		var e struct {
			SessionID     string          `json:"sessionId"`
			Epoch         string          `json:"epoch"`
			Seq           int64           `json:"seq"`
			RootSessionID string          `json:"rootSessionId"`
			Event         json.RawMessage `json:"event"`
		}
		if err := protofix.DecodeStrict(protofix.Strip(f.Frame, "type"), &e); err != nil {
			t.Fatalf("%s: %v", f.File, err)
		}
		if err := l.PublishEvent(e.SessionID, e.Epoch, e.Seq, e.RootSessionID, e.Event); err != nil {
			t.Fatal(err)
		}
		if err := protofix.Same(f.Frame, next("event")); err != nil {
			t.Errorf("%s: %v", f.File, err)
		}
	}

	// req frames in: the handler sees the fixture's op and args, and the res the
	// link writes equals the fixture's res frame.
	for _, f := range fixtures {
		if f.Head(t).Type != "req" || f.Meta.Variant != "" {
			continue
		}
		srv.send(f.Frame)
		got := <-handler.gotOps
		var want struct {
			Op   string          `json:"op"`
			Args json.RawMessage `json:"args"`
		}
		_ = json.Unmarshal(f.Frame, &want)
		if got.op != want.Op {
			t.Errorf("%s: handler saw op %q", f.File, got.op)
		}
		if err := protofix.Same(want.Args, got.args); err != nil {
			t.Errorf("%s: args differ: %v", f.File, err)
		}
		res := next("res")
		if err := protofix.Same(by("ops/"+want.Op+".res.json").Frame, res); err != nil {
			t.Errorf("res for %s: %v", want.Op, err)
		}
	}

	// error frames out: one per code the handler is made to refuse with.
	for _, f := range fixtures {
		if f.Meta.ErrorCode == "" || f.Head(t).Type != "res" {
			continue
		}
		srv.send([]byte(fmt.Sprintf(`{"type":"req","id":"r1","op":"err:%s","args":{}}`, f.Meta.ErrorCode)))
		<-handler.gotOps
		if err := protofix.Same(f.Frame, next("res")); err != nil {
			t.Errorf("%s: %v", f.File, err)
		}
	}

	// machine calls: the call frame the link writes equals the fixture (the id
	// aside), and the callres fixtures decode into the result or the error.
	for _, f := range fixtures {
		if f.Head(t).Type != "call" {
			continue
		}
		var c struct {
			Op            string          `json:"op"`
			SessionID     string          `json:"sessionId"`
			RootSessionID string          `json:"rootSessionId"`
			Caller        json.RawMessage `json:"caller"`
			Args          json.RawMessage `json:"args"`
		}
		if err := protofix.DecodeStrict(protofix.Strip(f.Frame, "type", "id"), &c); err != nil {
			t.Fatalf("%s: %v", f.File, err)
		}
		var caller, args any
		_ = json.Unmarshal(c.Caller, &caller)
		_ = json.Unmarshal(c.Args, &args)
		type outcome struct {
			res json.RawMessage
			err *OpError
		}
		result := make(chan outcome, 1)
		go func() {
			res, err := l.Call(context.Background(), Call{Op: c.Op, SessionID: c.SessionID, RootSessionID: c.RootSessionID, Caller: caller, Args: args})
			result <- outcome{res, err}
		}()
		raw := next("call")
		id := idOf(t, raw)
		if err := protofix.Same(withID(t, f.Frame, id), raw); err != nil {
			t.Errorf("%s: %v", f.File, err)
		}
		// Every callres fixture of this op answers it.
		for _, g := range fixtures {
			gh := g.Head(t)
			if gh.Type != "callres" || g.Meta.Op != c.Op {
				continue
			}
			if f.Meta.Variant != "" && g.Meta.Variant != "" {
				continue
			}
			srv.send(withID(t, g.Frame, id))
			o := <-result
			if o.err != nil {
				t.Errorf("%s answered with an error: %+v", g.File, o.err)
			}
			if err := protofix.Same(protofix.Field(g.Frame, "result"), o.res); err != nil {
				t.Errorf("%s: %v", g.File, err)
			}
			break
		}
	}
	for _, f := range fixtures {
		if f.Head(t).Type != "callres" || f.Meta.ErrorCode == "" {
			continue
		}
		result := make(chan *OpError, 1)
		go func() {
			_, err := l.Call(context.Background(), Call{Op: "schedule.list", SessionID: "s", RootSessionID: "s", Caller: map[string]any{}})
			result <- err
		}()
		id := idOf(t, next("call"))
		srv.send(withID(t, f.Frame, id))
		err := <-result
		if err == nil || err.Code != f.Meta.ErrorCode || !strings.Contains(err.Message, f.Meta.ErrorCode) {
			t.Errorf("%s decoded as %+v", f.File, err)
		}
	}
}

func waitFor(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// The welcome and status fixtures, one connection each: a pending welcome
// leaves the link unpaired and without call families until status arrives.
func TestWelcomeAndStatusFixtures(t *testing.T) {
	var welcomes []protofix.Fixture
	var status protofix.Fixture
	for _, f := range protofix.Load(t) {
		switch f.Head(t).Type {
		case "welcome":
			welcomes = append(welcomes, f)
		case "status":
			status = f
		}
	}
	for _, w := range welcomes {
		var want struct {
			Status   string `json:"status"`
			Features *struct {
				MachineCalls []string `json:"machineCalls"`
			} `json:"features"`
		}
		if err := json.Unmarshal(w.Frame, &want); err != nil {
			t.Fatal(err)
		}
		t.Run(w.File, func(t *testing.T) {
			srv := newFakeCereaServer(t, func(sc *serverConn, _ *http.Request) {
				sc.readType("hello")
				sc.send(json.RawMessage(w.Frame))
				_, _, _ = sc.conn.Read(context.Background())
			})
			l := New(Config{
				CereaOrigin: srv.URL, MachineID: "m", MachineName: "n", Cred: &fakeCred{token: "t"},
				Hello:   func() Hello { return Hello{} },
				Handler: &fakeHandler{calls: make(chan string, 1)}, MinBackoff: time.Hour,
			})
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() { _ = l.Run(ctx); close(done) }()
			defer func() { cancel(); <-done }()
			wantPaired := want.Status == "paired"
			waitFor(t, func() bool {
				l.mu.Lock()
				defer l.mu.Unlock()
				return l.sched != nil && l.paired == wantPaired && len(l.machineCalls) == lenFeatures(want.Features)
			}, "welcome decoded")
			if want.Features != nil {
				for _, fam := range want.Features.MachineCalls {
					if !l.Supports(fam) {
						t.Errorf("family %q not supported after the welcome", fam)
					}
				}
			}
		})
	}
	// status paired after a pending welcome.
	srv := newFakeCereaServer(t, func(sc *serverConn, _ *http.Request) {
		sc.readType("hello")
		sc.send(map[string]any{"type": "welcome", "deviceId": "d", "status": "pending"})
		sc.send(json.RawMessage(status.Frame))
		_, _, _ = sc.conn.Read(context.Background())
	})
	l := New(Config{
		CereaOrigin: srv.URL, MachineID: "m", MachineName: "n", Cred: &fakeCred{token: "t"},
		Hello:   func() Hello { return Hello{} },
		Handler: &fakeHandler{calls: make(chan string, 1)}, MinBackoff: time.Hour,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = l.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	waitFor(t, l.Paired, "status fixture pairs the link")
}

func lenFeatures(f *struct {
	MachineCalls []string `json:"machineCalls"`
}) int {
	if f == nil {
		return 0
	}
	return len(f.MachineCalls)
}
