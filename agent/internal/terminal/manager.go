package terminal

import (
	"context"
	"crypto/rand"
	"errors"
	"sync"
	"time"
)

// ErrTooMany is returned by Manager.Open once maxTerminals is already
// reached (PROTOCOL.md §9.3 terminal.open: "invalid" beyond it).
var ErrTooMany = errors.New("terminal: maxTerminals reached")

// ErrNotFound is returned for an unknown terminal id.
var ErrNotFound = errors.New("terminal: not found")

// Manager owns every terminal this machine has open, across workspaces:
// spawning (subject to maxTerminals), lookup, and the lifecycle rules
// (PROTOCOL.md §9.3) — 10-minute exit retention, 24-hour idle reap, and
// closing everything on shutdown or a 4403 revoke.
type Manager struct {
	mu    sync.Mutex
	terms map[string]*Terminal
	order []string // insertion order, for deterministic List()

	idGen func() (string, error)
}

// NewManager builds an empty Manager. idGen mints terminal ids (tests can
// supply a deterministic one); a nil idGen uses a random 16-byte hex id.
func NewManager(idGen func() (string, error)) *Manager {
	if idGen == nil {
		idGen = randomID
	}
	return &Manager{terms: map[string]*Terminal{}, idGen: idGen}
}

// Count reports how many terminals (running or exited-but-retained) exist.
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.terms)
}

// Open spawns a new terminal, refusing once maxTerminals terminals already
// exist (running or still retained after exit).
func (m *Manager) Open(cfg OpenConfig, maxTerminals int) (*Terminal, error) {
	m.mu.Lock()
	if len(m.terms) >= maxTerminals {
		m.mu.Unlock()
		return nil, ErrTooMany
	}
	m.mu.Unlock()

	if cfg.ID == "" {
		id, err := m.idGen()
		if err != nil {
			return nil, err
		}
		cfg.ID = id
	}
	t, err := Open(cfg)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.terms[t.ID] = t
	m.order = append(m.order, t.ID)
	m.mu.Unlock()
	return t, nil
}

// Get looks up a terminal by id.
func (m *Manager) Get(id string) (*Terminal, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.terms[id]
	if !ok {
		return nil, ErrNotFound
	}
	return t, nil
}

// List returns every terminal's snapshot, optionally filtered to one
// workspace, in the order they were opened.
func (m *Manager) List(workspaceID string) []Snapshot {
	m.mu.Lock()
	ids := append([]string(nil), m.order...)
	m.mu.Unlock()
	out := make([]Snapshot, 0, len(ids))
	for _, id := range ids {
		m.mu.Lock()
		t, ok := m.terms[id]
		m.mu.Unlock()
		if !ok {
			continue
		}
		snap := t.Snapshot()
		if workspaceID != "" && snap.WorkspaceID != workspaceID {
			continue
		}
		out = append(out, snap)
	}
	return out
}

// remove drops a terminal from the registry (used once it is fully closed
// and past ExitRetention, or explicitly by tests).
func (m *Manager) remove(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.terms, id)
	for i, existing := range m.order {
		if existing == id {
			m.order = append(m.order[:i], m.order[i+1:]...)
			break
		}
	}
}

// CloseAll closes every terminal (run shutdown, or a 4403 revoke —
// PROTOCOL.md §9.3): SIGHUP to each process group, then SIGKILL after 5s.
func (m *Manager) CloseAll(force bool) {
	m.mu.Lock()
	ts := make([]*Terminal, 0, len(m.terms))
	for _, t := range m.terms {
		ts = append(ts, t)
	}
	m.mu.Unlock()
	for _, t := range ts {
		t.Close(force)
	}
}

// WaitAllClosed blocks until every terminal open at call time has exited, or
// ctx expires — used by tests and by shutdown to confirm the process groups
// are actually gone before returning.
func (m *Manager) WaitAllClosed(ctx context.Context) error {
	m.mu.Lock()
	ts := make([]*Terminal, 0, len(m.terms))
	for _, t := range m.terms {
		ts = append(ts, t)
	}
	m.mu.Unlock()
	for _, t := range ts {
		if err := t.Wait(ctx); err != nil {
			return err
		}
	}
	return nil
}

// StartReaper runs the idle (24h no viewer) and exit-retention (10min)
// sweeps every interval, until ctx is done.
func (m *Manager) StartReaper(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.reapOnce(time.Now())
			}
		}
	}()
}

func (m *Manager) reapOnce(now time.Time) {
	m.mu.Lock()
	ids := append([]string(nil), m.order...)
	m.mu.Unlock()
	for _, id := range ids {
		m.mu.Lock()
		t, ok := m.terms[id]
		m.mu.Unlock()
		if !ok {
			continue
		}
		if t.State() == StateExited {
			if exitedAt := t.ExitedAt(); !exitedAt.IsZero() && now.Sub(exitedAt) > ExitRetention {
				m.remove(id)
			}
			continue
		}
		if idle := t.IdleSince(); !idle.IsZero() && now.Sub(idle) > IdleReapAfter {
			t.Close(false)
		}
	}
}

func randomID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	const hex = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, c := range b {
		out[i*2] = hex[c>>4]
		out[i*2+1] = hex[c&0xf]
	}
	return string(out), nil
}
