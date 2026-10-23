package mcpconn

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"galopin/internal/mcpfake"
)

func TestMain(m *testing.M) {
	if mcpfake.Enabled() {
		mcpfake.Run()
		return
	}
	os.Exit(m.Run())
}

type rigFrame struct {
	channel string
	message json.RawMessage
}

type rigClosed struct {
	channel, reason, detail string
	hasDetail               bool
}

// rig is a hub wired to channels in place of a link.
type rig struct {
	t      *testing.T
	hub    *Hub
	dir    string
	frames chan rigFrame
	closed chan rigClosed

	mu    sync.Mutex
	audit []string
}

func writeConfig(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func newRig(t *testing.T, body string, tweak func(*Config)) *rig {
	t.Helper()
	dir := t.TempDir()
	path := dir + "/mcp.json"
	writeConfig(t, path, body)
	r := &rig{t: t, dir: dir, frames: make(chan rigFrame, 64), closed: make(chan rigClosed, 16)}
	cfg := Config{
		Path: path, StateDir: dir, Logf: t.Logf,
		Lookup: func(k string) (string, bool) { v, ok := map[string]string{"FAKE": "v1"}[k]; return v, ok },
		Audit: func(server, tool, outcome string) {
			r.mu.Lock()
			r.audit = append(r.audit, server+" "+tool+" "+outcome)
			r.mu.Unlock()
		},
		Send: func(ch string, m []byte) error {
			r.frames <- rigFrame{ch, append([]byte(nil), m...)}
			return nil
		},
		Closed: func(ch, reason string, detail *string) {
			c := rigClosed{channel: ch, reason: reason}
			if detail != nil {
				c.detail, c.hasDetail = *detail, true
			}
			r.closed <- c
		},
	}
	if tweak != nil {
		tweak(&cfg)
	}
	r.hub = New(cfg)
	t.Cleanup(r.hub.Shutdown)
	return r
}

func (r *rig) next() rigFrame {
	r.t.Helper()
	select {
	case f := <-r.frames:
		return f
	case <-time.After(5 * time.Second):
		r.t.Fatal("no frame from the hub")
		return rigFrame{}
	}
}

func (r *rig) nextClosed() rigClosed {
	r.t.Helper()
	select {
	case c := <-r.closed:
		return c
	case <-time.After(5 * time.Second):
		r.t.Fatal("no closed frame from the hub")
		return rigClosed{}
	}
}

func (r *rig) auditLines() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.audit...)
}

func (r *rig) open(name string) string {
	r.t.Helper()
	id, err := r.hub.Open(t_ctx(r.t), name)
	if err != nil {
		r.t.Fatalf("open %s: %v", name, err)
	}
	return id
}

// call sends one request and returns the response with the same id.
func (r *rig) call(ch string, id int, method, params string) map[string]json.RawMessage {
	r.t.Helper()
	r.hub.Message(ch, []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":%q,"params":%s}`, id, method, params)))
	for {
		f := r.next()
		var m map[string]json.RawMessage
		if json.Unmarshal(f.message, &m) != nil {
			r.t.Fatalf("frame is not an object: %s", f.message)
		}
		if string(m["id"]) == fmt.Sprint(id) {
			return m
		}
	}
}

// fakeConfig is an mcp.json with one stdio server, "fake", running this
// binary as the fake server in the given mode; extra is more entry keys
// (", \"allowedTools\": [...]").
func fakeConfig(mode, extra string) string {
	return fmt.Sprintf(`{"mcpServers": {"fake": {"command": %q, "env": {"MCPFAKE_SERVER": "1", "MCPFAKE_MODE": %q, "FAKE_VALUE": "${FAKE}"}%s}}}`,
		os.Args[0], mode, extra)
}

func t_ctx(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func osStat(p string) (os.FileInfo, error) { return os.Stat(p) }
