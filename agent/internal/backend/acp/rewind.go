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
	"os"
	"path/filepath"
	"strings"
	"time"

	"galopin/internal/backend"
	"galopin/internal/permrules"
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

// ensureActive reopens a session the agent no longer holds (it restarted since): rewind and
// fork act on the agent's live session, and a reload also replaces galopin's copy of the
// transcript with the agent's own ids.
func (b *Backend) ensureActive(ctx context.Context, workspaceDir string, st *sessionState) error {
	st.mu.Lock()
	active := st.active
	st.mu.Unlock()
	if active {
		return nil
	}
	return b.openSession(ctx, workspaceDir, st, false)
}

// reserve takes the session for a rewind or fork: no prompt (queued instead), command or
// compaction runs while it is held, and nothing else can start one.
func (st *sessionState) reserveLocked() error {
	if st.busy || st.draining || st.rewinding {
		return backend.ErrSessionBusy
	}
	st.rewinding = true
	return nil
}

func (b *Backend) release(workspaceDir string, st *sessionState) {
	st.mu.Lock()
	st.rewinding = false
	st.mu.Unlock()
	b.drainQueue(workspaceDir, st) // what was queued meanwhile goes out now
}

// checkRewindPaths refuses a rewind whose file restore would reach beyond the workspace: the
// agent writes and deletes these paths itself, with no gate of galopin's in between, so each
// one must be inside the workspace, not protected, not (now) a symlink or other non-regular
// file, and reached through no symlinked directory.
func (b *Backend) checkRewindPaths(workspaceDir string, paths []string) error {
	root, err := filepath.EvalSymlinks(workspaceDir)
	if err != nil {
		return fmt.Errorf("acp: the workspace cannot be resolved: %w", err)
	}
	inside := func(p string) bool {
		rel, err := filepath.Rel(root, p)
		return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
	}
	var bad []string
	for _, raw := range paths {
		p := raw
		if !filepath.IsAbs(p) {
			p = filepath.Join(workspaceDir, p)
		}
		p = filepath.Clean(p)
		ok := true
		if b.cfg.Protect != nil && (b.cfg.Protect(workspaceDir, p) || b.cfg.Protect(root, p)) {
			ok = false
		}
		if ok {
			if fi, err := os.Lstat(p); err == nil && !fi.Mode().IsRegular() {
				ok = false
			}
		}
		if ok {
			// the deepest part that exists, resolved, must still be inside the workspace
			dir := filepath.Dir(p)
			for {
				if real, err := filepath.EvalSymlinks(dir); err == nil {
					ok = inside(real)
					break
				}
				next := filepath.Dir(dir)
				if next == dir {
					ok = false
					break
				}
				dir = next
			}
		}
		if ok && !inside(p) && !inside(strings.Replace(p, workspaceDir, root, 1)) {
			ok = false
		}
		if !ok {
			bad = append(bad, raw)
		}
	}
	if len(bad) > 0 {
		if len(bad) > 5 {
			bad = append(bad[:5], "...")
		}
		return fmt.Errorf("acp: the rollback would restore files outside this workspace, in a protected place or through a symlink, so it was not done: %s", strings.Join(bad, ", "))
	}
	return nil
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
	st.mu.Lock()
	if st.parentID != "" {
		st.mu.Unlock()
		return fmt.Errorf("acp: a subagent's session cannot be rolled back")
	}
	if err := st.reserveLocked(); err != nil {
		st.mu.Unlock()
		return err
	}
	st.mu.Unlock()
	defer b.release(workspaceDir, st)
	if err := b.ensureActive(ctx, workspaceDir, st); err != nil {
		return err
	}
	st.mu.Lock()
	idx, known := st.msgIndex[messageID]
	if !known || st.messages[idx].Message.Role != "user" {
		st.mu.Unlock()
		return fmt.Errorf("acp: %q is not a user message of this session", messageID)
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
	// What the rewind would write is checked first: the agent restores files itself.
	raw, err := conn.call(callCtx, "_rewind/preview", map[string]any{"sessionId": sessionID, "messageId": entry})
	if err != nil {
		return fmt.Errorf("acp: rewind preview: %w", err)
	}
	var prev struct {
		Paths []string `json:"paths"`
	}
	_ = json.Unmarshal(raw, &prev)
	if err := b.checkRewindPaths(workspaceDir, prev.Paths); err != nil {
		return err
	}
	raw, err = conn.call(callCtx, "_rewind/to", map[string]any{"sessionId": sessionID, "messageId": entry, "restoreFiles": true})
	if err != nil {
		return fmt.Errorf("acp: rewind: %w", err)
	}
	var res struct {
		RestoreErrors []any `json:"restoreErrors"`
	}
	_ = json.Unmarshal(raw, &res)
	st.mu.Lock()
	st.truncateFromLocked(messageID)
	st.mu.Unlock()
	if len(res.RestoreErrors) > 0 {
		var msgs []string
		for _, e := range res.RestoreErrors {
			msgs = append(msgs, fmt.Sprint(e))
		}
		return &backend.PartialRevertError{Detail: strings.Join(msgs, "; ")}
	}
	return nil
}

// Unrevert implements backend.Reverter: the agent's rewind cannot be undone.
func (b *Backend) Unrevert(context.Context, string, string) error {
	return backend.ErrUnrevertUnsupported
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

// Fork implements backend.Forker: session/fork up to and including the turn messageID belongs
// to ("": the whole session).
func (b *Backend) Fork(ctx context.Context, workspaceDir, sessionID, messageID, title string) (backend.Session, error) {
	if !b.cfg.Fork {
		return backend.Session{}, fmt.Errorf("acp: this agent cannot fork a session")
	}
	st, ok := b.reg.get(sessionID)
	if !ok {
		return backend.Session{}, fmt.Errorf("acp: unknown session %q", sessionID)
	}
	st.mu.Lock()
	if st.parentID != "" {
		st.mu.Unlock()
		return backend.Session{}, fmt.Errorf("acp: a subagent's session cannot be forked")
	}
	if err := st.reserveLocked(); err != nil {
		st.mu.Unlock()
		return backend.Session{}, err
	}
	st.mu.Unlock()
	defer b.release(workspaceDir, st)
	if err := b.ensureActive(ctx, workspaceDir, st); err != nil {
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
		// The agent's fork keeps the history up to and including the turn that the named user
		// message starts (checked against 3.1.3): the turn the chosen message belongs to, so the
		// user message at or before it is the one to name. A later turn is left out.
		for i := start; i >= 0; i-- {
			if st.messages[i].Message.Role != "user" {
				continue
			}
			entry, err := st.entryIDLocked(st.messages[i].Message.ID)
			if err != nil {
				st.mu.Unlock()
				return backend.Session{}, err
			}
			// the agent reads the message from the request's _meta (checked against 3.1.3:
			// a bare messageId or message_id field is ignored and the whole history is copied)
			params["_meta"] = map[string]any{"messageId": entry}
			cut = len(st.messages)
			for j := start + 1; j < len(st.messages); j++ {
				if st.messages[j].Message.Role == "user" {
					cut = j
					break
				}
			}
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
	child.mu.Unlock()
	// the fork keeps the parent's permission word, exceptions and coordination, as a spawned
	// session does: forking is no way to a looser session
	inherited := b.sels.get(sessionID)
	b.sels.update(id, func(permrules.Selector) permrules.Selector { return inherited })
	b.adoptMCP(child, ep)
	// The agent gives a fork entry ids of its own (checked), so the copied messages carry ids
	// no rewind or fork could name: close the fork and load it again, which replays its
	// history under the agent's ids and replaces galopin's copy. If that fails the copy stands
	// (the history is right; a rewind to a copied message is then refused by the agent).
	b.reopenFork(ctx, workspaceDir, child)
	child.mu.Lock()
	child.title = title // the reload brings the agent's own title back
	child.mu.Unlock()
	b.syncEffort(ctx, workspaceDir, child)
	return b.GetSession(ctx, workspaceDir, id)
}

// reopenFork closes a fork in the agent and loads it again so its history comes back with
// the agent's own ids. Reports whether it worked.
func (b *Backend) reopenFork(ctx context.Context, workspaceDir string, child *sessionState) bool {
	b.infoMu.Lock()
	canClose, canLoad := b.agentCaps.sessionClose, b.agentCaps.loadSession
	b.infoMu.Unlock()
	if !canClose || !canLoad {
		return false
	}
	conn, err := b.currentConn()
	if err != nil {
		return false
	}
	callCtx, cancel := context.WithTimeout(ctx, rpcCallTimeout)
	_, err = conn.call(callCtx, "session/close", map[string]any{"sessionId": child.id})
	cancel()
	if err != nil {
		return false
	}
	child.mu.Lock()
	child.active, child.loaded = false, false
	child.mu.Unlock()
	if err := b.openSession(ctx, workspaceDir, child, true); err != nil {
		b.cfg.Logf("acp: reloading fork %s: %v", child.id, err)
		return false
	}
	return true
}

// noteSubagent turns a subagent's tool call into the parent's "task" card and a child session
// (st.mu held; part is the call as it now stands).
func (b *Backend) noteSubagent(st *sessionState, part *backend.Part, upd map[string]any) *backend.Session {
	if !b.cfg.Subagents {
		return nil
	}
	meta := getMap(upd, "_meta")
	if getStr(meta, "effect_kind") != "subagent" {
		return nil
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
		return nil
	}
	part.SubtaskSessionID = childID
	response := getStr(meta, "response")
	done := getStr(upd, "status") == "completed" && response != ""
	return b.upsertChildLocked(st, childID, firstLine(task, 80), task, response, done)
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
func (b *Backend) upsertChildLocked(st *sessionState, childID, title, task, response string, done bool) *backend.Session {
	child := b.reg.getOrCreate(childID, st.workspaceDir)
	if child == st {
		return nil
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
	sess := child.toSession(b.ID())
	return &sess
}

// finishChildrenLocked ends the busy state of a session's subagents when its turn ends
// (st.mu held): the agent says nothing more about a child than its call.
func (b *Backend) finishChildrenLocked(st *sessionState) []backend.Session {
	var changed []backend.Session
	for _, id := range st.children {
		if child, ok := b.reg.get(id); ok && child != st {
			child.mu.Lock()
			if child.status != backend.StatusIdle {
				child.status = backend.StatusIdle
				changed = append(changed, child.toSession(b.ID()))
			}
			child.mu.Unlock()
		}
	}
	return changed
}

// emitSessions announces sessions whose state changed (a subagent's status), off the lock.
func (b *Backend) emitSessions(workspaceDir string, sessions ...backend.Session) {
	for i := range sessions {
		s := sessions[i]
		b.emit(workspaceDir, s.ID, backend.Event{Kind: backend.EventSession, Session: &s})
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
