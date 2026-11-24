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
	t.Helper()
	if os.Getenv("GALOPIN_LAUNCH_CONNECTORS_IT") != "1" {
		t.Skip("set GALOPIN_LAUNCH_CONNECTORS_IT=1 to run (real claude / opencode, no model call)")
	}
	r := newLaunchRig(t, 0, "x")
	stubUpstream(t, r.state, &stubSource{tools: []localmcp.Tool{{Name: "tracker-find", Description: "(tracker, from Cerea) find issues"}}})
	home := t.TempDir()
	t.Setenv("HOME", home)
	r.baseEnv = append(r.baseEnv, "HOME="+home, "XDG_CONFIG_HOME="+filepath.Join(home, "c"), "XDG_DATA_HOME="+filepath.Join(home, "d"),
		"XDG_CACHE_HOME="+filepath.Join(home, "k"), "XDG_STATE_HOME="+filepath.Join(home, "s"))
	return r, filepath.Join(t.TempDir(), "out")
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
	if !strings.Contains(string(b), `"name":"cerea-connectors","status":"connected"`) || !strings.Contains(string(b), "mcp__cerea-connectors__tracker-find") {
		t.Fatalf("claude's init does not show the connectors server connected with its tool:\n%.3000s", b)
	}
	t.Logf("claude init shows cerea-connectors connected with mcp__cerea-connectors__tracker-find")
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
			if strings.Contains(body, "cerea-connectors") {
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
