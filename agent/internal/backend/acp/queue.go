package acp

// Queued follow-ups. ACP cannot fold a prompt into a running turn (no steering), and a
// second session/prompt would clobber the running turn's state, so a prompt that arrives
// while a turn runs is held here and sent, in order, when the turn ends: the Queue
// capability. The whole list is announced as a `queue` event whenever it changes, so a
// client shows what is waiting and can withdraw one (session.dequeue). A Stop clears it.
// The queue lives in memory: a restart of galopin forgets it, as it forgets the turn.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"

	"galopin/internal/backend"
)

// maxQueued bounds the prompts held per session.
const maxQueued = 8

type queuedPrompt struct {
	id     string
	prompt backend.Prompt
}

func (q queuedPrompt) view() backend.QueuedPrompt {
	return backend.QueuedPrompt{ID: q.id, Text: q.prompt.Text, Files: len(q.prompt.Attachments)}
}

// queueViews is the session's queue as the wire shows it (st.mu held).
func queueViews(st *sessionState) []backend.QueuedPrompt {
	out := make([]backend.QueuedPrompt, len(st.queue))
	for i, q := range st.queue {
		out[i] = q.view()
	}
	return out
}

func (b *Backend) emitQueue(workspaceDir, sessionID string, views []backend.QueuedPrompt) {
	b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventQueue, Queued: views})
}

// enqueueLocked holds a prompt that cannot run yet. st.mu is held by the caller and
// released here.
func (b *Backend) enqueueLocked(workspaceDir string, st *sessionState, prompt backend.Prompt) error {
	id := prompt.ClientMessageID
	if id == "" {
		raw := make([]byte, 6)
		_, _ = rand.Read(raw)
		id = "q_" + hex.EncodeToString(raw)
	}
	for _, q := range st.queue {
		if q.id == id { // a retry of one already waiting
			st.mu.Unlock()
			return nil
		}
	}
	if len(st.queue) >= maxQueued {
		st.mu.Unlock()
		return fmt.Errorf("%w: %d messages are already waiting", backend.ErrSessionBusy, maxQueued)
	}
	st.queue = append(st.queue, queuedPrompt{id: id, prompt: prompt})
	views := queueViews(st)
	sessionID := st.id
	st.mu.Unlock()
	b.emitQueue(workspaceDir, sessionID, views)
	st.mu.Lock()
	idle := !st.busy && !st.draining
	st.mu.Unlock()
	if idle {
		// the turn ended between the check and here: nothing else will drain it
		go b.drainQueue(workspaceDir, st)
	}
	return nil
}

// drainQueue sends the oldest waiting prompt now that the turn is over. Taking the head
// and keeping the session reserved (draining) is one critical section, so a prompt that
// arrives meanwhile queues behind instead of overtaking. A prompt that cannot be sent
// (the agent is down) goes back at the front and the drain stops: nothing is discarded.
func (b *Backend) drainQueue(workspaceDir string, st *sessionState) {
	st.mu.Lock()
	if st.busy || st.rewinding || len(st.queue) == 0 {
		st.draining = false
		st.mu.Unlock()
		return
	}
	st.draining = true
	next := st.queue[0]
	st.queue = st.queue[1:]
	views := queueViews(st)
	sessionID := st.id
	st.mu.Unlock()
	b.emitQueue(workspaceDir, sessionID, views)
	if err := b.prompt(context.Background(), workspaceDir, sessionID, next.prompt, true); err != nil {
		st.mu.Lock()
		st.queue = append([]queuedPrompt{next}, st.queue...)
		st.draining = false
		views := queueViews(st)
		st.mu.Unlock()
		b.emitQueue(workspaceDir, sessionID, views)
		b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventError, ErrorMessage: "a queued message could not be sent yet: " + err.Error()})
	}
}

// clearQueue drops everything waiting (the person stopped the turn).
func (b *Backend) clearQueue(workspaceDir string, st *sessionState) {
	st.mu.Lock()
	had := len(st.queue) > 0
	st.queue = nil
	st.draining = false
	sessionID := st.id
	st.mu.Unlock()
	if had {
		b.emitQueue(workspaceDir, sessionID, []backend.QueuedPrompt{})
	}
}

// Dequeue implements backend.Dequeuer.
func (b *Backend) Dequeue(_ context.Context, workspaceDir, sessionID, id string) error {
	st, ok := b.reg.get(sessionID)
	if !ok {
		return backend.ErrNotQueued
	}
	st.mu.Lock()
	idx := -1
	for i, q := range st.queue {
		if q.id == id {
			idx = i
		}
	}
	if idx < 0 {
		st.mu.Unlock()
		return backend.ErrNotQueued
	}
	st.queue = append(st.queue[:idx:idx], st.queue[idx+1:]...)
	views := queueViews(st)
	st.mu.Unlock()
	b.emitQueue(workspaceDir, sessionID, views)
	return nil
}

var _ backend.Dequeuer = (*Backend)(nil)
