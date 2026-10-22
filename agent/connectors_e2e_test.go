package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"galopin/internal/link"
	"galopin/internal/mcpfake"
	"galopin/internal/policy"
)

// The fake stdio MCP server is this test binary re-executed (internal/mcpfake).
func init() {
	if mcpfake.Enabled() {
		mcpfake.Run()
		os.Exit(0)
	}
}

func connectorsConfig(t *testing.T) string {
	t.Helper()
	entry := func(mode, extra string) string {
		return fmt.Sprintf(`{"command": %q, "env": {"MCPFAKE_SERVER": "1", "MCPFAKE_MODE": %q, "FAKE_VALUE": "${GALOPIN_TEST_FAKE:-dflt}"}%s}`, os.Args[0], mode, extra)
	}
	return `{"mcpServers": {
	  "notes": ` + entry("", `, "description": "My notes", "allowedTools": ["read_file", "boom"]`) + `,
	  "crashy": ` + entry("crash", "") + `,
	  "napper": ` + entry("", "") + `
	}}`
}

// connectorsRig is a connectors-only machine (run --backend none) linked to a
// scripted Cerea.
type connectorsRig struct {
	t      *testing.T
	mc     *machine
	sc     *e2eServerConn
	stop   func()
	dir    string
	hello  map[string]any
	linkUp chan struct{}
}

func newConnectorsRig(t *testing.T, idle time.Duration) *connectorsRig {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, mcpConfigFileName), []byte(connectorsConfig(t)), 0o600); err != nil {
		t.Fatal(err)
	}
	pol := policy.Default()
	mc := &machine{pol: pol, mcpIdle: idle}
	audit, err := newAuditLogger(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { audit.Close() })
	mc.AttachAudit(audit)
	hub := mc.startConnectors(dir)
	t.Cleanup(hub.Shutdown)

	r := &connectorsRig{t: t, mc: mc, dir: dir, linkUp: make(chan struct{}, 1)}
	ready := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		conn, err := websocket.Accept(w, req, &websocket.AcceptOptions{Subprotocols: []string{"pystino-machine.v1"}})
		if err != nil {
			return
		}
		conn.SetReadLimit(1 << 24)
		sc := &e2eServerConn{t: t, conn: conn}
		r.hello = sc.readUntilType("hello")
		sc.send(map[string]any{"type": "welcome", "deviceId": "dev1", "status": "paired"})
		r.sc = sc
		close(ready)
		<-req.Context().Done()
	}))
	t.Cleanup(srv.Close)
	lnk := link.New(link.Config{
		CereaOrigin: srv.URL, MachineID: "m1", MachineName: "t", Cred: &fakeCredForE2E{},
		Hello:   func() link.Hello { return buildConnectorsHello(pol) },
		Handler: mc, Mcp: mc, Logf: t.Logf, MinBackoff: time.Hour,
	})
	mc.AttachLink(lnk)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = lnk.Run(ctx); close(done) }()
	r.stop = func() { cancel(); <-done }
	t.Cleanup(r.stop)
	select {
	case <-ready:
	case <-time.After(10 * time.Second):
		t.Fatal("the link never connected")
	}
	return r
}

// mcpFrame reads frames until an mcp frame for channel (skipping res frames
// kept for later) and returns it.
func (r *connectorsRig) mcpFrame() map[string]any {
	r.t.Helper()
	return r.sc.readUntilType("mcp")
}

func (r *connectorsRig) rpc(channel string, id int, method, params string) map[string]any {
	r.t.Helper()
	r.sc.send(map[string]any{"type": "mcp", "channelId": channel, "message": json.RawMessage(
		fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":%q,"params":%s}`, id, method, params))})
	for {
		f := r.mcpFrame()
		msg, _ := f["message"].(map[string]any)
		if msg != nil && fmt.Sprint(msg["id"]) == fmt.Sprint(id) {
			return msg
		}
	}
}

func (r *connectorsRig) open(server string) string {
	r.t.Helper()
	res := r.sc.req("o-"+server, "mcp.open", map[string]any{"server": server})
	if res["ok"] != true {
		r.t.Fatalf("mcp.open %s: %v", server, res)
	}
	return res["result"].(map[string]any)["channelId"].(string)
}

func TestConnectorsMachineHello(t *testing.T) {
	r := newConnectorsRig(t, 0)
	if backends, ok := r.hello["backends"].([]any); !ok || len(backends) != 0 {
		t.Errorf("backends = %#v, want []", r.hello["backends"])
	}
	machine := r.hello["machine"].(map[string]any)
	if machine["mode"] != "connectors" {
		t.Errorf("mode = %v", machine["mode"])
	}
	for k, v := range machine["capabilities"].(map[string]any) {
		if (k == "mcp") != (v == true) {
			t.Errorf("capability %s = %v", k, v)
		}
	}
	pol := r.hello["policy"].(map[string]any)
	if pol["terminal"] != "denied" || pol["files"] != "off" {
		t.Errorf("a connectors machine offers no terminal or files: %v", pol)
	}
}

func TestConnectorsMachineEndToEnd(t *testing.T) {
	r := newConnectorsRig(t, 0)

	// mcp.list: the three servers, sorted, the state and ceiling in view.
	res := r.sc.req("l1", "mcp.list", map[string]any{})
	servers := res["result"].(map[string]any)["servers"].([]any)
	if len(servers) != 3 {
		t.Fatalf("servers = %v", servers)
	}
	var names []string
	for _, s := range servers {
		names = append(names, s.(map[string]any)["name"].(string))
	}
	if strings.Join(names, ",") != "crashy,napper,notes" {
		t.Errorf("names = %v", names)
	}
	notes := servers[2].(map[string]any)
	if notes["description"] != "My notes" || notes["state"] != "ready" || fmt.Sprint(notes["allowedTools"]) != "[read_file boom]" {
		t.Errorf("notes = %v", notes)
	}

	// Session ops are unsupported with no backend, whatever they are.
	for _, op := range []string{"session.list", "workspace.list", "files.list", "terminal.list", "backend.models", "permissions.pending"} {
		res := r.sc.req("u-"+op, op, map[string]any{})
		e, _ := res["error"].(map[string]any)
		if res["ok"] != false || e["code"] != "unsupported" {
			t.Errorf("%s on a connectors machine: %v", op, res)
		}
	}

	// An unknown server.
	if res := r.sc.req("nf", "mcp.open", map[string]any{"server": "nope"}); res["ok"] != false || res["error"].(map[string]any)["code"] != "not_found" {
		t.Errorf("unknown server: %v", res)
	}

	ch := r.open("notes")
	init := r.rpc(ch, 1, "initialize", `{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}`)
	if _, ok := init["result"]; !ok {
		t.Fatalf("initialize: %v", init)
	}
	r.sc.send(map[string]any{"type": "mcp", "channelId": ch, "message": map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}})

	list := r.rpc(ch, 2, "tools/list", `{}`)
	var got []string
	for _, tl := range list["result"].(map[string]any)["tools"].([]any) {
		got = append(got, tl.(map[string]any)["name"].(string))
	}
	if fmt.Sprint(got) != "[read_file boom]" {
		t.Errorf("the ceiling did not filter tools/list: %v", got)
	}
	ok := r.rpc(ch, 3, "tools/call", `{"name":"read_file","arguments":{"path":"todo.md"}}`)
	if !strings.Contains(fmt.Sprint(ok["result"]), "called read_file dflt") {
		t.Errorf("allowed call: %v", ok)
	}
	refused := r.rpc(ch, 4, "tools/call", `{"name":"write_file","arguments":{"path":"x"}}`)
	if e := refused["error"].(map[string]any); e["code"].(float64) != -32001 || e["message"] != "this tool is not allowed on this machine" {
		t.Errorf("refused call: %v", refused)
	}

	if res := r.sc.req("c1", "mcp.close", map[string]any{"channelId": ch}); res["ok"] != true {
		t.Errorf("mcp.close: %v", res)
	}
	// Closing again, or an unknown channel, is {} too.
	if res := r.sc.req("c2", "mcp.close", map[string]any{"channelId": "ch_nope"}); res["ok"] != true {
		t.Errorf("mcp.close of nothing: %v", res)
	}

	// The audit log holds one line per tools/call: outcome, never arguments or results.
	body, err := os.ReadFile(filepath.Join(r.dir, "audit.log"))
	if err != nil {
		t.Fatal(err)
	}
	audit := string(body)
	for _, want := range []string{`"tool":"read_file"`, `"outcome":"ok"`, `"tool":"write_file"`, `"outcome":"refused"`, `"action":"mcp.call"`, `"server":"notes"`} {
		if !strings.Contains(audit, want) {
			t.Errorf("audit.log lacks %s:\n%s", want, audit)
		}
	}
	for _, leak := range []string{"todo.md", "called read_file"} {
		if strings.Contains(audit, leak) {
			t.Errorf("audit.log holds %q:\n%s", leak, audit)
		}
	}
}

func TestConnectorsCrashSendsClosed(t *testing.T) {
	r := newConnectorsRig(t, 0)
	ch := r.open("crashy")
	r.sc.send(map[string]any{"type": "mcp", "channelId": ch, "message": json.RawMessage(
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file"}}`)})
	for {
		f := r.mcpFrame()
		closed, _ := f["closed"].(map[string]any)
		if closed == nil {
			continue
		}
		if f["channelId"] != ch || closed["reason"] != "crashed" || closed["detail"] != "exit status 3: kaboom" {
			t.Errorf("closed frame = %v", f)
		}
		break
	}
}

func TestConnectorsIdleChannelIsClosed(t *testing.T) {
	r := newConnectorsRig(t, 300*time.Millisecond)
	ch := r.open("napper")
	for {
		f := r.mcpFrame()
		closed, _ := f["closed"].(map[string]any)
		if closed == nil {
			continue
		}
		if f["channelId"] != ch || closed["reason"] != "idle" || closed["detail"] != nil {
			t.Errorf("closed frame = %v", f)
		}
		break
	}
}

func TestConnectorsLinkDropClosesEveryChannel(t *testing.T) {
	r := newConnectorsRig(t, 0)
	r.open("notes")
	r.open("napper")
	if n := r.mc.mcp.OpenChannels(); n != 2 {
		t.Fatalf("open channels = %d", n)
	}
	r.sc.conn.CloseNow()
	deadline := time.Now().Add(5 * time.Second)
	for r.mc.mcp.OpenChannels() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("channels stayed open after the link dropped")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// An agent machine says mode agent and carries mcp: false until run sets it
// for an mcp.json; a connectors machine's hello matches its fixture's shape.
func TestAgentHelloSaysAgentMode(t *testing.T) {
	h := buildHello(newE2EFakeBackend(), policy.Default())
	if h.Machine.Mode != "agent" {
		t.Errorf("mode = %q", h.Machine.Mode)
	}
	if v, ok := h.Machine.Capabilities["mcp"]; !ok || v {
		t.Errorf("mcp capability = %v, %v", v, ok)
	}
}

// enroll --mode connectors takes the same sign-in and writes the credential,
// but no opencode.json, no gateway, no billing group; run then defaults to no
// backend.
func TestEnrollConnectorsWritesNoOpencodeConfig(t *testing.T) {
	srv := fakeEnrollServer(t)
	root := t.TempDir()
	creds := filepath.Join(root, "galopin", "credentials.json")
	opts := &enrollOptions{
		mode: "connectors", discover: true, issuer: srv.URL, clientID: "opencode-enrollment",
		device: true, creds: creds, cerea: "https://cerea.example",
		shimPort: defaultShimPort, yes: true, maxTerminals: 8,
	}
	if err := enroll(context.Background(), opts); err != nil {
		t.Fatalf("enroll --mode connectors: %v", err)
	}
	got, err := loadCredentials(creds)
	if err != nil {
		t.Fatal(err)
	}
	if got.Mode != modeConnectors || got.Gateway != "" || got.Group != "" || got.ShimSecret != "" || got.OpencodeConfig != "" ||
		got.RefreshToken != "rt" || got.CereaOrigin != "https://cerea.example" {
		t.Errorf("credentials = %+v", got)
	}
	entries, _ := os.ReadDir(filepath.Join(root, "galopin"))
	for _, e := range entries {
		if e.Name() == opencodeConfigFileName || e.Name() == policyFileName {
			t.Errorf("enroll --mode connectors wrote %s", e.Name())
		}
	}
	if _, err := os.Stat(filepath.Join(root, "galopin", machineIDFileName)); err != nil {
		t.Errorf("no machine id: %v", err)
	}
	if k := resolveBackendKind("", got); k != backendNone {
		t.Errorf("run's default backend = %q, want none", k)
	}
	if k := resolveBackendKind("acp", got); k != "acp" {
		t.Errorf("an explicit --backend must win: %q", k)
	}
	if k := resolveBackendKind("", &credentials{}); k != "" {
		t.Errorf("an agent machine keeps the opencode default: %q", k)
	}
}

func TestEnrollRefusesAnUnknownMode(t *testing.T) {
	err := runEnroll([]string{"--mode", "nope", "--creds", filepath.Join(t.TempDir(), "c.json")})
	if err == nil || !strings.Contains(err.Error(), "--mode") {
		t.Fatalf("err = %v", err)
	}
}

// run --backend none, whole: runAgent with a connectors credential starts no
// backend (there is no opencode here to start), dials Cerea with the
// connectors hello and answers mcp.list.
func TestRunBackendNoneServesConnectors(t *testing.T) {
	idp := fakeEnrollServer(t)
	dir := t.TempDir()
	creds := filepath.Join(dir, "credentials.json")
	if err := enroll(context.Background(), &enrollOptions{
		mode: "connectors", issuer: idp.URL, clientID: "opencode-enrollment", device: true, creds: creds,
		shimPort: defaultShimPort, yes: true, maxTerminals: 8,
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, mcpConfigFileName), []byte(connectorsConfig(t)), 0o600); err != nil {
		t.Fatal(err)
	}

	got := make(chan map[string]any, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"pystino-machine.v1"}})
		if err != nil {
			return
		}
		sc := &e2eServerConn{t: t, conn: conn}
		got <- sc.readUntilType("hello")
		sc.send(map[string]any{"type": "welcome", "deviceId": "dev1", "status": "paired"})
		got <- sc.req("r1", "mcp.list", map[string]any{})
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runAgent(ctx, &runOptions{cerea: srv.URL, credsPath: creds, stateDir: dir}) }()

	var hello, res map[string]any
	for i := 0; i < 2; i++ {
		select {
		case m := <-got:
			if m["type"] == "hello" {
				hello = m
			} else {
				res = m
			}
		case err := <-done:
			t.Fatalf("run ended early: %v", err)
		case <-time.After(15 * time.Second):
			t.Fatal("run never reached Cerea")
		}
	}
	if hello["machine"].(map[string]any)["mode"] != "connectors" || len(hello["backends"].([]any)) != 0 {
		t.Errorf("hello = %v", hello)
	}
	if servers := res["result"].(map[string]any)["servers"].([]any); len(servers) != 3 {
		t.Errorf("mcp.list = %v", res)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("run: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("run did not stop")
	}
}
