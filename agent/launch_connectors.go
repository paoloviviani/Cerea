package main

// Connectors in `galopin launch` (backlog G20). Every launched tool gets one
// extra MCP server, "cerea-connectors", in its TEMPORARY config: a loopback
// endpoint served by this launch process, with a per-launch bearer secret (never
// the machine's long-lived one) that dies with the launch.
//
// What it offers:
//   - this computer's own connectors (mcp.json), run in-process; and
//   - the user's Cerea connectors. Those are fetched over the machine link, which
//     only a running 'galopin run' (or the service) holds: launch does not dial
//     Cerea. So when one runs, the launch forwards to ITS local-agents endpoint
//     (using the long-lived secret from local-agents.json, which stays in this
//     process) and keeps only the tools that come from Cerea. Cerea's own switch
//     ("Apps on my computers may use these connectors too") decides what that
//     endpoint offers: switched off, it offers none.
//
// The endpoint is its own loopback listener (ephemeral port) rather than a route
// on the proxy: a proxy that 'galopin run' already holds belongs to another
// process, and this works the same whichever process serves the proxy.
//
// Calls are convenience, not enforcement: the launched tool's own approval rules
// apply and no Plan/Ask/Allow or review log does.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"galopin/internal/localmcp"
	"galopin/internal/mcpconn"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"gopkg.in/yaml.v3"
)

// connectorsServerName is the MCP server's name in each tool's temporary config.
const connectorsServerName = "cerea-connectors"

// cereaToolMarker is in the description of every tool that comes from Cerea (see
// localAgentSource.Tools); the launch uses it to pick those out of a running
// galopin's endpoint, which may also list this computer's own connectors.
const cereaToolMarker = ", from Cerea) "

// launchConnectors is the endpoint a launch serves for the tool's lifetime.
type launchConnectors struct {
	URL    string
	Secret string
	// Summary is the one stderr line saying whether connectors are available.
	Summary string
	stop    func()
}

func (c *launchConnectors) close() {
	if c != nil && c.stop != nil {
		c.stop()
	}
}

// bearerTransport adds the endpoint's secret to every request.
type bearerTransport struct{ secret string }

func (b bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.secret)
	return http.DefaultTransport.RoundTrip(r)
}

// upstreamEndpoint is a running galopin's local-agents endpoint.
type upstreamEndpoint struct{ url, secret string }

func (u upstreamEndpoint) connect(ctx context.Context) (*mcp.ClientSession, error) {
	client := mcp.NewClient(&mcp.Implementation{Name: "galopin launch", Version: agentVersion}, nil)
	return client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:   u.url,
		HTTPClient: &http.Client{Transport: bearerTransport{u.secret}, Timeout: 5 * time.Minute},
	}, nil)
}

// launchSource implements localmcp.Source over this computer's connectors and
// the Cerea ones a running galopin forwards.
type launchSource struct {
	local    *localAgentSource
	upstream *upstreamEndpoint // nil: no running galopin to forward to

	mu        sync.Mutex
	routes    map[string]string // name offered -> the upstream's name
	upstreamE error             // last failure listing the upstream
	cerea     int
	localN    int
}

func (s *launchSource) Tools(ctx context.Context) []localmcp.Tool {
	out := s.local.Tools(ctx)
	taken := map[string]bool{}
	for _, t := range out {
		taken[t.Name] = true
	}
	routes := map[string]string{}
	var upErr error
	cerea := 0
	if s.upstream != nil {
		lctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		sess, err := s.upstream.connect(lctx)
		if err == nil {
			var tools []*mcp.Tool
			for t, lerr := range sess.Tools(lctx, nil) {
				if lerr != nil {
					err = lerr
					break
				}
				tools = append(tools, t)
			}
			_ = sess.Close()
			for _, t := range tools {
				if !strings.Contains(t.Description, cereaToolMarker) {
					continue
				}
				name := t.Name
				for n := 2; taken[name]; n++ {
					name = fmt.Sprintf("%s_%d", t.Name[:min(len(t.Name), 58)], n)
				}
				taken[name] = true
				routes[name] = t.Name
				schema, _ := json.Marshal(t.InputSchema)
				out = append(out, localmcp.Tool{Name: name, Description: t.Description, Schema: schema})
				cerea++
			}
		}
		cancel()
		upErr = err
	}
	s.mu.Lock()
	s.routes, s.upstreamE, s.cerea, s.localN = routes, upErr, cerea, len(out)-cerea
	s.mu.Unlock()
	return out
}

func (s *launchSource) Call(ctx context.Context, name string, args json.RawMessage) (string, error) {
	s.mu.Lock()
	up, ok := s.routes[name]
	s.mu.Unlock()
	if !ok {
		return s.local.Call(ctx, name, args)
	}
	sess, err := s.upstream.connect(ctx)
	if err != nil {
		return "", errors.New("the Cerea connectors are unavailable: galopin run (or the service) is not answering")
	}
	defer sess.Close()
	var a map[string]any
	if len(args) > 0 {
		_ = json.Unmarshal(args, &a)
	}
	res, err := sess.CallTool(ctx, &mcp.CallToolParams{Name: up, Arguments: a})
	if err != nil {
		return "", err
	}
	var text []string
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			text = append(text, tc.Text)
		}
	}
	if res.IsError {
		return "", errors.New(strings.Join(text, "\n"))
	}
	return strings.Join(text, "\n"), nil
}

// summary is the one stderr line, from the last Tools listing.
func (s *launchSource) summary() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	own := fmt.Sprintf("%d from this computer", s.localN)
	switch {
	case s.upstream == nil:
		return "connectors: " + own + "; none from Cerea (they need 'galopin run' or the service running and linked to Cerea)"
	case s.upstreamE != nil:
		return "connectors: " + own + "; none from Cerea ('galopin run' or the service is not answering)"
	case s.cerea == 0:
		return "connectors: " + own + "; none from Cerea (the switch \"Apps on my computers may use these connectors too\" is off, none are chosen in Workspace, Agents, or this computer is not linked right now)"
	}
	return fmt.Sprintf("connectors: %d from Cerea, %s", s.cerea, own)
}

// startLaunchConnectors serves the endpoint on a free loopback port. A failure
// is not fatal to the launch: it returns nil and the tool starts without
// connectors, with the reason on stderr.
func (ls *launchSession) startLaunchConnectors(ctx context.Context) *launchConnectors {
	secret, err := newLaunchSecret()
	if err != nil {
		ls.logf("connectors: not available (%v)", err)
		return nil
	}
	src := &launchSource{local: &localAgentSource{}}
	var hub *mcpconn.Hub
	if path, _, perr := resolveMcpConfig("", os.Getenv, ls.stateDir); perr != nil {
		ls.logf("warning: %v: this computer's connectors are not offered", perr)
	} else if _, serr := os.Stat(path); serr == nil {
		hub = mcpconn.New(mcpconn.Config{
			Path: path, StateDir: ls.stateDir, Lookup: os.LookupEnv,
			Logf:         func(f string, a ...any) { ls.logf(f, a...) },
			LocalExclude: map[string]bool{browserConnectorName: true},
		})
		src.local.hub = hub
	}
	if cfg, ok := readLocalAgentsConfig(ls.stateDir); ok {
		src.upstream = &upstreamEndpoint{url: cfg.URL(), secret: cfg.Secret}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		ls.logf("connectors: not available (%v)", err)
		if hub != nil {
			hub.Shutdown()
		}
		return nil
	}
	mux := http.NewServeMux()
	mux.Handle(localmcp.Path, localmcp.Handler(secret, src, agentVersion))
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	lctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	src.Tools(lctx)
	cancel()
	ls.logf("%s", src.summary())
	return &launchConnectors{
		URL:     fmt.Sprintf("http://%s%s", ln.Addr().String(), localmcp.Path),
		Secret:  secret,
		Summary: src.summary(),
		stop: func() {
			sctx, c := context.WithTimeout(context.Background(), 3*time.Second)
			defer c()
			_ = srv.Shutdown(sctx)
			_ = srv.Close()
			if hub != nil {
				hub.Shutdown()
			}
		},
	}
}

// --- per-tool temporary config ------------------------------------------------

// claudeMcpConfigJSON is the --mcp-config file: Claude Code merges it with the
// user's own MCP servers (galopin never passes --strict-mcp-config).
func claudeMcpConfigJSON(c *launchConnectors) ([]byte, error) {
	return json.Marshal(map[string]any{"mcpServers": map[string]any{
		connectorsServerName: map[string]any{
			"type": "http", "url": c.URL,
			"headers": map[string]string{"Authorization": "Bearer " + c.Secret},
		},
	}})
}

// addOpencodeMcp puts the endpoint in the OPENCODE_CONFIG_CONTENT layer of env.
func addOpencodeMcp(env []string, c *launchConnectors) ([]string, error) {
	const name = "OPENCODE_CONFIG_CONTENT="
	content := map[string]any{}
	idx := -1
	for i, kv := range env {
		if strings.HasPrefix(kv, name) {
			idx = i
			if err := json.Unmarshal([]byte(strings.TrimPrefix(kv, name)), &content); err != nil {
				return nil, fmt.Errorf("reading opencode's config layer: %w", err)
			}
		}
	}
	content["mcp"] = deepSet(content["mcp"], connectorsServerName, "type", "remote")
	content["mcp"] = deepSet(content["mcp"], connectorsServerName, "url", c.URL)
	content["mcp"] = deepSet(content["mcp"], connectorsServerName, "headers", "Authorization", "Bearer "+c.Secret)
	body, err := json.Marshal(content)
	if err != nil {
		return nil, err
	}
	if idx < 0 {
		return append(env, name+string(body)), nil
	}
	env[idx] = name + string(body)
	return env, nil
}

// gooseLaunchExtensionYAML is the extensions block appended to the temporary
// config.yaml.
func gooseLaunchExtensionYAML(c *launchConnectors) (string, error) {
	ext := newGooseExt(c.URL, c.Secret)
	body, err := yaml.Marshal(map[string]any{gooseKeyExtensions: map[string]any{gooseExtKey: ext}})
	return string(body), err
}

// vibeConnectorsTOML is the [[mcp_servers]] table appended to the temporary
// config.toml (Vibe's streamable-http MCP transport).
func vibeConnectorsTOML(c *launchConnectors) string {
	return "\n[[mcp_servers]]\n" +
		"name = " + tomlString(strings.ReplaceAll(connectorsServerName, "-", "_")) + "\n" +
		"transport = \"streamable-http\"\n" +
		"url = " + tomlString(c.URL) + "\n" +
		"headers = { Authorization = " + tomlString("Bearer "+c.Secret) + " }\n"
}
