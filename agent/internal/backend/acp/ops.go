package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"galopin/internal/backend"
)

// Compile-time check: Backend must satisfy the floor interface. Of the
// optional capability interfaces only Differ applies (diffs.go, galopin's own
// snapshots); ACP has no wire message for Childrener/Compactor (PROTOCOL.md §2).
var _ backend.Backend = (*Backend)(nil)

// maxListPages bounds session/list pagination: an agent with a very long
// history is listed to this depth (newest first, as agents return them).
const maxListPages = 20

func (b *Backend) ListSessions(ctx context.Context, workspaceDir string) ([]backend.Session, error) {
	b.infoMu.Lock()
	canList := b.agentCaps.sessionList
	b.infoMu.Unlock()
	if canList {
		conn, err := b.currentConn()
		if err != nil {
			return nil, err
		}
		// session/list is filtered by cwd by the agent and paged by cursor
		// (session-list.md). The agent's filter is not trusted alone: a cwd that
		// differs (a trailing slash, another workspace) is dropped here too.
		cursor := ""
		for page := 0; page < maxListPages; page++ {
			params := map[string]any{"cwd": workspaceDir}
			if cursor != "" {
				params["cursor"] = cursor
			}
			callCtx, cancel := context.WithTimeout(ctx, rpcCallTimeout)
			raw, err := conn.call(callCtx, "session/list", params)
			cancel()
			if err != nil {
				if page > 0 {
					break // a later page failing keeps what was listed
				}
				return nil, fmt.Errorf("acp: session/list: %w", err)
			}
			var m map[string]any
			if err := json.Unmarshal(raw, &m); err != nil {
				return nil, fmt.Errorf("acp: session/list: parsing response: %w", err)
			}
			for _, sm := range asMaps(getSlice(m, "sessions")) {
				id := getStr(sm, "sessionId", "id")
				if id == "" || !sameDir(getStr(sm, "cwd"), workspaceDir) || b.reg.isGone(id) {
					continue
				}
				st := b.reg.getOrCreate(id, workspaceDir)
				st.mu.Lock()
				if st.title == "" {
					st.title = getStr(sm, "title")
				}
				if t, err := time.Parse(time.RFC3339, getStr(sm, "updatedAt")); err == nil && !st.active && !st.busy {
					st.updatedAt = t
					if !st.loaded {
						st.createdAt = t // the agent gives only the last activity
					}
				}
				st.mu.Unlock()
			}
			cursor = getStr(m, "nextCursor")
			if cursor == "" {
				break
			}
		}
	}
	// Whether or not session/list is advertised, the answer is built from
	// this process's own registry: for an agent without "list", that
	// registry (populated by CreateSession/session/load) is the only
	// source of truth this backend has (PROTOCOL.md/the task: "else keep
	// an in-memory registry per cwd").
	var out []backend.Session
	for _, st := range b.reg.list(workspaceDir) {
		st.mu.Lock()
		out = append(out, st.toSession(b.ID()))
		st.mu.Unlock()
	}
	return out, nil
}

func sameDir(a, b string) bool {
	return filepath.Clean(a) == filepath.Clean(b)
}

func (b *Backend) GetSession(ctx context.Context, workspaceDir, sessionID string) (backend.Session, error) {
	st, ok := b.reg.get(sessionID)
	if !ok {
		return backend.Session{}, fmt.Errorf("acp: unknown session %q", sessionID)
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.toSession(b.ID()), nil
}

func (b *Backend) CreateSession(ctx context.Context, workspaceDir string, opts backend.CreateSessionOptions) (backend.Session, error) {
	conn, err := b.currentConn()
	if err != nil {
		return backend.Session{}, err
	}
	callCtx, cancel := context.WithTimeout(ctx, rpcCallTimeout)
	defer cancel()
	servers, ep := b.mcpServers()
	newParams := map[string]any{"cwd": workspaceDir, "mcpServers": servers}
	if len(b.cfg.SessionMeta) > 0 {
		newParams["_meta"] = b.cfg.SessionMeta
	}
	raw, err := b.callOpen(callCtx, conn, "session/new", workspaceDir, newParams)
	if err != nil {
		if ep != nil {
			ep.Revoke()
		}
		return backend.Session{}, fmt.Errorf("acp: session/new: %w", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return backend.Session{}, fmt.Errorf("acp: session/new: parsing response: %w", err)
	}
	id := getStr(m, "sessionId")
	if id == "" {
		if ep != nil {
			ep.Revoke()
		}
		return backend.Session{}, fmt.Errorf("acp: session/new: response carried no sessionId")
	}
	cfg := parseSessionConfig(m)
	curMode, curModel := cfg.modeID, cfg.modelID
	curMode = b.assertMode(ctx, id, curMode)
	b.reg.setCaps(workspaceDir, workspaceCaps{modes: b.visibleModes(cfg.modes), models: cfg.models})

	st := b.reg.getOrCreate(id, workspaceDir)
	st.mu.Lock()
	st.loaded = true
	st.active = true
	st.title = opts.Title
	st.modeID = curMode
	st.modelID = curModel
	st.modeConfigID, st.modelConfigID = cfg.modeConfigID, cfg.modelConfigID
	st.effortConfigID, st.effortNow, st.effortValues = cfg.effortConfigID, cfg.effortID, cfg.effortValues
	st.spawnedBy = opts.SpawnedBy
	st.mu.Unlock()
	b.adoptMCP(st, ep)
	b.syncEffort(ctx, workspaceDir, st)

	if opts.ModeID != "" && opts.ModeID != curMode {
		if _, err := b.SetMode(ctx, workspaceDir, id, opts.ModeID); err != nil {
			b.cfg.Logf("acp: session/new: setting initial mode %q: %v", opts.ModeID, err)
		}
	}
	if opts.ModelID != "" && opts.ModelID != curModel {
		if _, err := b.SetModel(ctx, workspaceDir, id, opts.ModelID); err != nil {
			b.cfg.Logf("acp: session/new: setting initial model %q: %v", opts.ModelID, err)
		}
	}
	return b.GetSession(ctx, workspaceDir, id)
}

// RenameSession is best effort: ACP has no rename/set-title method, so the
// title lives only in this process's overlay (PROTOCOL.md/the task).
func (b *Backend) RenameSession(ctx context.Context, workspaceDir, sessionID, title string) (backend.Session, error) {
	st, ok := b.reg.get(sessionID)
	if !ok {
		return backend.Session{}, fmt.Errorf("acp: unknown session %q", sessionID)
	}
	st.mu.Lock()
	st.title = title
	st.updatedAt = time.Now()
	sess := st.toSession(b.ID())
	st.mu.Unlock()
	return sess, nil
}

// DeleteSession is best effort: session/close if the agent advertised it,
// otherwise this just forgets the session locally (PROTOCOL.md/the task).
func (b *Backend) DeleteSession(ctx context.Context, workspaceDir, sessionID string) error {
	b.infoMu.Lock()
	canClose := b.agentCaps.sessionClose
	canDelete := b.agentCaps.sessionDelete
	b.infoMu.Unlock()
	// Close frees the agent's live resources; delete removes the session from
	// its list (session-delete.md), so a session deleted here does not come
	// back from session/list. -32002 (unknown session) counts as done.
	if conn, err := b.currentConn(); err == nil {
		for _, step := range []struct {
			method string
			on     bool
		}{{"session/close", canClose}, {"session/delete", canDelete}} {
			if !step.on {
				continue
			}
			callCtx, cancel := context.WithTimeout(ctx, rpcCallTimeout)
			_, callErr := conn.call(callCtx, step.method, map[string]any{"sessionId": sessionID})
			cancel()
			var re *rpcError
			if callErr != nil && !(errors.As(callErr, &re) && re.Code == -32002) {
				b.cfg.Logf("acp: %s %s: %v", step.method, sessionID, callErr)
			}
		}
	}
	if st, ok := b.reg.get(sessionID); ok {
		st.mu.Lock()
		ep := st.mcp
		st.mu.Unlock()
		if ep != nil {
			ep.Revoke()
		}
	}
	if issuer := b.mcpIssuer(); issuer != nil {
		issuer.RevokeSession(sessionID)
	}
	b.reg.delete(sessionID)
	b.att.Forget(sessionID)
	b.diffs.Forget(sessionID)
	return nil
}

// Prompt sends session/prompt and returns as soon as it is on the wire
// (PROTOCOL.md/the task: async, matching opencode's prompt_async) — the
// turn's own completion arrives later, off awaitPromptResult, as a status
// event. It also synthesizes this turn's user Message/Part locally: found
// live, opencode's ACP mode never sends a user_message_chunk during a live
// prompt (only session/load's replay does), so the client's own request is
// the only source of truth for what the user actually said.
func (b *Backend) Prompt(ctx context.Context, workspaceDir, sessionID string, prompt backend.Prompt) error {
	if b.hiddenCommandIn(prompt.Text) {
		return fmt.Errorf("acp: that command is not available here")
	}
	return b.prompt(ctx, workspaceDir, sessionID, prompt, false)
}

func (b *Backend) prompt(ctx context.Context, workspaceDir, sessionID string, prompt backend.Prompt, fromQueue bool) error {
	conn, err := b.currentConn()
	if err != nil {
		return err
	}
	st, ok := b.reg.get(sessionID)
	if !ok {
		st = b.reg.getOrCreate(sessionID, workspaceDir)
	}

	// A session found by session/list, or one the agent forgot in a restart,
	// is reopened (resume where advertised) before it can be prompted.
	st.mu.Lock()
	needOpen := !st.active && !st.busy
	st.mu.Unlock()
	if needOpen {
		if err := b.openSession(ctx, workspaceDir, st, false); err != nil {
			return err
		}
	}

	st.mu.Lock()
	hidden := b.modeHidden(st.modeID)
	cur := st.modeID
	st.mu.Unlock()
	if hidden {
		now := b.assertMode(ctx, sessionID, cur)
		st.mu.Lock()
		st.modeID = now
		st.mu.Unlock()
	}

	st.mu.Lock()
	// A second prompt on a busy session would overwrite the turn ids the running turn's
	// updates are still arriving under (assistantMsgID, textPartID, ...) and forge its
	// state, so it waits its turn: it is held, announced as queued, and sent when the
	// turn ends (queue.go). ACP has no steering, so this is the nearest thing.
	// fromQueue is a prompt being sent off the queue, which has already waited.
	if !fromQueue && prompt.ClientMessageID != "" && slices.Contains(st.recentIDs, prompt.ClientMessageID) {
		st.mu.Unlock() // a retry of a prompt that already went out
		return nil
	}
	if !fromQueue && (st.busy || st.draining || len(st.queue) > 0) {
		return b.enqueueLocked(workspaceDir, st, prompt)
	}
	if st.busy {
		// a queued prompt never runs over a turn: the caller puts it back
		st.mu.Unlock()
		return backend.ErrSessionBusy
	}
	if prompt.ClientMessageID != "" {
		st.recentIDs = append(st.recentIDs, prompt.ClientMessageID)
		if len(st.recentIDs) > 32 {
			st.recentIDs = st.recentIDs[1:]
		}
	}
	st.draining = false // a drained prompt has the session now
	st.turn++
	turn := st.turn
	userMsgID := fmt.Sprintf("%s:t%d:user", sessionID, turn)
	userPartID := userMsgID + ":text"
	st.assistantMsgID = fmt.Sprintf("%s:t%d:assistant", sessionID, turn)
	st.textPartID = st.assistantMsgID + ":text"
	st.reasoningPartID = st.assistantMsgID + ":reasoning"
	st.textSeen = false
	st.reasoningSeen = false
	st.busy = true
	st.status = backend.StatusBusy
	userMsg := backend.Message{ID: userMsgID, Role: "user", CreatedAt: time.Now(), ClientMessageID: prompt.ClientMessageID}
	// A command run marks its own message (PROTOCOL.md §6 session.command):
	// ACP never echoes the user message back in live mode, so this
	// synthesis is the only place the marker can be set.
	if prompt.Command != nil {
		userMsg.Command = prompt.Command
	}
	// A message another session wrote (session_send, a delegate's report) is
	// marked with its sender, as opencode's is.
	if prompt.SentBy != nil {
		sent := *prompt.SentBy
		userMsg.SentBy = &sent
	}
	userPart := backend.Part{ID: userPartID, MessageID: userMsgID, Role: "user", Type: backend.PartText, Text: prompt.Text}
	st.upsertMessage(userMsg)
	st.upsertPart(userPart)
	st.mu.Unlock()

	b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventMessage, Message: &userMsg})
	b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventPart, Part: &userPart})
	b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventStatus, Status: backend.StatusBusy})

	respCh, err := conn.callAsync("session/prompt", map[string]any{
		"sessionId": sessionID,
		"prompt":    promptContentBlocks(prompt, b.promptCaps()),
	})
	if err != nil {
		st.mu.Lock()
		st.busy = false
		st.status = backend.StatusIdle
		st.mu.Unlock()
		b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventStatus, Status: backend.StatusIdle})
		return err
	}
	go b.awaitPromptResult(workspaceDir, sessionID, st, respCh)
	return nil
}

func (b *Backend) awaitPromptResult(workspaceDir, sessionID string, st *sessionState, respCh <-chan rpcMessage) {
	msg := <-respCh
	// The turn is over: per-call snapshots of edits that never finished go.
	b.diffs.EndTurn(sessionID)

	st.mu.Lock()
	st.busy = false
	st.draining = len(st.queue) > 0
	assistantMsgID := st.assistantMsgID
	st.status = backend.StatusIdle
	st.updatedAt = time.Now()

	if msg.Error != nil {
		st.mu.Unlock()
		// -32800 is "request cancelled" (cancellation.md): an agent may answer a
		// cancelled prompt with it instead of stopReason "cancelled". Either way
		// a cancel is a quiet end of turn, never an error.
		if msg.Error.Code != errRequestCancelled {
			b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventError, ErrorMessage: msg.Error.Message, ErrorCode: fmt.Sprint(msg.Error.Code)})
		}
		b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventStatus, Status: backend.StatusIdle})
		b.drainQueue(workspaceDir, st)
		return
	}

	var res struct {
		StopReason string         `json:"stopReason"`
		Usage      map[string]any `json:"usage"`
		Meta       map[string]any `json:"_meta"`
	}
	_ = json.Unmarshal(msg.Result, &res)

	now := time.Now()
	errMsg := stopReasonError(res.StopReason)
	if idx, ok := st.msgIndex[assistantMsgID]; ok {
		st.messages[idx].Message.CompletedAt = &now
		st.messages[idx].Message.Error = errMsg
	}
	st.mu.Unlock()

	// Per-turn token counts: the end-turn usage field is still a draft RFD
	// (not in the v1 schema), read when an agent sends it, also under _meta.
	turn := res.Usage
	if turn == nil {
		turn = getMap(res.Meta, "usage")
	}
	if turn != nil {
		b.applyTurnUsage(workspaceDir, st, turn)
	}
	if errMsg != "" {
		b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventError, ErrorMessage: errMsg})
	}
	// cancelled and end_turn all just mean "the turn is over" (PROTOCOL.md/the
	// task: "cancelled → idle, no error"); refusal, max_tokens and
	// max_turn_requests carry a visible error (stopReasonError), as does a
	// JSON-RPC error (above).
	b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventStatus, Status: backend.StatusIdle})
	b.drainQueue(workspaceDir, st)
}

// errRequestCancelled is ACP's -32800 (error.md).
const errRequestCancelled = -32800

// stopReasonError is the visible error a stop reason other than a normal end
// or a cancel carries (prompt-turn.md "Stop reasons").
func stopReasonError(reason string) string {
	switch reason {
	case "refusal":
		return "the agent refused this prompt"
	case "max_tokens":
		return "the agent stopped: the model's output token limit was reached"
	case "max_turn_requests":
		return "the agent stopped: the maximum number of model requests in one turn was reached"
	}
	return ""
}

// Cancel sends session/cancel (a notification, not a request — verified
// live) and, per the ACP spec, resolves any permission request still
// pending for this session with a "cancelled" outcome rather than leaving
// the agent's request_permission call hanging forever.
func (b *Backend) Cancel(ctx context.Context, workspaceDir, sessionID string) error {
	conn, err := b.currentConn()
	if err != nil {
		return err
	}
	st, ok := b.reg.get(sessionID)
	if ok {
		st.mu.Lock()
		pending := st.pending
		st.pending = map[string]pendingPermission{}
		st.mu.Unlock()
		for _, p := range pending {
			_ = conn.respond(p.jsonrpcID, map[string]any{"outcome": map[string]any{"outcome": "cancelled"}}, nil)
		}
	}
	// a question held for the person goes with the turn it was asked in
	b.dismissQuestions(workspaceDir, sessionID)
	// and so do the follow-ups waiting for that turn: Stop means stop
	if ok {
		b.clearQueue(workspaceDir, st)
	}
	return conn.notify("session/cancel", map[string]any{"sessionId": sessionID})
}

func (b *Backend) SetMode(ctx context.Context, workspaceDir, sessionID, modeID string) (backend.Session, error) {
	if b.modeHidden(modeID) {
		return backend.Session{}, fmt.Errorf("acp: mode %q is not offered: it would skip the permission asks", modeID)
	}
	conn, err := b.currentConn()
	if err != nil {
		return backend.Session{}, err
	}
	st, ok := b.reg.get(sessionID)
	if !ok {
		return backend.Session{}, fmt.Errorf("acp: unknown session %q", sessionID)
	}
	st.mu.Lock()
	configID := st.modeConfigID
	st.mu.Unlock()
	callCtx, cancel := context.WithTimeout(ctx, rpcCallTimeout)
	defer cancel()
	// Config options are the preferred form (session-config-options.md: modes
	// "will be removed in a future version"); session/set_mode is used when the
	// agent offers the mode only the old way, or does not know the option method.
	done := false
	if configID != "" {
		raw, err := conn.call(callCtx, "session/set_config_option", map[string]any{"sessionId": sessionID, "configId": configID, "value": modeID})
		if err == nil {
			done = true
			b.applyConfigResult(workspaceDir, st, raw)
		} else if !isMethodNotFound(err) {
			return backend.Session{}, fmt.Errorf("acp: session/set_config_option: %w", err)
		}
	}
	if !done {
		if _, err := conn.call(callCtx, "session/set_mode", map[string]any{"sessionId": sessionID, "modeId": modeID}); err != nil {
			return backend.Session{}, fmt.Errorf("acp: session/set_mode: %w", err)
		}
	}
	st.mu.Lock()
	st.modeID = modeID
	st.modeGen++
	st.updatedAt = time.Now()
	sess := st.toSession(b.ID())
	st.mu.Unlock()
	return sess, nil
}

func isMethodNotFound(err error) bool {
	var re *rpcError
	return errors.As(err, &re) && re.Code == -32601
}

// SetModel sets the model through the model config option when the agent
// advertised one, else through the still-unstable session/set_model. An agent
// that has neither answers a plain JSON-RPC "method not found", which this
// wraps into a message that says so rather than a bare rpc error.
func (b *Backend) SetModel(ctx context.Context, workspaceDir, sessionID, modelID string) (backend.Session, error) {
	conn, err := b.currentConn()
	if err != nil {
		return backend.Session{}, err
	}
	st, ok := b.reg.get(sessionID)
	if !ok {
		return backend.Session{}, fmt.Errorf("acp: unknown session %q", sessionID)
	}
	st.mu.Lock()
	configID := st.modelConfigID
	st.mu.Unlock()
	callCtx, cancel := context.WithTimeout(ctx, rpcCallTimeout)
	defer cancel()
	done := false
	if configID != "" {
		raw, err := conn.call(callCtx, "session/set_config_option", map[string]any{"sessionId": sessionID, "configId": configID, "value": modelID})
		if err == nil {
			done = true
			b.applyConfigResult(workspaceDir, st, raw)
		} else if !isMethodNotFound(err) {
			return backend.Session{}, fmt.Errorf("acp: session/set_config_option: %w", err)
		}
	}
	if !done {
		if _, err := conn.call(callCtx, "session/set_model", map[string]any{"sessionId": sessionID, "modelId": modelID}); err != nil {
			// goose and pi-acp advertise the model as a config option and answer
			// "method not found" to the unstable session/set_model: the stable
			// way is session/set_config_option on that option.
			if !isMethodNotFound(err) {
				return backend.Session{}, fmt.Errorf("acp: session/set_model failed: %w", err)
			}
			if _, err2 := conn.call(callCtx, "session/set_config_option", map[string]any{"sessionId": sessionID, "configId": "model", "value": modelID}); err2 != nil {
				return backend.Session{}, fmt.Errorf("acp: neither session/set_model nor session/set_config_option is supported by this agent: %w", err2)
			}
		}
	}
	st.mu.Lock()
	st.modelID = modelID
	st.updatedAt = time.Now()
	st.mu.Unlock()
	// the agent puts the new model on that model's own thinking level: the person's choice
	// (or the default) goes back on
	b.syncEffort(ctx, workspaceDir, st)
	st.mu.Lock()
	sess := st.toSession(b.ID())
	st.mu.Unlock()
	return sess, nil
}

// applyConfigResult folds a session/set_config_option answer (the complete
// option list) into the session's selectors.
func (b *Backend) applyConfigResult(workspaceDir string, st *sessionState, raw json.RawMessage) {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return
	}
	b.applyConfig(workspaceDir, st, parseSessionConfig(m))
}

// applyConfig records a session's selectors from a configOptions list (an
// answer or a config_option_update). Only selectors the list names change.
func (b *Backend) applyConfig(workspaceDir string, st *sessionState, cfg sessionConfig) {
	if cfg.effortConfigID != "" {
		st.mu.Lock()
		st.effortConfigID, st.effortNow, st.effortValues = cfg.effortConfigID, cfg.effortID, cfg.effortValues
		st.mu.Unlock()
	}
	if cfg.modeConfigID == "" && cfg.modelConfigID == "" {
		return
	}
	caps := b.reg.getCaps(workspaceDir)
	st.mu.Lock()
	if cfg.modeConfigID != "" {
		st.modeConfigID = cfg.modeConfigID
		if !b.modeHidden(cfg.modeID) {
			st.modeID = cfg.modeID
		}
		caps.modes = b.visibleModes(cfg.modes)
	}
	if cfg.modelConfigID != "" {
		st.modelConfigID = cfg.modelConfigID
		st.modelID = cfg.modelID
		caps.models = cfg.models
	}
	st.mu.Unlock()
	b.reg.setCaps(workspaceDir, caps)
}

// ReplyPermission answers a pending session/request_permission with the
// optionId matching decision's kind (PROTOCOL.md/the task:
// once->allow_once, always->allow_always (falling back to allow_once if
// the agent offered none), reject->reject_once (falling back to
// reject_always)).
func (b *Backend) ReplyPermission(ctx context.Context, workspaceDir, sessionID, requestID string, decision backend.Decision, message string) error {
	// galopin's own approvals are held here and never reach the agent.
	if isGalopinAsk(requestID) {
		return b.replyGalopinAsk(workspaceDir, sessionID, requestID, decision, message)
	}
	conn, err := b.currentConn()
	if err != nil {
		return err
	}
	st, ok := b.reg.get(sessionID)
	if !ok {
		return fmt.Errorf("acp: unknown session %q", sessionID)
	}
	if err := b.waitReasserted(ctx, st, decision); err != nil {
		return err
	}
	st.mu.Lock()
	pending, ok := st.pending[requestID]
	if ok {
		delete(st.pending, requestID)
	}
	st.mu.Unlock()
	if !ok {
		return fmt.Errorf("acp: no pending permission %q", requestID)
	}

	var optionID string
	switch decision {
	case backend.DecisionOnce:
		// Only allow_once is "once": offering the agent's allow_always for it
		// would widen what the user approved.
		optionID = findOptionByKind(pending.options, "allow_once")
	case backend.DecisionAlways:
		optionID = findOptionByKind(pending.options, "allow_always", "allow_once")
	case backend.DecisionReject:
		optionID = findOptionByKind(pending.options, "reject_once", "reject_always")
	}
	if optionID == "" {
		return fmt.Errorf("acp: no permission option matches decision %q (options: %+v)", decision, pending.options)
	}
	if err := conn.respond(pending.jsonrpcID, map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": optionID}}, nil); err != nil {
		return err
	}
	b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventPermissionReplied, RequestID: requestID, Decision: decision, By: "user"})
	return nil
}

func (b *Backend) Modes(ctx context.Context, workspaceDir string) ([]backend.Mode, error) {
	return b.reg.getCaps(workspaceDir).modes, nil
}

func (b *Backend) Models(ctx context.Context, workspaceDir string) ([]backend.Model, error) {
	// Cerea offers an image attachment only for a model that claims images; an
	// ACP agent has one prompt capability for all its models.
	images := b.promptCaps().promptImage
	models := append([]backend.Model(nil), b.reg.getCaps(workspaceDir).models...)
	var efforts map[string][]string
	if b.cfg.Efforts && b.cfg.ModelEfforts != nil {
		efforts = b.cfg.ModelEfforts()
	}
	for i := range models {
		models[i].Images = images
		if e := efforts[models[i].ID]; len(e) > 0 {
			models[i].Efforts, models[i].Reasoning = append([]string(nil), e...), true
		}
	}
	return models, nil
}

// Transcript returns the session's accumulated state if this process has
// it (live prompts, created here, or an earlier replay), otherwise opens the
// session with its history: session/load where the agent advertised
// loadSession, else session/resume (which replays nothing, so the history is
// empty but the session is usable). The agent replays the history as
// session/update notifications, which fill the registry through the same
// handleNotify path a live turn uses (events.go); the notifications are lines
// the connection's reader sees before the load response, so by the time the
// call returns the registry holds all of it (PROTOCOL.md §7's no-gap guarantee).
func (b *Backend) Transcript(ctx context.Context, workspaceDir, sessionID string) (backend.Transcript, error) {
	st, ok := b.reg.get(sessionID)
	if ok {
		st.mu.Lock()
		ok = st.loaded || st.busy || len(st.messages) > 0
		st.mu.Unlock()
	}
	if !ok {
		st = b.reg.getOrCreate(sessionID, workspaceDir)
		if err := b.openSession(ctx, workspaceDir, st, true); err != nil {
			return backend.Transcript{}, err
		}
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.toTranscript(), nil
}

// openSession makes the agent hold a session this process did not create (one
// session/list found, or one the agent forgot when it restarted). withHistory
// asks for the transcript: session/load is then preferred, because only it
// replays the conversation; without it session/resume is preferred (no replay
// to rebuild or duplicate) and session/load is the fallback. An agent with
// neither is left alone, as before. One open at a time: a second caller finds
// the first one's result.
func (b *Backend) openSession(ctx context.Context, workspaceDir string, st *sessionState, withHistory bool) error {
	b.loadMu.Lock()
	defer b.loadMu.Unlock()
	st.mu.Lock()
	done := st.active || (withHistory && st.loaded)
	st.mu.Unlock()
	if done {
		return nil
	}
	b.infoMu.Lock()
	canLoad, canResume := b.agentCaps.loadSession, b.agentCaps.sessionResume
	b.infoMu.Unlock()
	// sessionCapabilities.resume gates session/resume; loadSession gates
	// session/load. They are independent (goose advertises loadSession alone).
	method := ""
	switch {
	case withHistory && canLoad, !withHistory && !canResume && canLoad:
		method = "session/load"
	case canResume:
		method = "session/resume"
	}
	if method == "" {
		st.mu.Lock()
		st.loaded = true
		st.mu.Unlock()
		return nil
	}
	conn, err := b.currentConn()
	if err != nil {
		return err
	}
	sessionID := st.id
	var (
		raw json.RawMessage
		ep  backend.MCPEndpoint
	)
	for attempt := 0; ; attempt++ {
		st.mu.Lock()
		if method == "session/load" {
			// The replay rebuilds the transcript, so what is held is dropped first
			// (a re-open after an agent restart would otherwise double it).
			st.messages, st.todos = nil, nil
			st.msgIndex, st.partIndex, st.partOwner = map[string]int{}, map[string]int{}, map[string]int{}
			st.replaying, st.replayRole, st.replaySeq, st.replayMsgID = true, "", 0, ""
		}
		st.mu.Unlock()
		callCtx, cancel := context.WithTimeout(ctx, rpcCallTimeout)
		var servers []any
		servers, ep = b.mcpServers()
		params := map[string]any{"sessionId": sessionID, "cwd": workspaceDir, "mcpServers": servers}
		if len(b.cfg.SessionMeta) > 0 {
			params["_meta"] = b.cfg.SessionMeta
		}
		raw, err = b.callOpen(callCtx, conn, method, workspaceDir, params)
		cancel()
		st.mu.Lock()
		st.replaying = false
		st.mu.Unlock()
		if err == nil || !isSessionBusy(err) || attempt >= len(openBusyDelays) {
			break
		}
		// Another process holds the session (Vibe keeps a lock per open session: the
		// previous agent process, still shutting down after a restart of galopin). It
		// is gone within seconds; a load that waits for it beats an error the user sees.
		if ep != nil {
			ep.Revoke()
		}
		b.cfg.Logf("acp: %s %s: the session is open in another process, retrying in %s", method, sessionID, openBusyDelays[attempt])
		select {
		case <-time.After(openBusyDelays[attempt]):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err != nil {
		if ep != nil {
			ep.Revoke()
		}
		return fmt.Errorf("acp: %s: %w", method, err)
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) == nil {
		cfg := parseSessionConfig(m)
		curMode := b.assertMode(ctx, sessionID, cfg.modeID)
		b.reg.setCaps(workspaceDir, workspaceCaps{modes: b.visibleModes(cfg.modes), models: cfg.models})
		st.mu.Lock()
		if st.modeID == "" || b.modeHidden(st.modeID) {
			st.modeID = curMode
		}
		if st.modelID == "" {
			st.modelID = cfg.modelID
		}
		st.modeConfigID, st.modelConfigID = cfg.modeConfigID, cfg.modelConfigID
		st.effortConfigID, st.effortNow, st.effortValues = cfg.effortConfigID, cfg.effortID, cfg.effortValues
		st.mu.Unlock()
	}
	st.mu.Lock()
	st.loaded = true
	st.active = true
	st.replayed = method == "session/load"
	st.mu.Unlock()
	b.adoptMCP(st, ep)
	b.syncEffort(ctx, workspaceDir, st)
	if method == "session/load" {
		b.trimReplays(sessionID)
	}
	return nil
}

// openBusyDelays are the waits between retries of a session/load or session/resume
// that fails because another process holds the session (a variable for the tests).
var openBusyDelays = []time.Duration{500 * time.Millisecond, time.Second, 2 * time.Second, 2 * time.Second, 2 * time.Second}

// isSessionBusy reports Vibe's "Session is already open" answer (code -31002, the
// agent's generic configuration error, so the message is what tells it apart).
func isSessionBusy(err error) bool {
	var re *rpcError
	return errors.As(err, &re) && strings.Contains(strings.ToLower(re.Message), "already open")
}

func (b *Backend) promptCaps() acpAgentCapabilities {
	b.infoMu.Lock()
	defer b.infoMu.Unlock()
	return b.agentCaps
}

// callOpen is a session/new, session/load or session/resume call, with the engine's
// BeforeSession work done first and no other open overlapping it.
func (b *Backend) callOpen(ctx context.Context, conn *rpcConn, method, workspaceDir string, params map[string]any) (json.RawMessage, error) {
	if b.cfg.BeforeSession == nil {
		return conn.call(ctx, method, params)
	}
	b.openMu.Lock()
	defer b.openMu.Unlock()
	b.cfg.BeforeSession(workspaceDir)
	if b.cfg.AfterSession != nil {
		defer b.cfg.AfterSession()
	}
	return conn.call(ctx, method, params)
}
