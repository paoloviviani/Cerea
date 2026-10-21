// Package mcpserve is galopin's MCP server: the coordination tools offered to
// any MCP-capable agent over streamable HTTP on loopback (PROTOCOL.md §6,
// "Coordination tools over MCP"). It knows nothing about sessions' rules: it
// authenticates a call to ONE session, by that session's own endpoint and
// bearer token, and hands (session, tool, arguments) to the call function the
// machine supplies, which runs the same gates as every other route.
//
// A MCP tools/call carries nothing that names the caller, so identity is
// never read from the request: it is the session a grant was bound to, and a
// token only ever acts as that session.
package mcpserve

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Tool is one tool the server offers.
type Tool struct {
	Name        string
	Description string
	// Schema is the JSON Schema of the arguments (an object schema).
	Schema json.RawMessage
}

// CallFunc runs one tool call as the session. A non-nil error becomes a tool
// error the model reads, with exactly err.Error() as its text; the caller
// decides what a refusal looks like.
type CallFunc func(ctx context.Context, sessionID, tool string, args json.RawMessage) (string, error)

// PathPrefix is where the per-session endpoints live.
const PathPrefix = "/mcp/"

// Server holds the grants and serves their endpoints.
type Server struct {
	tools   []Tool
	call    CallFunc
	version string

	mu     sync.Mutex
	grants map[string]*Grant // endpoint id -> grant
}

// New builds a server offering tools.
func New(tools []Tool, call CallFunc, version string) *Server {
	return &Server{tools: tools, call: call, version: version, grants: map[string]*Grant{}}
}

// Grant is one session's endpoint and token. Mint creates it before the
// session has an id (an ACP agent is told its MCP servers in session/new, which
// is what returns the id): the token authenticates, but no tool runs as anyone
// until Bind names the session.
type Grant struct {
	srv      *Server
	endpoint string
	digest   [sha256.Size]byte // sha256 of the token: the token itself is never kept

	// Token is the bearer secret, returned once by Mint for the agent's own
	// configuration; the server keeps only its digest. Never log it.
	Token string
	// URL is the endpoint, absolute.
	URL string

	mu      sync.Mutex
	session string
	revoked bool
	ctx     context.Context
	cancel  context.CancelFunc
	mcp     *mcp.Server
	handler http.Handler
}

func random(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("mcpserve: no randomness: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// Mint creates a grant. base is the server's own origin ("http://127.0.0.1:port").
func (s *Server) Mint(base string) *Grant {
	g := &Grant{srv: s, endpoint: random(16), Token: random(32)}
	g.digest = sha256.Sum256([]byte(g.Token))
	g.URL = strings.TrimSuffix(base, "/") + PathPrefix + g.endpoint
	g.ctx, g.cancel = context.WithCancel(context.Background())
	g.mcp = mcp.NewServer(&mcp.Implementation{Name: "galopin", Version: s.version}, &mcp.ServerOptions{
		Instructions: "galopin's coordination tools for this session: list, read, spawn and message other sessions on this machine, and manage schedules. Calls may wait for the person's approval.",
	})
	for _, t := range s.tools {
		t := t
		g.mcp.AddTool(&mcp.Tool{Name: t.Name, Description: t.Description, InputSchema: t.Schema},
			func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				return g.run(ctx, t.Name, req.Params.Arguments), nil
			})
	}
	g.handler = mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return g.mcp }, &mcp.StreamableHTTPOptions{})
	s.mu.Lock()
	s.grants[g.endpoint] = g
	s.mu.Unlock()
	return g
}

// Bind names the session the grant acts as. Once; later calls are ignored.
func (g *Grant) Bind(sessionID string) {
	g.mu.Lock()
	if g.session == "" && !g.revoked {
		g.session = sessionID
	}
	g.mu.Unlock()
}

// Session is the bound session, "" before Bind.
func (g *Grant) Session() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.session
}

// Revoke ends the grant: the endpoint stops answering, calls in flight are
// cancelled (a held approval is withdrawn), and the MCP sessions are closed.
func (g *Grant) Revoke() {
	g.mu.Lock()
	if g.revoked {
		g.mu.Unlock()
		return
	}
	g.revoked = true
	g.mu.Unlock()
	g.srv.mu.Lock()
	delete(g.srv.grants, g.endpoint)
	g.srv.mu.Unlock()
	g.cancel()
	for ss := range g.mcp.Sessions() {
		_ = ss.Close()
	}
}

// RevokeSession revokes every grant bound to the session (it ended).
func (s *Server) RevokeSession(sessionID string) {
	s.mu.Lock()
	var doomed []*Grant
	for _, g := range s.grants {
		if g.Session() == sessionID {
			doomed = append(doomed, g)
		}
	}
	s.mu.Unlock()
	for _, g := range doomed {
		g.Revoke()
	}
}

// RevokeAll ends every grant (galopin is stopping).
func (s *Server) RevokeAll() {
	s.mu.Lock()
	all := make([]*Grant, 0, len(s.grants))
	for _, g := range s.grants {
		all = append(all, g)
	}
	s.mu.Unlock()
	for _, g := range all {
		g.Revoke()
	}
}

// Live is how many grants are in force.
func (s *Server) Live() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.grants)
}

var errNotReady = errors.New("this session is not ready yet: galopin has not finished creating it; call the tool again in a moment")

func toolError(text string) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: text}}}
}

func (g *Grant) run(ctx context.Context, tool string, args json.RawMessage) *mcp.CallToolResult {
	g.mu.Lock()
	session, revoked := g.session, g.revoked
	g.mu.Unlock()
	switch {
	case revoked:
		return toolError("this session's galopin endpoint has been closed")
	case session == "":
		return toolError(errNotReady.Error())
	}
	// A revoke cancels the call, whatever the request context says.
	ctx, stop := context.WithCancel(ctx)
	defer stop()
	defer context.AfterFunc(g.ctx, stop)()
	if len(args) == 0 {
		args = json.RawMessage(`{}`)
	}
	out, err := g.srv.call(ctx, session, tool, args)
	if err != nil {
		return toolError(err.Error())
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: out}}}
}

// Handler serves every endpoint under PathPrefix. Every request is
// authenticated: an unknown endpoint, a missing token and a wrong token all
// answer the same bare 401, so the response says nothing about which exist.
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !loopbackHost(r.Host) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		id, ok := strings.CutPrefix(r.URL.Path, PathPrefix)
		if !ok || id == "" || strings.Contains(id, "/") {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		s.mu.Lock()
		g := s.grants[id]
		s.mu.Unlock()
		token, hasBearer := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		got := sha256.Sum256([]byte(token))
		want := [sha256.Size]byte{}
		if g != nil {
			want = g.digest
		}
		// Digests of equal length: the compare leaks nothing about the token.
		if subtle.ConstantTimeCompare(got[:], want[:]) != 1 || g == nil || !hasBearer {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		g.mu.Lock()
		revoked := g.revoked
		g.mu.Unlock()
		if revoked {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		g.handler.ServeHTTP(w, r)
	})
}

// loopbackHost refuses a request whose Host is not a loopback name (a DNS
// rebinding page reaches 127.0.0.1 under its own hostname).
func loopbackHost(host string) bool {
	h, _, err := net.SplitHostPort(host)
	if err != nil {
		h = host
	}
	h = strings.Trim(h, "[]")
	if strings.EqualFold(h, "localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}
