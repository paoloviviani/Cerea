// Package localmcp is galopin's stable local MCP endpoint for the user's OWN
// agents (goose Desktop, the goose CLI, an editor extension; ADR 0110, setup):
// one fixed loopback URL with its own bearer secret, serving the connectors the
// user chose to offer local agents. It is not the per-session endpoint the
// engine's sessions get (internal/mcpserve): no Cerea session is behind a call
// here, no Plan / Ask / Allow applies, and the agent's own approval is what
// stands between the model and the tool.
//
// The tool list is built per request from the Source, so a connector added or
// switched off shows on the agent's next list without restarting anything.
package localmcp

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net"
	"net/http"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Path is where the endpoint answers.
const Path = "/local-agents"

// Tool is one tool on offer.
type Tool struct {
	// Name is the name the agent sees (already namespaced and sanitised).
	Name        string
	Description string
	// Schema is an object JSON Schema; nil means "any object".
	Schema json.RawMessage
}

// Source supplies the tools and runs the calls.
type Source interface {
	// Tools is what is on offer right now. An error is an empty list.
	Tools(ctx context.Context) []Tool
	// Call runs one tool; the text is the result. A non-nil error is shown to
	// the model as a tool error with exactly err.Error().
	Call(ctx context.Context, name string, args json.RawMessage) (string, error)
}

// Handler serves Path with the given bearer secret.
func Handler(secret string, src Source, version string) http.Handler {
	want := sha256.Sum256([]byte(secret))
	inner := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		s := mcp.NewServer(&mcp.Implementation{Name: "Cerea connectors", Version: version}, &mcp.ServerOptions{
			Instructions: "Connectors your Cerea account offers local agents, and this machine's own. Calls here are not governed by Cerea's Plan / Ask / Allow: your agent's own approval applies.",
		})
		for _, t := range src.Tools(r.Context()) {
			name := t.Name
			schema := t.Schema
			if len(schema) == 0 {
				schema = json.RawMessage(`{"type":"object"}`)
			}
			s.AddTool(&mcp.Tool{Name: name, Description: t.Description, InputSchema: schema},
				func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
					args := req.Params.Arguments
					if len(args) == 0 {
						args = json.RawMessage(`{}`)
					}
					text, err := src.Call(ctx, name, args)
					if err != nil {
						return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: err.Error()}}}, nil
					}
					return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}, nil
				})
		}
		return s
	}, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !loopbackHost(r.Host) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.URL.Path != Path {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		got := sha256.Sum256([]byte(token))
		if !ok || subtle.ConstantTimeCompare(got[:], want[:]) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		inner.ServeHTTP(w, r)
	})
}

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
