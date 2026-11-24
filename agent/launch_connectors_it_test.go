package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"galopin/internal/localmcp"
)

// Real-binary checks that the connectors endpoint shows up in the launched tool
// (GALOPIN_LAUNCH_CONNECTORS_IT=1). No model is called: Claude Code reports its
// MCP servers in the init message of a -p run (the fake gateway then fails the
// request), and opencode connects its MCP servers for `opencode mcp list`.

func itWrapper(t *testing.T, r *launchRig, real string, out string) string {
	t.Helper()
	w := filepath.Join(filepath.Dir(r.fakeBin), "wrapped-"+filepath.Base(real))
	body := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exec " + real + " \"$@\"; fi\nexec " + real + " \"$@\" > " + out + " 2>&1\n"
	if err := os.WriteFile(w, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return w
}

func itRig(t *testing.T) (*launchRig, string) {
	r, out, _ := itRigStub(t)
	return r, out
}

func itRigStub(t *testing.T) (*launchRig, string, *stubSource) {
	t.Helper()
	if os.Getenv("GALOPIN_LAUNCH_CONNECTORS_IT") != "1" {
		t.Skip("set GALOPIN_LAUNCH_CONNECTORS_IT=1 to run (real claude / opencode, no model call)")
	}
	r := newLaunchRig(t, 0, "x")
	stub := &stubSource{tools: []localmcp.Tool{{Name: "tracker-find", Description: "(tracker, from Cerea) find issues"}}}
	stubUpstream(t, r.state, stub)
	// Vibe leaves read-only directories in its home; let the temp dir be removed.
	t.Cleanup(func() { _ = exec.Command("chmod", "-R", "u+w", filepath.Dir(r.state)).Run() })
	home := t.TempDir()
	t.Setenv("HOME", home)
	r.baseEnv = append(r.baseEnv, "HOME="+home, "XDG_CONFIG_HOME="+filepath.Join(home, "c"), "XDG_DATA_HOME="+filepath.Join(home, "d"),
		"XDG_CACHE_HOME="+filepath.Join(home, "k"), "XDG_STATE_HOME="+filepath.Join(home, "s"))
	return r, filepath.Join(t.TempDir(), "out"), stub
}

func TestLaunchClaudeShowsTheConnectorsServerIT(t *testing.T) {
	r, out := itRig(t)
	real, err := exec.LookPath("claude")
	if err != nil {
		t.Skip("claude not installed")
	}
	o := r.opts("-p", "hi", "--output-format", "stream-json", "--verbose")
	o.claudeBin, o.model = itWrapper(t, r, real, out), "gw-model"
	_ = launchClaude(context.Background(), o) // the fake gateway fails the model call
	b, _ := os.ReadFile(out)
	// (Claude Code defers MCP tool names in its init message, so the status is the check.)
	if !strings.Contains(string(b), `"name":"cerea-connectors","status":"connected"`) {
		t.Fatalf("claude's init does not show the connectors server connected:\n%.3000s", b)
	}
	t.Logf("claude init shows cerea-connectors connected")
}

func TestLaunchOpencodeShowsTheConnectorsServerIT(t *testing.T) {
	r, out := itRig(t)
	real, err := exec.LookPath("opencode")
	if err != nil {
		home, _ := os.UserHomeDir()
		real = filepath.Join(home, ".opencode", "bin", "opencode")
	}
	port := itFreePort(t)
	o := r.opts("serve", "--port", itPortStr(port), "--hostname", "127.0.0.1")
	o.opencodeBin = itWrapper(t, r, real, out)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- launchOpencode(ctx, o) }()
	defer func() { cancel(); <-done }()
	// opencode's own view of its MCP servers (what the TUI's /mcps shows)
	var body string
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		req, _ := http.NewRequest(http.MethodGet, "http://127.0.0.1:"+itPortStr(port)+"/api/mcp", nil)
		logb, _ := os.ReadFile(out)
		if _, pw, ok := strings.Cut(string(logb), "server password "); ok {
			req.SetBasicAuth("opencode", strings.TrimSpace(strings.SplitN(pw, "\n", 2)[0]))
		}
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			body = string(b)
			if strings.Contains(body, "cerea-connectors") && strings.Contains(body, "connected") {
				break
			}
		}
		time.Sleep(time.Second)
	}
	logs, _ := os.ReadFile(out)
	t.Logf("GET /api/mcp: %s", body)
	if !strings.Contains(body, "cerea-connectors") || !strings.Contains(body, "connected") {
		t.Fatalf("opencode does not report the connectors server as connected: %s\nlog:\n%.2000s", body, logs)
	}
}

// acpDriver starts vibe-acp (its path is argv[1]) and runs session/new and a
// "/mcp status" prompt (a Vibe command: no model call), printing every message.
const acpDriver = `
import json, subprocess, sys, time
p = subprocess.Popen([sys.argv[1]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
def send(i, method, params):
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params}) + "\n"); p.stdin.flush()
def read_until(i):
    while True:
        line = p.stdout.readline()
        if not line: sys.exit("vibe-acp closed")
        print(line.strip(), flush=True)
        try: m = json.loads(line)
        except Exception: continue
        if m.get("id") == i and "method" not in m: return m
send(1, "initialize", {"protocolVersion": 1, "clientCapabilities": {}})
read_until(1)
send(2, "session/new", {"cwd": sys.argv[2], "mcpServers": []})
sid = read_until(2)["result"]["sessionId"]
time.sleep(5)
send(3, "session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "/mcp status"}]})
read_until(3)
p.terminate()
`

func TestLaunchVibeShowsTheConnectorsServerIT(t *testing.T) {
	r, out, stub := itRigStub(t)
	// every Vibe listing reaches the upstream, so a count above the launch's own proves it connected
	defer func(d time.Duration) { upstreamCacheTTL = d }(upstreamCacheTTL)
	upstreamCacheTTL = 0
	vibeBin := os.Getenv("GALOPIN_VIBE_BIN") // .../venv/bin/vibe of the pinned Vibe
	if vibeBin == "" {
		t.Skip("set GALOPIN_VIBE_BIN to the pinned Vibe's vibe (its vibe-acp is beside it)")
	}
	acp := filepath.Join(filepath.Dir(vibeBin), "vibe-acp")
	driver := filepath.Join(t.TempDir(), "driver.py")
	if err := os.WriteFile(driver, []byte(acpDriver), 0o600); err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	w := filepath.Join(filepath.Dir(r.fakeBin), "wrapped-vibe")
	script := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exec " + vibeBin + " --version; fi\nexec python3 -I " + driver + " " + acp + " " + work + " > " + out + " 2>&1\n"
	if err := os.WriteFile(w, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	o := r.opts()
	o.vibeBin, o.model = w, "gw-model"
	err := launchVibe(context.Background(), o)
	b, _ := os.ReadFile(out)
	t.Logf("launchVibe err %v\n%s", err, b[max(0, len(b)-1500):])
	// Vibe accepted the config entry (its own model, vibe/core/config/models.py) ...
	if !strings.Contains(string(b), "`cerea_connectors`: `enabled`") {
		t.Fatalf("Vibe's /mcp status does not list cerea_connectors")
	}
	// ... and connected to it: the endpoint listed the Cerea tools for Vibe beyond
	// the launch's own startup listing.
	if n := stub.listed.Load(); n < 2 {
		t.Fatalf("Vibe never connected to the endpoint (upstream listed %d times)", n)
	}
}
