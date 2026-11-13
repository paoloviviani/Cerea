package mcpconn

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

func toolNames(t *testing.T, resp map[string]json.RawMessage) []string {
	t.Helper()
	var res struct {
		Tools []struct{ Name string } `json:"tools"`
		Extra string                  `json:"extra"`
	}
	if err := json.Unmarshal(resp["result"], &res); err != nil {
		t.Fatalf("%s", resp["result"])
	}
	if res.Extra != "kept" {
		t.Errorf("the filter dropped a field of the result: %s", resp["result"])
	}
	var out []string
	for _, x := range res.Tools {
		out = append(out, x.Name)
	}
	return out
}

func TestStdioChannelEndToEndWithTheCeiling(t *testing.T) {
	r := newRig(t, fakeConfig("", `, "allowedTools": ["read_file", "boom"]`), nil)

	list := r.hub.List()
	if len(list) != 1 || list[0].State != StateReady || list[0].OpenChannels != 0 || len(list[0].AllowedTools) != 2 {
		t.Fatalf("list = %+v", list)
	}
	ch := r.open("fake")
	if r.hub.List()[0].OpenChannels != 1 {
		t.Error("openChannels not counted")
	}

	init := r.call(ch, 1, "initialize", `{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}`)
	if !strings.Contains(string(init["result"]), `"fake"`) {
		t.Fatalf("initialize: %s", init["result"])
	}
	r.hub.Message(ch, []byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))

	// tools/list is filtered; the other fields of the result survive.
	if got := toolNames(t, r.call(ch, 2, "tools/list", `{}`)); fmt.Sprint(got) != "[read_file boom]" {
		t.Errorf("tools = %v", got)
	}
	// An allowed call goes through, and its environment came from the entry
	// with ${FAKE} expanded from galopin's environment.
	ok := r.call(ch, 3, "tools/call", `{"name":"read_file","arguments":{"path":"todo.md"}}`)
	if !strings.Contains(string(ok["result"]), "called read_file v1") {
		t.Errorf("allowed call: %s", ok["result"])
	}
	// An error result is audited as error.
	r.call(ch, 4, "tools/call", `{"name":"boom"}`)
	// A refused call is answered here with -32001 and never forwarded.
	ref := r.call(ch, 5, "tools/call", `{"name":"write_file","arguments":{"path":"x","secretarg":"zzz"}}`)
	var e struct{ Code int }
	_ = json.Unmarshal(ref["error"], &e)
	if e.Code != -32001 || !strings.Contains(string(ref["error"]), "this tool is not allowed on this machine") {
		t.Errorf("refused call: %s", ref["error"])
	}
	// A batch: the refused member is answered, the rest is forwarded.
	r.hub.Message(ch, []byte(`[{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"write_file"}},{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"read_file"}}]`))
	seen := map[string]bool{}
	for len(seen) < 2 {
		f := r.next()
		var m struct {
			ID    int             `json:"id"`
			Error json.RawMessage `json:"error"`
		}
		_ = json.Unmarshal(f.message, &m)
		seen[fmt.Sprintf("%d%v", m.ID, len(m.Error) > 0)] = true
	}
	if !seen["6true"] || !seen["7false"] {
		t.Errorf("batch answers: %v", seen)
	}

	r.hub.Close(ch)
	if r.hub.OpenChannels() != 0 {
		t.Error("channel still open")
	}
	audit := strings.Join(r.auditLines(), "|")
	for _, want := range []string{"fake read_file ok", "fake boom error", "fake write_file refused"} {
		if !strings.Contains(audit, want) {
			t.Errorf("audit lacks %q: %s", want, audit)
		}
	}
	if strings.Contains(audit, "todo.md") || strings.Contains(audit, "secretarg") || strings.Contains(audit, "called") {
		t.Errorf("audit holds arguments or results: %s", audit)
	}
	select {
	case c := <-r.closed:
		t.Errorf("mcp.close must not send a closed frame: %+v", c)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestNoAllowedToolsMeansEveryTool(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), nil)
	ch := r.open("fake")
	if got := toolNames(t, r.call(ch, 1, "tools/list", `{}`)); len(got) != 3 {
		t.Errorf("tools = %v", got)
	}
	// An empty list is no tools at all.
	writeConfig(t, r.dir+"/mcp.json", fakeConfig("", `, "allowedTools": []`))
	r.hub.Reload()
	if c := r.nextClosed(); c.reason != "config" {
		t.Errorf("closed = %+v", c)
	}
	ch = r.open("fake")
	if got := toolNames(t, r.call(ch, 1, "tools/list", `{}`)); len(got) != 0 {
		t.Errorf("tools = %v", got)
	}
}

func TestCrashSendsClosedWithStatusAndLastStderr(t *testing.T) {
	r := newRig(t, fakeConfig("crash", ""), nil)
	ch := r.open("fake")
	r.hub.Message(ch, []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file"}}`))
	c := r.nextClosed()
	if c.channel != ch || c.reason != "crashed" || c.detail != "exit status 3: kaboom" {
		t.Errorf("closed = %+v", c)
	}
	if r.hub.OpenChannels() != 0 {
		t.Error("channel still open")
	}
	if !strings.Contains(strings.Join(r.auditLines(), "|"), "fake read_file error") {
		t.Errorf("a call lost to a crash is audited as an error: %v", r.auditLines())
	}
}

func TestExitAtOnceIsUnavailableWithTheReason(t *testing.T) {
	r := newRig(t, fakeConfig("exit-at-once", ""), nil)
	_, err := r.hub.Open(t_ctx(t), "fake")
	if err == nil || err.Code != "unavailable" || !strings.Contains(err.Message, "exit status 1: Error: ENOENT") {
		t.Fatalf("err = %+v", err)
	}
}

func TestCannotStartIsUnavailable(t *testing.T) {
	r := newRig(t, `{"mcpServers":{"nope":{"command":"/no/such/binary-xyz"}}}`, nil)
	_, err := r.hub.Open(t_ctx(t), "nope")
	if err == nil || err.Code != "unavailable" || !strings.Contains(err.Message, "/no/such/binary-xyz") {
		t.Fatalf("err = %+v", err)
	}
}

func TestOpenRefusals(t *testing.T) {
	r := newRig(t, `{"mcpServers":{"off":{"command":"x","disabled":true},"bad":{"command":"x","env":{"A":"${NOPE_VAR}"}}}}`, nil)
	for name, want := range map[string]string{"zzz": "not_found", "off": "forbidden", "bad": "forbidden"} {
		_, err := r.hub.Open(t_ctx(t), name)
		if err == nil || err.Code != want {
			t.Errorf("%s: %+v, want %s", name, err, want)
		}
	}
	list := r.hub.List()
	if len(list) != 2 || list[0].Name != "bad" || list[0].State != StateInvalid || *list[0].Detail != "${NOPE_VAR} is not set" ||
		list[1].State != StateDisabled {
		t.Errorf("list = %+v", list)
	}
}

func TestMaxFourChannelsPerServer(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), nil)
	for i := 0; i < 4; i++ {
		r.open("fake")
	}
	_, err := r.hub.Open(t_ctx(t), "fake")
	if err == nil || err.Code != "unavailable" {
		t.Fatalf("fifth open: %+v", err)
	}
	if r.hub.List()[0].OpenChannels != 4 {
		t.Error("openChannels")
	}
}

func TestIdleChannelIsClosed(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), func(c *Config) { c.IdleTimeout = 250 * time.Millisecond })
	ch := r.open("fake")
	// Traffic keeps it alive.
	for i := 0; i < 3; i++ {
		time.Sleep(120 * time.Millisecond)
		r.call(ch, i+1, "ping", `{}`)
	}
	select {
	case c := <-r.closed:
		t.Fatalf("closed while in use: %+v", c)
	default:
	}
	c := r.nextClosed()
	if c.channel != ch || c.reason != "idle" || c.hasDetail {
		t.Errorf("closed = %+v", c)
	}
}

func TestConfigChangeClosesOnlyTheChangedServers(t *testing.T) {
	two := func(arg string) string {
		return fmt.Sprintf(`{"mcpServers": {
		  "a": {"command": %q, "args": [%q], "env": {"MCPFAKE_SERVER": "1"}},
		  "b": {"command": %q, "env": {"MCPFAKE_SERVER": "1"}}}}`, os.Args[0], arg, os.Args[0])
	}
	r := newRig(t, two("-test.run=NONE"), nil)
	a, b := r.open("a"), r.open("b")
	writeConfig(t, r.dir+"/mcp.json", two("-test.run=NONE2"))
	r.hub.Reload()
	if c := r.nextClosed(); c.channel != a || c.reason != "config" {
		t.Errorf("closed = %+v", c)
	}
	r.call(b, 1, "ping", `{}`) // b still works
	// Removing b closes it.
	writeConfig(t, r.dir+"/mcp.json", `{"mcpServers":{}}`)
	r.hub.Reload()
	if c := r.nextClosed(); c.channel != b || c.reason != "config" {
		t.Errorf("closed = %+v", c)
	}
	if len(r.hub.List()) != 0 {
		t.Error("servers remain")
	}
}

func TestWatchPicksUpAChangedFile(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), func(c *Config) { c.PollEvery = 20 * time.Millisecond })
	ctx := t_ctx(t)
	go r.hub.Watch(ctx)
	ch := r.open("fake")
	time.Sleep(50 * time.Millisecond)
	writeConfig(t, r.dir+"/mcp.json", fakeConfig("", `, "description": "now with a description"`))
	if c := r.nextClosed(); c.channel != ch || c.reason != "config" {
		t.Errorf("closed = %+v", c)
	}
	if d := r.hub.List()[0].Description; d == nil || *d != "now with a description" {
		t.Errorf("description = %v", d)
	}
	// A file that stops parsing leaves the servers as they were.
	writeConfig(t, r.dir+"/mcp.json", `{broken`)
	time.Sleep(150 * time.Millisecond)
	if len(r.hub.List()) != 1 {
		t.Error("a broken file dropped the servers")
	}
}

func TestMessageForAnUnknownChannelIsAnsweredWithClosed(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), nil)
	r.hub.Message("ch_nope", []byte(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	if c := r.nextClosed(); c.channel != "ch_nope" || c.reason != "closed" {
		t.Errorf("closed = %+v", c)
	}
	r.hub.Close("ch_nope") // no panic, no frame
}

func TestOversizeResponseIsAnsweredWithAnError(t *testing.T) {
	r := newRig(t, fakeConfig("big", ""), nil)
	ch := r.open("fake")
	resp := r.call(ch, 1, "tools/call", `{"name":"read_file"}`)
	if !strings.Contains(string(resp["error"]), "too large") {
		t.Errorf("response = %v", resp)
	}
	// And the channel still works.
	r.call(ch, 2, "ping", `{}`)
}

func TestOversizeRequestFromCereaIsAnsweredWithAnError(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), nil)
	ch := r.open("fake")
	huge := fmt.Sprintf(`{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"read_file","arguments":{"x":%q}}}`, strings.Repeat("y", MaxMessageBytes))
	r.hub.Message(ch, []byte(huge))
	f := r.next()
	if !strings.Contains(string(f.message), "too large") || !strings.Contains(string(f.message), `"id":9`) {
		t.Errorf("frame = %s", f.message)
	}
}

func TestLinkDownClosesEverythingQuietly(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), nil)
	r.open("fake")
	r.open("fake")
	r.hub.LinkDown()
	if r.hub.OpenChannels() != 0 {
		t.Error("channels remain")
	}
	select {
	case c := <-r.closed:
		t.Errorf("a dropped link gets no closed frames: %+v", c)
	case <-time.After(100 * time.Millisecond):
	}
}

// pidGone: no such process (kill -0 says ESRCH, on Linux and macOS alike), or
// only a zombie waiting to be reaped.
func pidGone(pid int) bool {
	if err := syscall.Kill(pid, 0); err == syscall.ESRCH {
		return true
	}
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil && !os.IsPermission(err) && runtime.GOOS == "linux" {
		return true // reaped between the two checks
	}
	return strings.Contains(string(b), ") Z ")
}

func TestProcessGroupIsKilledOnClose(t *testing.T) {
	// A server that leaves a grandchild behind: closing the channel must take
	// the whole group.
	dir := t.TempDir()
	pidFile := dir + "/pid"
	script := fmt.Sprintf(`sleep 300 & echo $! > %s; wait`, pidFile)
	r := newRig(t, fmt.Sprintf(`{"mcpServers":{"g":{"command":"sh","args":["-c",%q]}}}`, script), nil)
	ch := r.open("g")
	var pid int
	for i := 0; i < 100; i++ {
		b, _ := os.ReadFile(pidFile)
		if _, err := fmt.Sscan(string(b), &pid); err == nil && pid > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if pid == 0 {
		t.Fatal("no grandchild pid")
	}
	r.hub.Close(ch)
	r.hub.Shutdown()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if pidGone(pid) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("grandchild %d outlived the channel", pid)
}

// A sign-in stored right after the server was flagged must clear the flag. The
// file's mtime comes from the kernel's coarse clock and can read earlier than
// the instant the flag was raised, so the flag compares the stored file, not
// clocks.
func TestSignInStoredRightAfterFlagClearsNeedsLogin(t *testing.T) {
	f := newFakeHTTPServer(t, true)
	r := newRig(t, f.config(""), nil)
	e := r.hub.Entry("web")
	for i := 0; i < 500; i++ {
		r.hub.flagLogin("web")
		if !r.hub.loginNeeded(e) {
			t.Fatalf("round %d: a flagged server with no sign-in must need one", i)
		}
		tok := &StoredToken{Server: e.URL, TokenEndpoint: f.srv.URL + "/token", ClientID: "c",
			AccessToken: fmt.Sprintf("a%d", i), ExpiresAt: time.Now().Add(time.Hour).Unix()}
		if err := r.hub.Tokens().Save("web", tok); err != nil {
			t.Fatal(err)
		}
		if r.hub.loginNeeded(e) {
			t.Fatalf("round %d: still needs-login right after a sign-in was stored", i)
		}
		r.hub.Tokens().Delete("web")
	}
}

func TestBeforeStartRunsBeforeAStdioProcessAndCanRefuseTheOpen(t *testing.T) {
	var started []string
	refuse := false
	r := newRig(t, fakeConfig("", ""), func(c *Config) {
		c.BeforeStart = func(_ context.Context, e *Entry) *OpenError {
			started = append(started, e.Name)
			if refuse {
				return &OpenError{Code: "forbidden", Message: "no key for you"}
			}
			return nil
		}
	})
	r.open("fake")
	if len(started) != 1 || started[0] != "fake" {
		t.Fatalf("the hook did not run before the open: %v", started)
	}
	refuse = true
	_, err := r.hub.Open(t_ctx(t), "fake")
	if err == nil || err.Code != "forbidden" || !strings.Contains(err.Message, "no key for you") {
		t.Fatalf("a refusing hook must refuse the open: %+v", err)
	}
	if got := r.hub.List()[0].OpenChannels; got != 1 {
		t.Errorf("a refused open left a channel: %d", got)
	}
}

func TestServerLimitsHoldOneServerToFewerChannels(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), func(c *Config) { c.ServerLimits = map[string]int{"fake": 1} })
	r.open("fake")
	_, err := r.hub.Open(t_ctx(t), "fake")
	if err == nil || err.Code != "unavailable" || !strings.Contains(err.Message, "already has 1 open channels") {
		t.Fatalf("second open of a one-channel server: %+v", err)
	}
	// A limit cannot raise the default, and 0 means no special limit.
	r2 := newRig(t, fakeConfig("", ""), func(c *Config) { c.ServerLimits = map[string]int{"fake": 9} })
	for i := 0; i < 4; i++ {
		r2.open("fake")
	}
	if _, err := r2.hub.Open(t_ctx(t), "fake"); err == nil {
		t.Error("the limit raised the default of four")
	}
}

func keepTweak(idle, grace time.Duration) func(*Config) {
	return func(c *Config) {
		c.KeepAliveIdle, c.KeepAliveGrace = idle, grace
		c.KeepAlive = map[string]bool{"fake": true}
	}
}

// stdioOf is the process behind a channel, read under the hub's lock.
func (r *rig) stdioOf(id string) *stdioConn {
	r.t.Helper()
	r.hub.mu.Lock()
	ch := r.hub.channels[id]
	r.hub.mu.Unlock()
	if ch == nil {
		r.t.Fatalf("no channel %s", id)
	}
	sc, _ := ch.tr.(*stdioConn)
	if sc == nil {
		r.t.Fatal("not stdio")
	}
	return sc
}

func (r *rig) parkedPid() (int, bool) {
	r.hub.mu.Lock()
	defer r.hub.mu.Unlock()
	p := r.hub.parked["fake"]
	if p == nil {
		return 0, false
	}
	return p.sc.Pid(), true
}

func waitGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(6 * time.Second)
	for !pidGone(pid) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if !pidGone(pid) {
		t.Fatalf("process %d still running", pid)
	}
}

const initParams = `{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}`

func TestKeptServerIdleParksTheProcessInsteadOfStoppingIt(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), keepTweak(200*time.Millisecond, time.Minute))
	ch := r.open("fake")
	pid := r.stdioOf(ch).Pid()
	// Traffic keeps the channel; silence retires it.
	for i := 0; i < 3; i++ {
		time.Sleep(100 * time.Millisecond)
		r.call(ch, i+1, "ping", `{}`)
	}
	c := r.nextClosed()
	if c.channel != ch || c.reason != "idle" {
		t.Fatalf("closed = %+v", c)
	}
	if got, ok := r.parkedPid(); !ok || got != pid || pidGone(pid) {
		t.Fatalf("process not parked: %d %v", got, ok)
	}
	ch2 := r.open("fake")
	if r.stdioOf(ch2).Pid() != pid {
		t.Error("a new process was started")
	}
}

func TestKeptServerSurvivesLinkDownAndIsReattached(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), keepTweak(0, time.Minute))
	ch := r.open("fake")
	r.call(ch, 1, "initialize", initParams)
	pid := r.stdioOf(ch).Pid()
	r.hub.LinkDown()
	if r.hub.OpenChannels() != 0 {
		t.Error("channels remain")
	}
	if got, ok := r.parkedPid(); !ok || got != pid {
		t.Fatalf("process not kept: %d %v", got, ok)
	}
	if pidGone(pid) {
		t.Fatal("the process was killed on link down")
	}
	ch2 := r.open("fake")
	if ch2 == ch {
		t.Fatal("same channel id")
	}
	if _, ok := r.parkedPid(); ok {
		t.Error("still parked after reattach")
	}
	if got := r.stdioOf(ch2).Pid(); got != pid {
		t.Errorf("a new process (%d) was started, not %d", got, pid)
	}
	// The same ids as the first client used: answered under this client's ids.
	init := r.call(ch2, 1, "initialize", initParams)
	if !strings.Contains(string(init["result"]), `"fake"`) {
		t.Errorf("initialize on the reattached channel: %s", init["result"])
	}
	if got := r.call(ch2, 2, "ping", `{}`); got["result"] == nil {
		t.Errorf("ping: %v", got)
	}
	r.hub.Close(ch2)
	waitGone(t, pid)
}

func TestKeptServerStopsWhenTheGraceEnds(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), keepTweak(0, 300*time.Millisecond))
	ch := r.open("fake")
	pid := r.stdioOf(ch).Pid()
	r.hub.LinkDown()
	if pidGone(pid) {
		t.Fatal("killed at once")
	}
	waitGone(t, pid)
	if _, ok := r.parkedPid(); ok {
		t.Error("still parked")
	}
}

func TestShutdownStopsAKeptServer(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), keepTweak(0, time.Minute))
	ch := r.open("fake")
	pid := r.stdioOf(ch).Pid()
	r.hub.LinkDown()
	r.hub.Shutdown()
	waitGone(t, pid)
}

func TestOtherServersAreStillKilledOnLinkDown(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), func(c *Config) { c.KeepAlive = map[string]bool{"other": true} })
	ch := r.open("fake")
	pid := r.stdioOf(ch).Pid()
	r.hub.LinkDown()
	if _, ok := r.parkedPid(); ok {
		t.Fatal("parked a server that is not kept")
	}
	waitGone(t, pid)
}

func TestOpeningAtTheLimitRetiresTheOldChannelAndAdoptsItsProcess(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), func(c *Config) {
		keepTweak(0, time.Minute)(c)
		c.ServerLimits = map[string]int{"fake": 1}
	})
	ch := r.open("fake")
	pid := r.stdioOf(ch).Pid()
	ch2 := r.open("fake")
	if ch2 == ch || r.stdioOf(ch2).Pid() != pid {
		t.Fatalf("not adopted: %s %s", ch, ch2)
	}
	if c := r.nextClosed(); c.channel != ch {
		t.Errorf("closed = %+v", c)
	}
	if r.hub.OpenChannels() != 1 {
		t.Errorf("channels = %d", r.hub.OpenChannels())
	}
	if got := r.call(ch2, 1, "ping", `{}`); got["result"] == nil {
		t.Errorf("ping: %v", got)
	}
}

func TestDropParkedLeavesAProcessAlreadyTaken(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), keepTweak(0, time.Minute))
	ch := r.open("fake")
	pid := r.stdioOf(ch).Pid()
	r.hub.LinkDown()
	r.hub.mu.Lock()
	p := r.hub.parked["fake"]
	r.hub.mu.Unlock()
	ch2 := r.open("fake") // adopts p
	r.hub.dropParked(p, "late timer")
	if pidGone(pid) {
		t.Fatal("a stale drop killed the adopted process")
	}
	if got := r.call(ch2, 1, "ping", `{}`); got["result"] == nil {
		t.Errorf("ping: %v", got)
	}
}

func TestTakeParkedRefusesAChangedEntry(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), keepTweak(0, time.Minute))
	ch := r.open("fake")
	pid := r.stdioOf(ch).Pid()
	r.hub.LinkDown()
	e := *r.hub.Entry("fake")
	e.Args = append(append([]string(nil), e.Args...), "--changed")
	if p := r.hub.takeParked("fake", &e); p != nil {
		t.Fatal("adopted a process of another entry")
	}
	waitGone(t, pid)
}

func TestAdoptingADeadProcessIsRefused(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), keepTweak(0, time.Minute))
	e := r.hub.Entry("fake")
	sc, err := startStdio(e, &sink{message: func([]byte) {}, closed: func(string, string) {}, logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	sc.Close()
	<-sc.Done()
	c := newChannel(r.hub, e)
	c.adopt = &parkedConn{entry: e, sc: sc}
	if oerr := c.start(t_ctx(t)); oerr == nil || oerr.Code != "unavailable" {
		t.Fatalf("start = %v", oerr)
	}
}

func TestBeforeStartRefusalDropsTheKeptProcess(t *testing.T) {
	refuse := false
	r := newRig(t, fakeConfig("", ""), func(c *Config) {
		keepTweak(0, time.Minute)(c)
		c.BeforeStart = func(context.Context, *Entry) *OpenError {
			if refuse {
				return &OpenError{"forbidden", "no key"}
			}
			return nil
		}
	})
	ch := r.open("fake")
	pid := r.stdioOf(ch).Pid()
	r.hub.LinkDown()
	refuse = true
	if _, oerr := r.hub.Open(t_ctx(t), "fake"); oerr == nil {
		t.Fatal("open succeeded")
	}
	waitGone(t, pid)
	if _, ok := r.parkedPid(); ok {
		t.Error("still parked")
	}
}

func TestKeptChannelIDsAreRemappedPerGeneration(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), keepTweak(0, time.Minute))
	ch := r.open("fake")
	r.hub.LinkDown()
	ch2 := r.open("fake")
	r.hub.mu.Lock()
	c := r.hub.channels[ch2]
	r.hub.mu.Unlock()
	c.mu.Lock()
	gen := c.gen
	c.reqIDs["1"], c.reqIDs[`"a"`] = true, true
	c.mu.Unlock()
	if gen != 2 {
		t.Fatalf("gen = %d", gen)
	}
	resp := func(id string) []byte {
		return []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":{}}`, id))
	}
	c.fromServer(resp(`"g1:1"`)) // an earlier client's answer: dropped
	c.fromServer(resp(`"g2:9"`)) // nobody here asked: dropped
	select {
	case f := <-r.frames:
		t.Fatalf("delivered a stale response: %s", f.message)
	case <-time.After(100 * time.Millisecond):
	}
	c.fromServer(resp(`"g2:1"`))
	if f := r.next(); !strings.Contains(string(f.message), `"id":1,`) {
		t.Errorf("number id: %s", f.message)
	}
	c.fromServer(resp(`"g2:\"a\""`))
	if f := r.next(); !strings.Contains(string(f.message), `"id":"a"`) {
		t.Errorf("string id: %s", f.message)
	}
	_ = ch
}

func TestTransientBeforeStartFailureKeepsTheProcessAndTheOldChannel(t *testing.T) {
	var fail *OpenError
	r := newRig(t, fakeConfig("", ""), func(c *Config) {
		keepTweak(0, time.Minute)(c)
		c.ServerLimits = map[string]int{"fake": 1}
		c.BeforeStart = func(context.Context, *Entry) *OpenError { return fail }
	})
	ch := r.open("fake")
	pid := r.stdioOf(ch).Pid()
	// The limit would retire the old channel, but the key fetch fails first: nothing changes.
	fail = &OpenError{"unavailable", "key fetch timed out"}
	if _, oerr := r.hub.Open(t_ctx(t), "fake"); oerr == nil {
		t.Fatal("open succeeded")
	}
	if r.hub.OpenChannels() != 1 || pidGone(pid) {
		t.Fatal("the old channel was retired by an open that failed")
	}
	// A transient failure on a parked process leaves it too.
	r.hub.LinkDown()
	if _, oerr := r.hub.Open(t_ctx(t), "fake"); oerr == nil {
		t.Fatal("open succeeded")
	}
	if _, ok := r.parkedPid(); !ok || pidGone(pid) {
		t.Fatal("a transient failure dropped the kept process")
	}
}

func TestCancelledRequestIDIsRemappedAndLocalAnswersForgetTheirIDs(t *testing.T) {
	r := newRig(t, fakeConfig("", `, "allowedTools": ["read_file"]`), keepTweak(0, time.Minute))
	ch := r.open("fake")
	r.hub.LinkDown()
	ch2 := r.open("fake")
	r.hub.mu.Lock()
	c := r.hub.channels[ch2]
	r.hub.mu.Unlock()
	if c.gen != 2 {
		t.Fatalf("gen = %d", c.gen)
	}
	r.hub.Message(ch2, []byte(`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7,"reason":"x"}}`))
	// A refused call is answered here and its id forgotten.
	r.call(ch2, 9, "tools/call", `{"name":"write_file"}`)
	c.mu.Lock()
	_, tracked := c.reqIDs["9"]
	c.mu.Unlock()
	if tracked {
		t.Error("a locally answered id is still tracked")
	}
	_ = ch
}

func TestSetRequestIDWrapsTheCancelledId(t *testing.T) {
	msg := []byte(`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7,"reason":"x"}}`)
	out := setRequestID(msg, wrapID(2, json.RawMessage("7")))
	var m struct {
		Params struct {
			RequestID string `json:"requestId"`
			Reason    string `json:"reason"`
		} `json:"params"`
	}
	if err := json.Unmarshal(out, &m); err != nil || m.Params.RequestID != "g2:7" || m.Params.Reason != "x" {
		t.Fatalf("%s (%v)", out, err)
	}
}
