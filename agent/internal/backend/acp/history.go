package acp

import (
	"context"
	"fmt"

	"galopin/internal/backend"
)

var _ backend.HistoryPager = (*Backend)(nil)

// maxReplayedSessions bounds how many sessions keep a replayed transcript in
// memory at once. ACP has no paged read: a history is fetched whole with
// session/load, so galopin keeps that replay and pages it itself
// (History, and the limit trim session.sync applies for a HistoryPager). Past
// the bound the least recently opened idle replay is dropped and a later open
// replays it again.
const maxReplayedSessions = 8

// History serves one older page of a session's transcript from the replay
// held in memory (PROTOCOL.md §6 session.history): the newest limit messages
// strictly older than before, oldest first. A session not held yet is opened
// (session/load) first. A cursor the transcript no longer has is an empty page.
func (b *Backend) History(ctx context.Context, workspaceDir, sessionID, before string, limit int) (backend.HistoryPage, error) {
	if before == "" {
		return backend.HistoryPage{}, fmt.Errorf("history needs the message id to page below")
	}
	if limit < 1 {
		return backend.HistoryPage{}, fmt.Errorf("history needs a positive limit")
	}
	if _, err := b.Transcript(ctx, workspaceDir, sessionID); err != nil {
		return backend.HistoryPage{}, err
	}
	st, ok := b.reg.get(sessionID)
	if !ok {
		return backend.HistoryPage{}, nil
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	idx, ok := st.msgIndex[before]
	if !ok || idx == 0 {
		return backend.HistoryPage{}, nil
	}
	start := idx - limit
	if start < 0 {
		start = 0
	}
	entries := make([]backend.TranscriptEntry, 0, idx-start)
	for _, e := range st.messages[start:idx] {
		e.Parts = append([]backend.Part(nil), e.Parts...)
		entries = append(entries, e)
	}
	page := backend.HistoryPage{Entries: entries, HasMore: start > 0}
	if len(entries) > 0 {
		page.Before = entries[0].Message.ID
	}
	return page, nil
}

// trimReplays drops the replayed transcripts beyond maxReplayedSessions,
// oldest open first, never one that is running a turn, has an ask pending, or
// was created here (its transcript exists nowhere else).
func (b *Backend) trimReplays(keep string) {
	b.replayMu.Lock()
	defer b.replayMu.Unlock()
	order := b.replayOrder[:0]
	for _, id := range b.replayOrder {
		if id != keep {
			order = append(order, id)
		}
	}
	order = append(order, keep)
	for len(order) > maxReplayedSessions {
		victim := order[0]
		order = order[1:]
		st, ok := b.reg.get(victim)
		if !ok {
			continue
		}
		st.mu.Lock()
		if st.busy || len(st.pending) > 0 || !st.replayed {
			st.mu.Unlock()
			continue
		}
		st.messages, st.todos = nil, nil
		st.msgIndex, st.partIndex, st.partOwner = map[string]int{}, map[string]int{}, map[string]int{}
		st.loaded, st.replayed, st.active = false, false, false
		st.mu.Unlock()
	}
	b.replayOrder = order
}
