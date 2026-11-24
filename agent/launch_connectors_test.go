package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/internal/localmcp"
	"galopin/packaging"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// stubSource is a running galopin's local-agents endpoint for the tests.
type stubSource struct {
	tools []localmcp.Tool
	calls []string
}

func (s *stubSource) Tools(context.Context) []localmcp.Tool { return s.tools }
func (s *stubSource) Call(_ context.Context, name string, _ json.RawMessage) (string, error) {
	s.calls = append(s.calls, name)
	return "ran " + name, nil
}

// stubUpstream serves src as the endpoint 'galopin run' would, and records it
// in <stateDir>/local-agents.json with the long-lived secret.
func stubUpstream(t *testing.T, stateDir string, src localmcp.Source) (secret string) {
	t.Helper()
	secret = "long-lived-endpoint-secret"
	mux := http.NewServeMux()
	mux.Handle(localmcp.Path, localmcp.Handler(secret, src, "test"))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	body := `{"port":` + port + `,"secret":"` + secret + `"}`
	if err := os.WriteFile(filepath.Join(stateDir, localAgentsFileName), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return secret
}

func connectLaunch(t *testing.T, c *launchConnectors, secret string) (*mcp.ClientSession, error) {
	t.Helper()
	return upstreamEndpoint{url: c.URL, secret: secret}.connect(context.Background())
}

func listNames(t *testing.T, s *mcp.ClientSession) []string {
	t.Helper()
	var out []string
	for tool, err := range s.Tools(context.Background(), nil) {
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, tool.Name)
	}
	return out
}

func TestLaunchConnectorsForwardOnlyCereasToolsWithThePerLaunchSecret(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	up := &stubSource{tools: []localmcp.Tool{
		{Name: "tracker-find", Description: "(tracker, from Cerea) find issues"},
		{Name: "files-read", Description: "(files, on this machine) read"},
	}}
	longSecret := stubUpstream(t, r.state, up)
	ls, err := startLaunch(r.opts())
	if err != nil {
		t.Fatal(err)
	}
	c := ls.startLaunchConnectors(context.Background())
	if c == nil {
		t.Fatal("no connectors endpoint")
	}
	defer c.close()
	if c.Secret == longSecret || c.Secret == r.creds_.ShimSecret || !strings.HasPrefix(c.Secret, "gl-") {
		t.Errorf("the endpoint secret %q is not a per-launch one", c.Secret)
	}
	if !strings.Contains(c.Summary, "1 from Cerea") {
		t.Errorf("summary = %q", c.Summary)
	}
	// the long-lived secret does not open the launch endpoint
	if _, err := connectLaunch(t, c, longSecret); err == nil {
		t.Error("the endpoint accepted the long-lived secret")
	}
	s, err := connectLaunch(t, c, c.Secret)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if names := listNames(t, s); len(names) != 1 || names[0] != "tracker-find" {
		t.Errorf("tools = %v, want only the Cerea one", names)
	}
	res, err := s.CallTool(context.Background(), &mcp.CallToolParams{Name: "tracker-find", Arguments: map[string]any{}})
	if err != nil || res.IsError {
		t.Fatalf("call: %v %v", err, res)
	}
	if txt := res.Content[0].(*mcp.TextContent).Text; txt != "ran tracker-find" || len(up.calls) != 1 {
		t.Errorf("result %q calls %v", txt, up.calls)
	}
	// after close nothing answers
	addr := strings.TrimSuffix(strings.TrimPrefix(c.URL, "http://"), localmcp.Path)
	c.close()
	if ln, err := net.Listen("tcp", addr); err != nil {
		t.Errorf("the endpoint's port is still held after close: %v", err)
	} else {
		ln.Close()
	}
}

func TestLaunchConnectorsSwitchOffOffersNothingAndSaysSo(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	// the Cerea switch off: the endpoint of a running galopin lists no Cerea tool
	stubUpstream(t, r.state, &stubSource{})
	ls, _ := startLaunch(r.opts())
	c := ls.startLaunchConnectors(context.Background())
	defer c.close()
	if !strings.Contains(c.Summary, "none from Cerea") || !strings.Contains(c.Summary, "switch") {
		t.Errorf("summary = %q", c.Summary)
	}
	if !strings.Contains(r.stderrBuf.String(), c.Summary) {
		t.Errorf("the summary is not on stderr:\n%s", r.stderrBuf.String())
	}
	s, err := connectLaunch(t, c, c.Secret)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if names := listNames(t, s); len(names) != 0 {
		t.Errorf("tools = %v, want none", names)
	}
}

func TestLaunchConnectorsNoRunningGalopin(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	ls, _ := startLaunch(r.opts())
	c := ls.startLaunchConnectors(context.Background())
	defer c.close()
	if !strings.Contains(c.Summary, "none from Cerea") || !strings.Contains(c.Summary, "galopin run") {
		t.Errorf("summary = %q", c.Summary)
	}
	// a local-agents.json whose endpoint is down reads the same way, with its own reason
	if err := os.WriteFile(filepath.Join(r.state, localAgentsFileName), []byte(`{"port":1,"secret":"x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	c2 := ls.startLaunchConnectors(context.Background())
	defer c2.close()
	if !strings.Contains(c2.Summary, "not answering") {
		t.Errorf("summary = %q", c2.Summary)
	}
}

// fakeLaunchToolCat is a fake tool that records its arguments and the files named.
func rigWithConnectors(t *testing.T) *launchRig {
	t.Helper()
	r := newLaunchRig(t, 0, "x")
	stubUpstream(t, r.state, &stubSource{tools: []localmcp.Tool{{Name: "tracker-find", Description: "(tracker, from Cerea) find"}}})
	return r
}

func assertConnectorsIn(t *testing.T, rec string, r *launchRig, wantFragments ...string) {
	t.Helper()
	for _, w := range append([]string{"cerea-connectors", "http://127.0.0.1:", "/local-agents"}, wantFragments...) {
		if w == "cerea-connectors" && !strings.Contains(rec, "cerea-connectors") && !strings.Contains(rec, "cerea_connectors") {
			t.Errorf("no connectors entry in the tool's config:\n%s", rec)
			continue
		}
		if w != "cerea-connectors" && !strings.Contains(rec, w) {
			t.Errorf("record lacks %q:\n%s", w, rec)
		}
	}
	if strings.Contains(rec, "long-lived-endpoint-secret") || strings.Contains(rec, r.creds_.ShimSecret) {
		t.Errorf("a long-lived secret reached the tool:\n%s", rec)
	}
	if !strings.Contains(r.stderrBuf.String(), "connectors: 1 from Cerea") {
		t.Errorf("no connectors line on stderr:\n%s", r.stderrBuf.String())
	}
}

func TestLaunchClaudeGetsAMergedMcpConfig(t *testing.T) {
	r := rigWithConnectors(t)
	t.Setenv("HOME", t.TempDir())
	// ARGS: --settings S --model M --mcp-config P -p hi  => P is $6
	bin := fakeLaunchTool(t, r, "claude", "2.1.317 (Claude Code)", 0, nil, []string{"$6"})
	o := r.opts("-p", "hi")
	o.claudeBin, o.model = bin, "gw-model"
	if err := launchClaude(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	rec := r.recorded(t)
	assertConnectorsIn(t, rec, r, "--mcp-config ", `"mcpServers"`, `"type":"http"`, `"Authorization":"Bearer gl-`)
	if strings.Contains(rec, "--strict-mcp-config") {
		t.Errorf("--strict-mcp-config would drop the user's own MCP servers:\n%s", rec)
	}
}

func TestLaunchOpencodeGetsTheConnectorsInItsConfigLayer(t *testing.T) {
	r := rigWithConnectors(t)
	r.baseEnv = append(r.baseEnv, "HOME="+t.TempDir())
	if err := launchOpencode(context.Background(), r.opts()); err != nil {
		t.Fatal(err)
	}
	rec := r.recorded(t)
	assertConnectorsIn(t, rec, r, `"mcp":{"cerea-connectors":`, `"type":"remote"`, `"Authorization":"Bearer gl-`)
}

func TestLaunchGooseGetsTheConnectorsExtension(t *testing.T) {
	r := rigWithConnectors(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	bin := fakeLaunchTool(t, r, "goose", "goose "+packaging.GooseVersion(), 0, nil, []string{"$GOOSE_PATH_ROOT/config/config.yaml"})
	o := r.opts("session")
	o.gooseBin, o.model = bin, "gw-model"
	if err := launchGoose(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	assertConnectorsIn(t, r.recorded(t), r, "extensions:", "streamable_http", "Authorization: Bearer gl-", "GOOSE_MODE: approve")
}

func TestLaunchVibeGetsTheConnectorsServer(t *testing.T) {
	r := rigWithConnectors(t)
	t.Setenv("HOME", t.TempDir())
	bin := fakeLaunchTool(t, r, "vibe", "vibe "+packaging.VibeVersion(), 0, nil, []string{"$VIBE_HOME/config.toml"})
	o := r.opts()
	o.vibeBin, o.model = bin, "gw-model"
	if err := launchVibe(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	assertConnectorsIn(t, r.recorded(t), r, "[[mcp_servers]]", `transport = "streamable-http"`, `Authorization = "Bearer gl-`)
}

func TestLaunchConnectorsFailureDoesNotStopTheLaunch(t *testing.T) {
	// an unreadable mcp.json path from the environment is a warning, not an error
	r := newLaunchRig(t, 0, "x")
	t.Setenv("GALOPIN_MCP_CONFIG", filepath.Join(t.TempDir(), "missing.json"))
	t.Setenv("HOME", t.TempDir())
	bin := fakeLaunchTool(t, r, "claude", "2", 0, nil, nil)
	o := r.opts()
	o.claudeBin, o.model = bin, "m"
	if err := launchClaude(context.Background(), o); err != nil {
		var ee exitError
		if errors.As(err, &ee) {
			t.Fatalf("exit %d", ee.code)
		}
		t.Fatal(err)
	}
	if !strings.Contains(r.stderrBuf.String(), "this computer's connectors are not offered") {
		t.Errorf("no warning:\n%s", r.stderrBuf.String())
	}
}
