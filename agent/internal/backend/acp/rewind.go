package acp

// Revert, fork and subagents for an agent that has them over ACP extensions (Mistral Vibe
// 3.1.3), checked against the live agent:
//
//   - _rewind/to {sessionId, messageId, restoreFiles} rolls the session back in place to just
//     before a user message (it and everything after leave the history; the files the later
//     turns changed are restored). It answers {messageContent, restoredPaths, restoreErrors}.
//     There is no undo: Revert is offered without Unrevert. _rewind/preview {sessionId,
//     messageId} answers the paths a rewind would restore.
//   - session/fork {sessionId, cwd, message_id} copies the history before a user message into
//     a new session (no message_id: all of it). The id must be a user message's.
//   - a subagent is a tool call of kind "think" whose _meta has effect_kind "subagent", agent,
//     task and, once it exists, child_session_id; the child cannot be loaded on its own, so it
//     is a session of galopin's own with the task and, when the agent reports it, the answer.
//
// The ids Cerea names are galopin's; the agent's own entry id for a user message arrives in the
// echo of the prompt (live) or is the message id itself (a replayed history).

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"galopin/internal/backend"
)

// entryIDLocked is the agent's id for one of the session's user messages (st.mu held).
func (st *sessionState) entryIDLocked(msgID string) (string, error) {
	if id, ok := st.entryIDs[msgID]; ok {
		return id, nil
	}
	if _, ok := st.msgIndex[msgID]; !ok {
		return "", fmt.Errorf("acp: no such message %q in this session", msgID)
	}
	if strings.HasPrefix(msgID, st.id+":t") {
		return "", fmt.Errorf("acp: the agent has not named that message yet")
	}
	return msgID, nil // a replayed message carries the agent's own id
}

// Revert implements backend.Reverter over the agent's rewind.
func (b *Backend) Revert(ctx context.Context, workspaceDir, sessionID, messageID string) error {
	if !b.cfg.Rewind {
		return fmt.Errorf("acp: this agent cannot roll a session back")
	}
	st, ok := b.reg.get(sessionID)
	if !ok {
		return fmt.Errorf("acp: unknown session %q", sessionID)
	}
	if err := b.openSession(ctx, workspaceDir, st, true); err != nil {
		return err
	}
	st.mu.Lock()
	if st.busy || st.draining {
		st.mu.Unlock()
		return backend.ErrSessionBusy
	}
	entry, err := st.entryIDLocked(messageID)
	st.mu.Unlock()
	if err != nil {
		return err
	}
	conn, err := b.currentConn()
	if err != nil {
		return err
	}
	callCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	raw, err := conn.call(callCtx, "_rewind/to", map[string]any{"sessionId": sessionID, "messageId": entry, "restoreFiles": true})
	if err != nil {
		return fmt.Errorf("acp: rewind: %w", err)
	}
	var res struct {
		RestoreErrors []any `json:"restoreErrors"`
	}
	_ = json.Unmarshal(raw, &res)
	if len(res.RestoreErrors) > 0 {
		b.cfg.Logf("acp: rewind restored the history but %d file(s) could not be restored", len(res.RestoreErrors))
	}
	st.mu.Lock()
	st.truncateFromLocked(messageID)
	st.queue = nil
	st.mu.Unlock()
	return nil
}

// Unrevert implements backend.Reverter: the agent's rewind cannot be undone.
func (b *Backend) Unrevert(context.Context, string, string) error {
	return backend.ErrUnrevertUnsupported
}

// RewindPreview is the workspace paths a rewind to messageID would restore.
func (b *Backend) RewindPreview(ctx context.Context, workspaceDir, sessionID, messageID string) ([]string, error) {
	st, ok := b.reg.get(sessionID)
	if !ok || !b.cfg.Rewind {
		return nil, fmt.Errorf("acp: no rewind for session %q", sessionID)
	}
	st.mu.Lock()
	entry, err := st.entryIDLocked(messageID)
	st.mu.Unlock()
	if err != nil {
		return nil, err
	}
	conn, err := b.currentConn()
	if err != nil {
		return nil, err
	}
	callCtx, cancel := context.WithTimeout(ctx, rpcCallTimeout)
	defer cancel()
	raw, err := conn.call(callCtx, "_rewind/preview", map[string]any{"sessionId": sessionID, "messageId": entry})
	if err != nil {
		return nil, err
	}
	var res struct {
		Paths []string `json:"paths"`
	}
	_ = json.Unmarshal(raw, &res)
	return res.Paths, nil
}

// truncateFromLocked drops the message and everything after it (st.mu held) and rebuilds
// the indexes.
func (s *sessionState) truncateFromLocked(msgID string) {
	idx, ok := s.msgIndex[msgID]
	if !ok {
		return
	}
	s.messages = append([]backend.TranscriptEntry(nil), s.messages[:idx]...)
	s.msgIndex = map[string]int{}
	s.partIndex = map[string]int{}
	s.partOwner = map[string]int{}
	for i, e := range s.messages {
		s.msgIndex[e.Message.ID] = i
		for j, p := range e.Parts {
			s.partIndex[p.ID] = j
			s.partOwner[p.ID] = i
		}
	}
	for id := range s.entryIDs {
		if _, kept := s.msgIndex[id]; !kept {
			delete(s.entryIDs, id)
		}
	}
	s.updatedAt = time.Now()
}

// Fork implements backend.Forker: session/fork at the next user message after messageID (the
// turn messageID belongs to stays), or the whole session when none follows.
func (b *Backend) Fork(ctx context.Context, workspaceDir, sessionID, messageID, title string) (backend.Session, error) {
	if !b.cfg.Fork {
		return backend.Session{}, fmt.Errorf("acp: this agent cannot fork a session")
	}
	st, ok := b.reg.get(sessionID)
	if !ok {
		return backend.Session{}, fmt.Errorf("acp: unknown session %q", sessionID)
	}
	if err := b.openSession(ctx, workspaceDir, st, true); err != nil {
		return backend.Session{}, err
	}
	params := map[string]any{"sessionId": sessionID, "cwd": workspaceDir}
	var copied []backend.TranscriptEntry
	copiedIDs := map[string]string{}
	st.mu.Lock()
	cut := len(st.messages)
	if messageID != "" {
		start, ok := st.msgIndex[messageID]
		if !ok {
			st.mu.Unlock()
			return backend.Session{}, fmt.Errorf("acp: no such message %q in this session", messageID)
		}
		for i := start + 1; i < len(st.messages); i++ {
			e := st.messages[i]
			if e.Message.Role != "user" {
				continue
			}
			entry, err := st.entryIDLocked(e.Message.ID)
			if err != nil {
				st.mu.Unlock()
				return backend.Session{}, err
			}
			params["message_id"] = entry
			cut = i
			break
		}
	}
	// The agent holds the fork open already (it cannot be loaded again to replay its history),
	// so galopin's own copy of the history it shares is what the fork's transcript starts from.
	for _, e := range st.messages[:cut] {
		copied = append(copied, backend.TranscriptEntry{Message: e.Message, Parts: append([]backend.Part(nil), e.Parts...)})
		if id, ok := st.entryIDs[e.Message.ID]; ok {
			copiedIDs[e.Message.ID] = id
		}
	}
	st.mu.Unlock()
	servers, ep := b.mcpServers()
	params["mcpServers"] = servers
	conn, err := b.currentConn()
	if err != nil {
		return backend.Session{}, err
	}
	callCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	raw, err := b.callOpen(callCtx, conn, "session/fork", workspaceDir, params)
	if err != nil {
		if ep != nil {
			ep.Revoke()
		}
		return backend.Session{}, fmt.Errorf("acp: session/fork: %w", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil || getStr(m, "sessionId") == "" {
		if ep != nil {
			ep.Revoke()
		}
		return backend.Session{}, fmt.Errorf("acp: session/fork: no sessionId in the answer")
	}
	id := getStr(m, "sessionId")
	cfg := parseSessionConfig(m)
	child := b.reg.getOrCreate(id, workspaceDir)
	child.mu.Lock()
	child.title = title
	child.modeID = b.assertMode(ctx, id, cfg.modeID)
	child.modelID = cfg.modelID
	child.modeConfigID, child.modelConfigID = cfg.modeConfigID, cfg.modelConfigID
	child.effortConfigID, child.effortNow, child.effortValues = cfg.effortConfigID, cfg.effortID, cfg.effortValues
	child.active, child.loaded = true, true
	for _, e := range copied {
		child.upsertMessage(e.Message)
		for _, p := range e.Parts {
			child.upsertPart(p)
		}
	}
	for k, v := range copiedIDs {
		child.entryIDs[k] = v
	}
	child.mu.Unlock()
	b.adoptMCP(child, ep)
	b.syncEffort(ctx, workspaceDir, child)
	return b.GetSession(ctx, workspaceDir, id)
}

// noteSubagent turns a subagent's tool call into the parent's "task" card and a child session
// (st.mu held; part is the call as it now stands).
func (b *Backend) noteSubagent(st *sessionState, part *backend.Part, upd map[string]any) {
	if !b.cfg.Subagents {
		return
	}
	meta := getMap(upd, "_meta")
	if getStr(meta, "effect_kind") != "subagent" {
		return
	}
	task, agent := getStr(meta, "task"), getStr(meta, "agent")
	part.Tool = "task"
	if part.Input == nil {
		part.Input = map[string]any{}
	}
	if task != "" {
		part.Input["prompt"] = task
		if part.Input["description"] == nil {
			part.Input["description"] = firstLine(task, 80)
		}
	}
	if agent != "" {
		part.Input["subagent_type"] = agent
	}
	childID := getStr(meta, "child_session_id")
	if childID == "" {
		return
	}
	part.SubtaskSessionID = childID
	response := getStr(meta, "response")
	done := getStr(upd, "status") == "completed" && response != ""
	b.upsertChildLocked(st, childID, firstLine(task, 80), task, response, done)
}

func firstLine(s string, n int) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if r := []rune(s); len(r) > n {
		s = string(r[:n])
	}
	return s
}

// upsertChildLocked records a subagent as a session of its own under st (st.mu held): the
// task as its prompt and, when known, the answer. It is busy until the answer arrives or the
// parent's turn ends (finishChildrenLocked).
func (b *Backend) upsertChildLocked(st *sessionState, childID, title, task, response string, done bool) {
	child := b.reg.getOrCreate(childID, st.workspaceDir)
	if child == st {
		return
	}
	child.mu.Lock()
	defer child.mu.Unlock()
	if child.parentID == "" {
		child.parentID = st.id
		child.title = title
		child.loaded, child.active = true, false
		child.status = backend.StatusBusy
		st.children = append(st.children, childID)
		now := time.Now()
		userID := childID + ":user"
		child.upsertMessage(backend.Message{ID: userID, Role: "user", CreatedAt: now})
		child.upsertPart(backend.Part{ID: userID + ":text", MessageID: userID, Role: "user", Type: backend.PartText, Text: task})
	}
	if response != "" {
		asstID := childID + ":assistant"
		now := time.Now()
		child.upsertMessage(backend.Message{ID: asstID, Role: "assistant", CreatedAt: now, CompletedAt: &now})
		child.upsertPart(backend.Part{ID: asstID + ":text", MessageID: asstID, Role: "assistant", Type: backend.PartText, Text: response})
	}
	if done {
		child.status = backend.StatusIdle
	}
	child.updatedAt = time.Now()
}

// finishChildrenLocked ends the busy state of a session's subagents when its turn ends
// (st.mu held): the agent says nothing more about a child than its call.
func (b *Backend) finishChildrenLocked(st *sessionState) {
	for _, id := range st.children {
		if child, ok := b.reg.get(id); ok && child != st {
			child.mu.Lock()
			child.status = backend.StatusIdle
			child.mu.Unlock()
		}
	}
}

// Children implements backend.Childrener.
func (b *Backend) Children(_ context.Context, _, sessionID string) ([]backend.Session, error) {
	st, ok := b.reg.get(sessionID)
	if !ok {
		return nil, nil
	}
	st.mu.Lock()
	ids := append([]string(nil), st.children...)
	st.mu.Unlock()
	var out []backend.Session
	for _, id := range ids {
		if child, ok := b.reg.get(id); ok {
			child.mu.Lock()
			out = append(out, child.toSession(b.ID()))
			child.mu.Unlock()
		}
	}
	return out, nil
}

var (
	_ backend.Reverter   = (*Backend)(nil)
	_ backend.Forker     = (*Backend)(nil)
	_ backend.Childrener = (*Backend)(nil)
)
