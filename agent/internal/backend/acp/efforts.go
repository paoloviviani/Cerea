package acp

// session.setEffort over ACP: an agent with a thinking-level session option (ACP's
// category "thought_level"; Vibe calls it "thinking") takes the level through
// session/set_config_option, like the model and the mode.

import (
	"context"
	"fmt"
	"slices"
	"time"

	"galopin/internal/backend"
)

// SetEffort implements backend.EffortSetter: effort is a level the session's option
// offers, or "" for the model's default.
func (b *Backend) SetEffort(ctx context.Context, workspaceDir, sessionID, effort string) (backend.Session, error) {
	if !b.cfg.Efforts {
		return backend.Session{}, fmt.Errorf("acp: this agent has no thinking-effort option")
	}
	st, ok := b.reg.get(sessionID)
	if !ok {
		return backend.Session{}, fmt.Errorf("acp: unknown session %q", sessionID)
	}
	st.mu.Lock()
	if st.effortConfigID == "" {
		st.mu.Unlock()
		return backend.Session{}, fmt.Errorf("acp: this session has no thinking-effort option")
	}
	if effort != "" && !slices.Contains(st.effortValues, effort) {
		offered := append([]string(nil), st.effortValues...)
		st.mu.Unlock()
		return backend.Session{}, fmt.Errorf("acp: effort %q is not one of this model's levels %v", effort, offered)
	}
	prev := st.effort
	st.effort = effort
	st.mu.Unlock()
	if err := b.pushEffort(ctx, workspaceDir, st); err != nil {
		st.mu.Lock()
		st.effort = prev
		st.mu.Unlock()
		return backend.Session{}, err
	}
	st.mu.Lock()
	st.updatedAt = time.Now()
	sess := st.toSession(b.ID())
	st.mu.Unlock()
	b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventSession, Session: &sess})
	return sess, nil
}

// effortTarget is the level the agent should be on: the person's choice when this
// model offers it, else the default. "" when there is nothing to set.
func (b *Backend) effortTarget(st *sessionState) string {
	st.mu.Lock()
	defer st.mu.Unlock()
	want := st.effort
	if want != "" && !slices.Contains(st.effortValues, want) {
		// the model changed to one that does not offer it: back to the default
		want, st.effort = "", ""
	}
	if want == "" {
		want = b.cfg.EffortDefault
	}
	if want == "" || !slices.Contains(st.effortValues, want) {
		return ""
	}
	return want
}

// pushEffort sets the session's thinking level to its target if the agent is not on it.
func (b *Backend) pushEffort(ctx context.Context, workspaceDir string, st *sessionState) error {
	target := b.effortTarget(st)
	st.mu.Lock()
	id, now := st.effortConfigID, st.effortNow
	st.mu.Unlock()
	if target == "" || target == now {
		return nil
	}
	conn, err := b.currentConn()
	if err != nil {
		return err
	}
	callCtx, cancel := context.WithTimeout(ctx, rpcCallTimeout)
	defer cancel()
	raw, err := conn.call(callCtx, "session/set_config_option", map[string]any{"sessionId": st.id, "configId": id, "value": target})
	if err != nil {
		return fmt.Errorf("acp: session/set_config_option: %w", err)
	}
	b.applyConfigResult(workspaceDir, st, raw)
	return nil
}

// syncEffort puts a session that was just created, reopened or moved to another model
// on its level (best effort: a failure is logged, the session works on).
func (b *Backend) syncEffort(ctx context.Context, workspaceDir string, st *sessionState) {
	if !b.cfg.Efforts {
		return
	}
	if err := b.pushEffort(ctx, workspaceDir, st); err != nil {
		b.cfg.Logf("acp: setting the thinking level: %v", err)
	}
}

var _ backend.EffortSetter = (*Backend)(nil)
