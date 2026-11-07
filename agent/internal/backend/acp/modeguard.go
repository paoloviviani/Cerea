package acp

// The ask-skipping modes of an agent that has them (goose: auto, smart_approve)
// must not be reachable: galopin's Plan / Ask / Allow words are decided on the
// asks the agent raises, so a mode in which it stops asking would walk around
// them (ADR 0110). Config.HiddenModes names those modes and Config.ForceMode
// the one a session is put back in.

import (
	"context"
	"fmt"
	"slices"

	"galopin/internal/backend"
)

func (b *Backend) modeHidden(id string) bool {
	return id != "" && slices.Contains(b.cfg.HiddenModes, id)
}

// visibleModes drops the hidden modes from an advertised list.
func (b *Backend) visibleModes(modes []backend.Mode) []backend.Mode {
	if len(b.cfg.HiddenModes) == 0 {
		return modes
	}
	out := make([]backend.Mode, 0, len(modes))
	for _, m := range modes {
		if !b.modeHidden(m.ID) {
			out = append(out, m)
		}
	}
	return out
}

// assertMode puts a session that reports a hidden mode back in ForceMode. It
// returns the mode the session is now in as far as galopin knows.
func (b *Backend) assertMode(ctx context.Context, sessionID, current string) string {
	if b.cfg.ForceMode == "" || !b.modeHidden(current) {
		return current
	}
	conn, err := b.currentConn()
	if err != nil {
		return current
	}
	callCtx, cancel := context.WithTimeout(ctx, rpcCallTimeout)
	defer cancel()
	if _, err := conn.call(callCtx, "session/set_mode", map[string]any{"sessionId": sessionID, "modeId": b.cfg.ForceMode}); err != nil {
		b.cfg.Logf("acp: re-asserting mode %q on a session in %q: %v", b.cfg.ForceMode, current, err)
		return current
	}
	b.cfg.Logf("acp: a session was in mode %q, which skips asks: set back to %q", current, b.cfg.ForceMode)
	return b.cfg.ForceMode
}

// waitReasserted blocks until a pending put-back of a hidden mode on st has
// finished, and refuses an allow if the session is still in such a mode: an
// answer given while the agent could be running without asking is the walk-around
// the guard exists to prevent. A reject is always fine.
func (b *Backend) waitReasserted(ctx context.Context, st *sessionState, decision backend.Decision) error {
	st.mu.Lock()
	done := st.reasserting
	st.mu.Unlock()
	if done != nil {
		select {
		case <-done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	st.mu.Lock()
	mode := st.modeID
	st.mu.Unlock()
	if decision != backend.DecisionReject && b.modeHidden(mode) {
		return fmt.Errorf("acp: the session is in mode %q, which skips asks, and could not be put back; not answering", mode)
	}
	return nil
}
