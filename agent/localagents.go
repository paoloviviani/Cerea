package main

// The stable local MCP endpoint for the user's own agents (ADR 0110, `galopin
// goose setup`; internal/localmcp). It serves, as ordinary MCP tools:
//
//   - this machine's own connectors (mcp.json), run in-process; and
//   - the Cerea connectors the user switched on for "local agents" in
//     Workspace, Agents, when galopin is linked to Cerea: listed and called
//     over the link as connector.list / connector.call with source
//     "local-agent", so Cerea's audit log shows them. No Cerea session is behind
//     them and no Plan / Ask / Allow applies: the agent's own approval does.
//
// Without a Cerea link (not paired, or offline) only the local connectors are
// served.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"galopin/internal/link"
	"galopin/internal/localmcp"
	"galopin/internal/mcpconn"
)

const (
	localAgentsFileName    = "local-agents.json"
	defaultLocalAgentsPort = 41970
	localAgentSourceLabel  = "local-agent"
)

// localAgentsConfig is the endpoint's address and secret, written once (by
// 'galopin goose setup' or the first run) and then stable.
type localAgentsConfig struct {
	Port   int    `json:"port"`
	Secret string `json:"secret"`
}

func (c localAgentsConfig) URL() string {
	return fmt.Sprintf("http://127.0.0.1:%d%s", c.Port, localmcp.Path)
}

// ensureLocalAgentsConfig reads <stateDir>/local-agents.json, creating it (0600)
// with a free port and a fresh secret when it is absent.
func ensureLocalAgentsConfig(stateDir string) (localAgentsConfig, error) {
	path := filepath.Join(stateDir, localAgentsFileName)
	if body, err := os.ReadFile(path); err == nil {
		var c localAgentsConfig
		if json.Unmarshal(body, &c) == nil && c.Port > 0 && c.Secret != "" {
			return c, nil
		}
	}
	port := 0
	for p := defaultLocalAgentsPort; p < defaultLocalAgentsPort+100; p++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			_ = ln.Close()
			port = p
			break
		}
	}
	if port == 0 {
		return localAgentsConfig{}, fmt.Errorf("no free port near %d for the local agents endpoint", defaultLocalAgentsPort)
	}
	secret, err := randomHex(32)
	if err != nil {
		return localAgentsConfig{}, err
	}
	c := localAgentsConfig{Port: port, Secret: secret}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return c, err
	}
	body, _ := json.MarshalIndent(c, "", "  ")
	if err := writeFileAtomic(path, append(body, '\n'), 0o600); err != nil {
		return c, err
	}
	return c, nil
}

// localAgentSource implements localmcp.Source.
type localAgentSource struct {
	hub   *mcpconn.Hub
	calls func() machineCaller // nil result: no Cerea link

	mu    sync.Mutex
	index map[string]localAgentTool // name offered -> where it goes
}

type localAgentTool struct {
	cerea     bool
	connector string // Cerea's connector key, or the local server's name
	tool      string
}

var nonNameChar = func(r rune) bool {
	return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-')
}

// toolName is the name offered to the agent: connector and tool joined, only
// characters every model API accepts, at most 64.
func toolName(connector, tool string) string {
	clean := func(s string) string {
		return strings.Map(func(r rune) rune {
			if nonNameChar(r) {
				return '_'
			}
			return r
		}, s)
	}
	name := clean(connector) + "-" + clean(tool)
	if len(name) > 64 {
		sum := sha256.Sum256([]byte(connector + "\x00" + tool))
		name = name[:55] + "-" + hex.EncodeToString(sum[:])[:8]
	}
	return name
}

func (s *localAgentSource) Tools(ctx context.Context) []localmcp.Tool {
	var out []localmcp.Tool
	index := map[string]localAgentTool{}
	add := func(t localmcp.Tool, to localAgentTool) {
		for n := 2; ; n++ {
			if _, taken := index[t.Name]; !taken {
				break
			}
			t.Name = fmt.Sprintf("%s_%d", toolName(to.connector, to.tool)[:min(len(toolName(to.connector, to.tool)), 58)], n)
		}
		index[t.Name] = to
		out = append(out, t)
	}
	if s.hub != nil {
		for _, v := range s.hub.List() {
			if v.State != mcpconn.StateReady {
				continue
			}
			tools, err := s.hub.LocalTools(ctx, v.Name)
			if err != nil {
				logf("local agents: %s: %v", v.Name, err)
				continue
			}
			for _, t := range tools {
				add(localmcp.Tool{Name: toolName(v.Name, t.Name), Description: "(" + v.Name + ", on this machine) " + t.Description, Schema: t.InputSchema},
					localAgentTool{connector: v.Name, tool: t.Name})
			}
		}
	}
	if mc := s.cereaCaller(); mc != nil {
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		raw, operr := mc.Call(cctx, link.Call{Op: connectorFamily + ".list", Args: map[string]any{"source": localAgentSourceLabel}, Timeout: 30 * time.Second})
		cancel()
		if operr == nil {
			var l connectorList
			if json.Unmarshal(raw, &l) == nil {
				for _, c := range l.Connectors {
					for _, t := range c.Tools {
						add(localmcp.Tool{Name: toolName(c.Name, t.Name), Description: "(" + c.Name + ", from Cerea) " + t.Description, Schema: t.InputSchema},
							localAgentTool{cerea: true, connector: c.ID, tool: t.Name})
					}
				}
			}
		}
	}
	s.mu.Lock()
	s.index = index
	s.mu.Unlock()
	return out
}

func (s *localAgentSource) cereaCaller() machineCaller {
	if s.calls == nil {
		return nil
	}
	mc := s.calls()
	if mc == nil || !mc.Supports(connectorFamily) {
		return nil
	}
	return mc
}

func (s *localAgentSource) Call(ctx context.Context, name string, args json.RawMessage) (string, error) {
	s.mu.Lock()
	to, ok := s.index[name]
	s.mu.Unlock()
	if !ok {
		// A client that never listed (or listed long ago): rebuild once.
		s.Tools(ctx)
		s.mu.Lock()
		to, ok = s.index[name]
		s.mu.Unlock()
		if !ok {
			return "", fmt.Errorf("no tool %q: it may have been switched off", name)
		}
	}
	if !to.cerea {
		if s.hub == nil {
			return "", errors.New("this machine has no connectors")
		}
		res, err := s.hub.LocalCall(ctx, to.connector, to.tool, args, connectorCallLimit)
		if err != nil {
			return "", err
		}
		text := clip(contentText(res.Content), maxConnectorResult)
		if res.IsError {
			return "", fmt.Errorf("the tool reported an error: %s", text)
		}
		return text, nil
	}
	mc := s.cereaCaller()
	if mc == nil {
		return "", errors.New("this machine is not linked to Cerea right now, so its connectors are unavailable")
	}
	raw, operr := mc.Call(ctx, link.Call{
		Op:      connectorFamily + ".call",
		Args:    map[string]any{"source": localAgentSourceLabel, "connector": to.connector, "tool": to.tool, "arguments": args},
		Timeout: connectorCallLimit,
	})
	if operr != nil {
		return "", errors.New(operr.Message)
	}
	var r struct {
		IsError bool   `json:"isError"`
		Text    string `json:"text"`
	}
	if json.Unmarshal(raw, &r) != nil {
		return "", errors.New("Cerea's answer was not readable")
	}
	text := clip(r.Text, maxConnectorResult)
	if r.IsError {
		return "", fmt.Errorf("the tool reported an error: %s", text)
	}
	return text, nil
}

// startLocalAgentEndpoint serves the endpoint until ctx ends. A missing or busy
// port is logged, not fatal: the rest of galopin does not depend on it.
func startLocalAgentEndpoint(ctx context.Context, stateDir string, src *localAgentSource) {
	cfg, err := ensureLocalAgentsConfig(stateDir)
	if err != nil {
		logf("local agents endpoint not started: %v", err)
		return
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", cfg.Port))
	if err != nil {
		logf("local agents endpoint not started: port %d: %v (edit or delete %s to pick another)", cfg.Port, err, filepath.Join(stateDir, localAgentsFileName))
		return
	}
	mux := http.NewServeMux()
	mux.Handle(localmcp.Path, localmcp.Handler(cfg.Secret, src, agentVersion))
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logf("local agents endpoint stopped: %v", err)
		}
	}()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	logf("local agents endpoint on %s (for 'galopin goose setup')", cfg.URL())
}
