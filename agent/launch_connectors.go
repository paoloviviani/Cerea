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
	"crypto/hmac"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
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

// upstreamCacheTTL is how long the Cerea tool list of the running galopin is
// reused: tools/list arrives with every request of the tool, and each one would
// otherwise cost a round trip over the machine link.
var upstreamCacheTTL = 5 * time.Second

// launchConnectors is the endpoint a launch serves for the tool's lifetime.
type launchConnectors struct {
	URL    string
	Secret string
	src    *launchSource
	stop   func()
	cancel context.CancelFunc
	ready  chan struct{} // closed when the first listing (and its stderr line) is done
}

// Summary is the one-line state of the connectors once the first listing is
// done ("" before).
func (c *launchConnectors) Summary() string {
	if c == nil {
		return ""
	}
	select {
	case <-c.ready:
		return c.src.summary()
	default:
		return ""
	}
}

// close stops the endpoint. It gives a listing still in flight a moment to
// finish, so its line is not lost when a tool exits at once.
func (c *launchConnectors) close() {
	if c == nil {
		return
	}
	select {
	case <-c.ready:
	case <-time.After(2 * time.Second):
	}
	c.cancel()
	if c.stop != nil {
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

var errUpstreamNotOurs = errors.New("the local-agents port is not answered by this machine's galopin")

// verify is the whoami challenge: a nonce goes out, the proof that comes back
// must be the HMAC only the holder of the secret can compute. The secret itself
// is never sent, so a process that merely listens on the port learns nothing.
func (u upstreamEndpoint) verify(ctx context.Context) error {
	base, err := url.Parse(u.url)
	if err != nil {
		return err
	}
	nb := make([]byte, 16)
	if _, err := rand.Read(nb); err != nil {
		return err
	}
	nonce := hex.EncodeToString(nb)
	q := url.Values{"nonce": {nonce}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, (&url.URL{Scheme: base.Scheme, Host: base.Host, Path: localmcp.WhoamiPath, RawQuery: q.Encode()}).String(), nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var out struct {
		Proof string `json:"proof"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&out) != nil ||
		!hmac.Equal([]byte(out.Proof), []byte(localmcp.Proof(u.secret, nonce))) {
		return errUpstreamNotOurs
	}
	return nil
}

func (u upstreamEndpoint) connect(ctx context.Context) (*mcp.ClientSession, error) {
	if err := u.verify(ctx); err != nil {
		return nil, err
	}
	return u.dial(ctx)
}

// dial connects without the challenge (the launch's own endpoint, in tests, has
// no whoami route).
func (u upstreamEndpoint) dial(ctx context.Context) (*mcp.ClientSession, error) {
	client := mcp.NewClient(&mcp.Implementation{Name: "galopin launch", Version: agentVersion}, nil)
	return client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:   u.url,
		HTTPClient: &http.Client{Transport: bearerTransport{u.secret}, Timeout: 5 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}, nil)
}

// launchSnapshot is one consistent listing: what is on offer and where each
// name goes. It is never modified once built, so concurrent requests cannot
// see a half-swapped map.
type launchSnapshot struct {
	tools  []localmcp.Tool
	routes map[string]string // Cerea tool name offered -> the upstream's name
	cerea  int
	localN int
	upErr  error
	at     time.Time
}

// launchSource implements localmcp.Source over this computer's connectors and
// the Cerea ones a running galopin forwards.
type launchSource struct {
	local    *localAgentSource
	upstream *upstreamEndpoint // nil: no running galopin to forward to

	mu      sync.Mutex
	snap    *launchSnapshot
	buildMu sync.Mutex // one listing at a time: concurrent requests wait for it
}

// current is the listing, rebuilt when older than the cache TTL (or force).
func (s *launchSource) current(ctx context.Context, force bool) *launchSnapshot {
	asked := time.Now()
	get := func() *launchSnapshot {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.snap
	}
	fresh := func(snap *launchSnapshot) bool {
		if snap == nil {
			return false
		}
		if force {
			return snap.at.After(asked) // built while we waited
		}
		return time.Since(snap.at) < upstreamCacheTTL
	}
	if snap := get(); fresh(snap) {
		return snap
	}
	s.buildMu.Lock()
	defer s.buildMu.Unlock()
	if snap := get(); fresh(snap) {
		return snap
	}
	snap := s.build(ctx)
	s.mu.Lock()
	s.snap = snap
	s.mu.Unlock()
	return snap
}

func (s *launchSource) build(ctx context.Context) *launchSnapshot {
	snap := &launchSnapshot{routes: map[string]string{}, at: time.Now()}
	snap.tools = s.local.Tools(ctx)
	snap.localN = len(snap.tools)
	taken := map[string]bool{}
	for _, t := range snap.tools {
		taken[t.Name] = true
	}
	if s.upstream == nil {
		return snap
	}
	lctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	sess, err := s.upstream.connect(lctx)
	if err != nil {
		snap.upErr = err
		return snap
	}
	defer sess.Close()
	for t, lerr := range sess.Tools(lctx, nil) {
		if lerr != nil {
			snap.upErr = lerr
			break
		}
		if t.Meta[localmcp.SourceMetaKey] != localmcp.SourceCerea {
			continue
		}
		name := t.Name
		for n := 2; taken[name]; n++ {
			name = fmt.Sprintf("%s_%d", t.Name[:min(len(t.Name), 58)], n)
		}
		taken[name] = true
		snap.routes[name] = t.Name
		schema, _ := json.Marshal(t.InputSchema)
		snap.tools = append(snap.tools, localmcp.Tool{Name: name, Description: t.Description, Schema: schema, Meta: map[string]any(t.Meta)})
		snap.cerea++
	}
	return snap
}

func (s *launchSource) Tools(ctx context.Context) []localmcp.Tool {
	return s.current(ctx, false).tools
}

func (s *launchSource) Call(ctx context.Context, name string, args json.RawMessage) (string, error) {
	snap := s.current(ctx, false)
	up, ok := snap.routes[name]
	if !ok {
		if _, local := s.localHas(snap, name); !local {
			// a client that listed long ago: rebuild once
			snap = s.current(ctx, true)
			up, ok = snap.routes[name]
		}
	}
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

func (s *launchSource) localHas(snap *launchSnapshot, name string) (string, bool) {
	for _, t := range snap.tools[:snap.localN] {
		if t.Name == name {
			return name, true
		}
	}
	return "", false
}

// summary is the one stderr line, from the last listing.
func (s *launchSource) summary() string {
	s.mu.Lock()
	snap := s.snap
	s.mu.Unlock()
	if snap == nil {
		return ""
	}
	own := fmt.Sprintf("%d from this computer", snap.localN)
	switch {
	case s.upstream == nil:
		return "connectors: " + own + "; none from Cerea (they need 'galopin run' or the service running and linked to Cerea)"
	case errors.Is(snap.upErr, errUpstreamNotOurs):
		return "connectors: " + own + "; none from Cerea (the local-agents port is not answered by this machine's galopin: restart galopin run or the service)"
	case snap.upErr != nil:
		return "connectors: " + own + "; none from Cerea ('galopin run' or the service is not answering)"
	case snap.cerea == 0:
		return "connectors: " + own + "; none from Cerea (the switch \"Apps on my computers may use these connectors too\" is off, none are chosen in Workspace, Agents, or this computer is not linked right now)"
	}
	return fmt.Sprintf("connectors: %d from Cerea, %s", snap.cerea, own)
}

// startLaunchConnectors serves the endpoint on a free loopback port and returns
// at once: the first listing (which may wait on the Cerea link) runs in the
// background and prints the one stderr line when it is done, so the tool never
// waits for it. A failure is not fatal to the launch: it returns nil and the
// tool starts without connectors, with the reason on stderr.
func (ls *launchSession) startLaunchConnectors(ctx context.Context) *launchConnectors {
	secret, err := newLaunchSecret()
	if err != nil {
		ls.logf("connectors: not available (%v)", err)
		return nil
	}
	src := &launchSource{local: &localAgentSource{}}
	cfg, haveCfg := readLocalAgentsConfig(ls.stateDir)
	var hub *mcpconn.Hub
	if cfg.LocalConnectorsOff {
		// 'goose setup --no-connectors' withdrew this computer's own connectors.
	} else if path, _, perr := resolveMcpConfig("", os.Getenv, ls.stateDir); perr != nil {
		ls.logf("warning: %v: this computer's connectors are not offered", perr)
	} else if _, serr := os.Stat(path); serr == nil {
		hub = mcpconn.New(mcpconn.Config{
			Path: path, StateDir: ls.stateDir, Lookup: os.LookupEnv,
			Logf:         func(f string, a ...any) { ls.logf(f, a...) },
			LocalExclude: map[string]bool{browserConnectorName: true},
		})
		src.local.hub = hub
	}
	if haveCfg {
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
	lctx, cancel := context.WithCancel(ctx)
	c := &launchConnectors{
		URL:    fmt.Sprintf("http://%s%s", ln.Addr().String(), localmcp.Path),
		Secret: secret, src: src, cancel: cancel, ready: make(chan struct{}),
		stop: func() {
			sctx, cc := context.WithTimeout(context.Background(), 3*time.Second)
			defer cc()
			_ = srv.Shutdown(sctx)
			_ = srv.Close()
			if hub != nil {
				hub.Shutdown()
			}
		},
	}
	go func() {
		defer close(c.ready)
		tctx, tcancel := context.WithTimeout(lctx, 45*time.Second)
		defer tcancel()
		src.current(tctx, true)
		if lctx.Err() == nil {
			ls.logf("%s", src.summary())
		}
	}()
	return c
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
// config.toml (Vibe's streamable-http MCP transport; the headers live in its [auth] block, as in vibe/core/config/models.py).
func vibeConnectorsTOML(c *launchConnectors) string {
	return "\n[[mcp_servers]]\n" +
		"name = " + tomlString(strings.ReplaceAll(connectorsServerName, "-", "_")) + "\n" +
		"transport = \"streamable-http\"\n" +
		"url = " + tomlString(c.URL) + "\n" +
		"auth = { type = \"static\", headers = { Authorization = " + tomlString("Bearer "+c.Secret) + " } }\n"
}
