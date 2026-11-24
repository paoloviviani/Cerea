package acp

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"galopin/internal/backend"
)

// BeforeSession runs with the workspace right before every session/new and
// session/load, and calls that open sessions never overlap it.
func TestBeforeSessionRunsBeforeEachOpen(t *testing.T) {
	var mu sync.Mutex
	var order []string
	b, fa := newTestBackendCfg(t, false, func(c *Config) {
		c.BeforeSession = func(dir string) {
			mu.Lock()
			order = append(order, "before:"+dir)
			mu.Unlock()
		}
	})
	fa.hook = func(fa *fakeAgent, _ json.RawMessage, method string, _ map[string]any) bool {
		if method == "session/new" || method == "session/load" {
			mu.Lock()
			order = append(order, method)
			mu.Unlock()
		}
		return false
	}
	ctx := context.Background()
	if _, err := b.CreateSession(ctx, "/w1", backend.CreateSessionOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.CreateSession(ctx, "/w2", backend.CreateSessionOptions{}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{"before:/w1", "session/new", "before:/w2", "session/new"}
	if len(order) != len(want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("order = %v, want %v", order, want)
		}
	}
}

// An agent that takes HTTP MCP servers without saying so (Vibe) still gets galopin's.
func TestMCPHTTPOverrideEnablesToolsForAnAgentThatDoesNotAdvertiseIt(t *testing.T) {
	b, _ := newTestBackendCfg(t, false, func(c *Config) { c.Tools = true; c.MCPHTTP = true })
	if !b.MCPCapable() {
		t.Fatal("MCPHTTP did not make the backend MCP-capable")
	}
	b2, _ := newTestBackendCfg(t, false, func(c *Config) { c.Tools = true })
	if b2.MCPCapable() {
		t.Fatal("capable without the agent saying so or the override")
	}
}
