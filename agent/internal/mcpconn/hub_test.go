package mcpconn

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
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
		if _, err := os.Stat(fmt.Sprintf("/proc/%d", pid)); os.IsNotExist(err) {
			return
		}
		// A zombie still has a /proc entry; its state says so.
		if b, _ := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid)); strings.Contains(string(b), ") Z ") {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("grandchild %d outlived the channel", pid)
}
