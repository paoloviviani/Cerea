package opencode

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"galopin/internal/backend"
	"galopin/internal/permrules"
)

// doJSONTimeout bounds every control-plane call doJSON makes. All of them
// are supposed to be fast — session CRUD, prompt_async (204, fire and
// forget; the model's actual reply streams over SSE separately), abort,
// permission replies, listings — never a call that legitimately runs long.
// Capping it here means a single wedged request can't hang a caller
// forever regardless of what deadline (if any) it happened to pass in.
const doJSONTimeout = 20 * time.Second

// Compile-time checks: Backend must satisfy the floor interface and every
// optional capability its Capabilities() advertises as true.
var (
	_ backend.Backend          = (*Backend)(nil)
	_ backend.Differ           = (*Backend)(nil)
	_ backend.Childrener       = (*Backend)(nil)
	_ backend.Compactor        = (*Backend)(nil)
	_ backend.Asker            = (*Backend)(nil)
	_ backend.AttachmentSource = (*Backend)(nil)
)

// doJSON issues one request against the supervised opencode instance,
// basic-authenticated, and decodes a JSON response into out (nil to
// discard the body — POST /session/:id/prompt_async answers 204).
func (b *Backend) doJSON(ctx context.Context, method, path string, body any, out any) error {
	return b.doJSONLimit(ctx, method, path, body, out, 4<<20)
}

// maxTranscriptBytes bounds a response that can carry tool images inline as
// data: URLs (a session's messages): a screenshot is up to 8 MiB decoded, so
// the general 4 MiB read limit would truncate the JSON and lose the whole
// transcript.
const maxTranscriptBytes = 256 << 20

// statusError is a non-2xx answer from opencode: the typed half of doJSON's
// error, so a caller can tell one status from another without matching on
// the message text (a deleted child's 404 is the cue to forget it,
// permissions.go). The text is exactly what doJSON has always printed, so
// callers still matching on it keep working.
type statusError struct {
	status int
	err    error
}

func (e *statusError) Error() string { return e.err.Error() }

// Unwrap exposes the formatted error behind it.
func (e *statusError) Unwrap() error { return e.err }

// notFound reports whether err is opencode answering 404.
func notFound(err error) bool {
	var se *statusError
	return errors.As(err, &se) && se.status == http.StatusNotFound
}

// doJSONLimit is doJSON with an explicit cap on the response body read.
func (b *Backend) doJSONLimit(ctx context.Context, method, path string, body any, out any, limit int64) error {
	ctx, cancel := context.WithTimeout(ctx, doJSONTimeout)
	defer cancel()
	var reader io.Reader
	stripForbidden(body)
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, b.baseURL()+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.SetBasicAuth("opencode", b.cfg.Password)

	resp, err := b.client.Do(req)
	if err != nil {
		return fmt.Errorf("opencode %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, limit))
	if resp.StatusCode >= 300 {
		err := fmt.Errorf("opencode %s %s: status %d: %s", method, path, resp.StatusCode, strings.TrimSpace(string(respBody)))
		return &statusError{status: resp.StatusCode, err: err}
	}
	if out == nil || len(respBody) == 0 {
		return nil
	}
	if err := json.Unmarshal(respBody, out); err != nil {
		return fmt.Errorf("opencode %s %s: parsing response: %w", method, path, err)
	}
	return nil
}

// doData is doJSON for the 2.x envelope: the answer is {data, location?}, and
// out receives data.
func (b *Backend) doData(ctx context.Context, method, path string, body any, out any) error {
	return b.doDataLimit(ctx, method, path, body, out, 4<<20)
}

func (b *Backend) doDataLimit(ctx context.Context, method, path string, body any, out any, limit int64) error {
	if out == nil {
		return b.doJSONLimit(ctx, method, path, body, nil, limit)
	}
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := b.doJSONLimit(ctx, method, path, body, &env, limit); err != nil {
		return err
	}
	if len(env.Data) == 0 {
		return nil
	}
	if err := json.Unmarshal(env.Data, out); err != nil {
		return fmt.Errorf("opencode %s %s: parsing data: %w", method, path, err)
	}
	return nil
}

// noteDir records a directory sessions live in, so pending asks can be found
// per location (2.x lists them per directory).
func (b *Backend) noteDir(dir string) {
	if dir == "" {
		return
	}
	b.asm.mu.Lock()
	b.asm.knownDirs()[dir] = true
	b.asm.mu.Unlock()
}

// sessionDir is a session's directory as events or listings showed it, else as
// the session record says ("" when unknown).
func (b *Backend) sessionDir(sessionID string) string {
	b.asm.mu.Lock()
	dir := b.asm.dirs[sessionID]
	b.asm.mu.Unlock()
	if dir != "" {
		return dir
	}
	if info := b.fetchSessionInfo(sessionID); info != nil {
		return getStr(info, "directory")
	}
	return ""
}

// fetchSessionInfo reads one session as a 1.x info map, nil when it cannot be read.
func (b *Backend) fetchSessionInfo(sessionID string) map[string]any {
	var m map[string]any
	ctx, cancel := context.WithTimeout(context.Background(), doJSONTimeout)
	defer cancel()
	if err := b.doData(ctx, http.MethodGet, "/api/session/"+url.PathEscape(sessionID), nil, &m); err != nil || m == nil {
		return nil
	}
	info := sessionInfoV1(m)
	if dir := getStr(info, "directory"); dir != "" {
		b.asm.mu.Lock()
		b.asm.dirs[sessionID] = dir
		b.asm.mu.Unlock()
		b.noteDir(dir)
	}
	return info
}

func (b *Backend) Capabilities() backend.Capabilities {
	return backend.Capabilities{
		Diff: true, Children: true, Usage: true, Compact: true,
		Images: true, Files: true, Worktrees: false,
		Questions: true, Revert: true, RevertFiles: true, Efforts: true, ToolImages: true,
		// galopin's own tools are installed only with a ToolsDir; a prompt sent
		// mid-turn is steered into the running turn (delivery "steer").
		AgentTools: b.toolsEnabled(), Steer: true,
		// A grant needs the tools and rules galopin composes itself.
		CoordinationGrant: b.toolsEnabled() && b.cfg.Permissions != nil,
		// The schedule tools are installed with the others.
		ScheduleTools: b.toolsEnabled(),
		// 2.x's message list pages by cursor (before a message, newest first).
		HistoryPaging: true,
		// 2.x serves commands (GET /api/command, POST .../command).
		Commands: true,
	}
}

// Revert rolls the session back to just before messageID: 2.x stages the
// revert (the later messages stay until the next prompt commits it, so Unrevert
// can bring them back) and puts revert.messageID on the session; Transcript
// hides them. files:true restores the working tree too.
func (b *Backend) Revert(ctx context.Context, workspaceDir, sessionID, messageID string) error {
	body := map[string]any{"messageID": messageID, "files": true}
	return b.doJSON(ctx, http.MethodPost, "/api/session/"+url.PathEscape(sessionID)+"/revert/stage", body, nil)
}

// Unrevert restores what the last Revert hid (before any new prompt).
func (b *Backend) Unrevert(ctx context.Context, workspaceDir, sessionID string) error {
	return b.doJSON(ctx, http.MethodDelete, "/api/session/"+url.PathEscape(sessionID)+"/revert", nil, nil)
}

// revertPoint is the message a session is currently rolled back to (its
// revert.messageID), or "" when it is not reverted.
func (b *Backend) revertPoint(ctx context.Context, sessionID string) string {
	var m map[string]any
	if err := b.doData(ctx, http.MethodGet, "/api/session/"+url.PathEscape(sessionID), nil, &m); err != nil {
		return ""
	}
	return getStr(getMap(m, "revert"), "messageID", "messageId")
}

func (b *Backend) ListSessions(ctx context.Context, workspaceDir string) ([]backend.Session, error) {
	var out []backend.Session
	cursor := ""
	for page := 0; page < 50; page++ {
		path := "/api/session?limit=200"
		if workspaceDir != "" {
			path += "&directory=" + url.QueryEscape(workspaceDir)
		}
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		var env struct {
			Data   []map[string]any `json:"data"`
			Cursor struct {
				Next string `json:"next"`
			} `json:"cursor"`
		}
		if err := b.doJSON(ctx, http.MethodGet, path, nil, &env); err != nil {
			return nil, err
		}
		for _, m := range env.Data {
			info := sessionInfoV1(m)
			b.noteDir(getStr(info, "directory"))
			s := sessionFromMap(info)
			b.noteSession(s)
			out = append(out, b.withUsage(s))
		}
		if env.Cursor.Next == "" || len(env.Data) == 0 {
			break
		}
		cursor = env.Cursor.Next
	}
	if out == nil {
		out = []backend.Session{}
	}
	return out, nil
}

func (b *Backend) GetSession(ctx context.Context, _ string, sessionID string) (backend.Session, error) {
	var m map[string]any
	if err := b.doData(ctx, http.MethodGet, "/api/session/"+url.PathEscape(sessionID), nil, &m); err != nil {
		return backend.Session{}, err
	}
	s := sessionFromMap(sessionInfoV1(m))
	b.noteSession(s)
	ov := b.getOverlay(sessionID)
	s.ModeID, s.ModelID, s.Effort = ov.ModeID, ov.ModelID, ov.Effort
	if s.ModelID == "" && s.ParentID != "" {
		// A subagent runs on its parent's model and has no choice of its own
		// to report: say what it actually ran on, so the panel does not fall
		// back to naming the machine's default model for it.
		s.ModelID = b.subagentModel(ctx, sessionID, getMap(m, "model"))
	}
	return b.withUsage(s), nil
}

// subagentModel is the model a subagent ran on: from the event stream when
// this process saw one, else the session's own model, else its newest
// assistant message, else "".
func (b *Backend) subagentModel(ctx context.Context, sessionID string, sessionModel map[string]any) string {
	if m := b.sessionModelOf(sessionID); m != "" {
		return m
	}
	if id, p := getStr(sessionModel, "id"), getStr(sessionModel, "providerID"); id != "" && p != "" {
		return p + "/" + id
	}
	var raw []any
	if err := b.doData(ctx, http.MethodGet, "/api/session/"+url.PathEscape(sessionID)+"/message?limit=10&order=desc", nil, &raw); err != nil {
		return ""
	}
	for _, m := range asMaps(raw) {
		if getStr(m, "type") != "assistant" {
			continue
		}
		b.noteSessionModel(sessionID, assistantInfo(sessionID, m))
		if m := b.sessionModelOf(sessionID); m != "" {
			return m
		}
	}
	return ""
}

func (b *Backend) CreateSession(ctx context.Context, workspaceDir string, opts backend.CreateSessionOptions) (backend.Session, error) {
	body := map[string]any{}
	if workspaceDir != "" {
		body["location"] = map[string]any{"directory": workspaceDir}
	}
	if opts.Title != "" {
		body["title"] = opts.Title
	}
	var m map[string]any
	if err := b.doData(ctx, http.MethodPost, "/api/session", body, &m); err != nil {
		return backend.Session{}, err
	}
	info := sessionInfoV1(m)
	b.noteDir(getStr(info, "directory"))
	s := sessionFromMap(info)
	if opts.ModeID != "" || opts.ModelID != "" || opts.SpawnedBy != nil {
		if err := b.setOverlay(s.ID, sessionOverlay{ModeID: opts.ModeID, ModelID: opts.ModelID, SpawnedBy: opts.SpawnedBy}); err != nil {
			return backend.Session{}, err
		}
	}
	s.ModeID, s.ModelID = opts.ModeID, opts.ModelID
	return b.withUsage(s), nil
}

func (b *Backend) RenameSession(ctx context.Context, _ string, sessionID, title string) (backend.Session, error) {
	var m map[string]any
	if err := b.doData(ctx, http.MethodPatch, "/api/session/"+url.PathEscape(sessionID), map[string]any{"title": title}, &m); err != nil {
		return backend.Session{}, err
	}
	s := sessionFromMap(sessionInfoV1(m))
	ov := b.getOverlay(sessionID)
	s.ModeID, s.ModelID = ov.ModeID, ov.ModelID
	return b.withUsage(s), nil
}

func (b *Backend) DeleteSession(ctx context.Context, _ string, sessionID string) error {
	b.att.Forget(sessionID)
	b.diffs.Forget(sessionID)
	return b.doJSON(ctx, http.MethodDelete, "/api/session/"+url.PathEscape(sessionID), nil, nil)
}

// planNoteKey is the session instruction entry that carries planNote.
const planNoteKey = "galopin-plan"

// applySelection makes the session's agent, model and variant what the overlay
// says. 2.x keeps them as session state (a prompt carries none), so a change is
// written once, before the prompt that needs it.
func (b *Backend) applySelection(ctx context.Context, sessionID string) error {
	ov := b.getOverlay(sessionID)
	b.selMu.Lock()
	cur := b.selApplied[sessionID]
	b.selMu.Unlock()
	if ov.ModeID != "" && ov.ModeID != cur.agent {
		if err := b.doJSON(ctx, http.MethodPost, "/api/session/"+url.PathEscape(sessionID)+"/agent", map[string]any{"agent": ov.ModeID}, nil); err != nil {
			return err
		}
		cur.agent = ov.ModeID
	}
	if ov.ModelID != "" && (ov.ModelID != cur.model || ov.Effort != cur.effort) {
		providerID, modelID := splitModelID(ov.ModelID)
		ref := map[string]any{"id": modelID, "providerID": providerID}
		if ov.Effort != "" {
			ref["variant"] = ov.Effort
		}
		if err := b.doJSON(ctx, http.MethodPost, "/api/session/"+url.PathEscape(sessionID)+"/model", map[string]any{"model": ref}, nil); err != nil {
			return err
		}
		cur.model, cur.effort = ov.ModelID, ov.Effort
	} else if ov.ModelID == "" && ov.Effort != cur.effort {
		// A variant belongs to a model reference, and the overlay chose no
		// model: write the session's own (or the default) model with it.
		base := cur.model
		if base == "" {
			base = b.sessionOrDefaultModel(ctx, sessionID)
		}
		if base == "" {
			return fmt.Errorf("opencode: no model known to apply the %q effort to", ov.Effort)
		}
		providerID, modelID := splitModelID(base)
		ref := map[string]any{"id": modelID, "providerID": providerID}
		if ov.Effort != "" {
			ref["variant"] = ov.Effort
		}
		if err := b.doJSON(ctx, http.MethodPost, "/api/session/"+url.PathEscape(sessionID)+"/model", map[string]any{"model": ref}, nil); err != nil {
			return err
		}
		cur.model, cur.effort = base, ov.Effort
	}
	b.selMu.Lock()
	b.selApplied[sessionID] = cur
	b.selMu.Unlock()
	return nil
}

// sessionOrDefaultModel is "provider/model" of the session's own model, else the
// server's default one for the session's directory, "" when neither is known.
func (b *Backend) sessionOrDefaultModel(ctx context.Context, sessionID string) string {
	var m map[string]any
	if err := b.doData(ctx, http.MethodGet, "/api/session/"+url.PathEscape(sessionID), nil, &m); err == nil {
		if id := modelRefString(getMap(m, "model")); id != "" {
			return id
		}
	}
	var def map[string]any
	if err := b.doData(ctx, http.MethodGet, withLoc("/api/model/default", b.sessionDir(sessionID)), nil, &def); err == nil {
		return modelRefString(def)
	}
	return ""
}

// syncPlanNote puts planNote on the session as an instruction entry while the
// session is on Plan and takes it off otherwise (2.x has no per-turn `system`).
func (b *Backend) syncPlanNote(ctx context.Context, sessionID string, want bool) {
	b.selMu.Lock()
	cur := b.planNoteOn[sessionID]
	b.selMu.Unlock()
	if cur == want {
		return
	}
	path := "/api/experimental/session/" + url.PathEscape(sessionID) + "/instructions/entries/" + planNoteKey
	var err error
	if want {
		err = b.doJSON(ctx, http.MethodPut, path, map[string]any{"value": planNote}, nil)
	} else {
		err = b.doJSON(ctx, http.MethodDelete, path, nil, nil)
		if notFound(err) {
			err = nil
		}
	}
	if err != nil {
		b.cfg.Logf("opencode: plan note for %s: %v", sessionID, err)
		return
	}
	b.selMu.Lock()
	b.planNoteOn[sessionID] = want
	b.selMu.Unlock()
}

func (b *Backend) Prompt(ctx context.Context, workspaceDir string, sessionID string, prompt backend.Prompt) error {
	// A session an older galopin gave rules is neutralised once (ADR 0097);
	// every other session has none and nothing is written to it.
	b.prepareSession(ctx, workspaceDir, sessionID)
	if err := b.applySelection(ctx, sessionID); err != nil {
		return err
	}
	b.syncPlanNote(ctx, sessionID, b.cfg.Permissions != nil && b.PermissionMode(sessionID) == permrules.Deny)
	if prompt.Preface != "" {
		// A synthetic message ahead of the prompt: the model reads it, the
		// transcript folds it into the next user message as a synthetic part
		// (PROTOCOL.md §7). resume:false so it does not start a turn alone.
		prefaceID := mintMessageID()
		b.recordPreface(prefaceID)
		if err := b.doJSON(ctx, http.MethodPost, "/api/session/"+url.PathEscape(sessionID)+"/synthetic",
			map[string]any{"id": prefaceID, "text": prompt.Preface, "delivery": "steer", "resume": false}, nil); err != nil {
			return err
		}
	}
	messageID := mintMessageID()
	body := map[string]any{"id": messageID, "text": prompt.Text, "delivery": "steer"}
	if len(prompt.Attachments) > 0 {
		files := make([]map[string]any, 0, len(prompt.Attachments))
		for _, a := range prompt.Attachments {
			f := map[string]any{"uri": a.URL}
			if a.Filename != "" {
				f["name"] = a.Filename
			}
			files = append(files, f)
		}
		body["files"] = files
	}
	if prompt.SentBy != nil {
		b.recordSentMarker(messageID, *prompt.SentBy)
	}
	if prompt.ClientMessageID != "" {
		b.recordExactClientMessageID(messageID, prompt.ClientMessageID)
		b.claimPendingClientMessageID(sessionID, messageID, prompt.ClientMessageID)
	}
	return b.doJSON(ctx, http.MethodPost, "/api/session/"+url.PathEscape(sessionID)+"/prompt", body, nil)
}

func (b *Backend) Cancel(ctx context.Context, _ string, sessionID string) error {
	return b.doJSON(ctx, http.MethodPost, "/api/session/"+url.PathEscape(sessionID)+"/interrupt", nil, nil)
}

func (b *Backend) SetMode(ctx context.Context, workspaceDir, sessionID, modeID string) (backend.Session, error) {
	ov := b.getOverlay(sessionID)
	ov.ModeID = modeID
	if err := b.setOverlay(sessionID, ov); err != nil {
		return backend.Session{}, err
	}
	return b.GetSession(ctx, workspaceDir, sessionID)
}

func (b *Backend) SetModel(ctx context.Context, workspaceDir, sessionID, modelID string) (backend.Session, error) {
	ov := b.getOverlay(sessionID)
	ov.ModelID = modelID
	if err := b.setOverlay(sessionID, ov); err != nil {
		return backend.Session{}, err
	}
	return b.GetSession(ctx, workspaceDir, sessionID)
}

// SetEffort remembers the variant sent with this session's prompts.
func (b *Backend) SetEffort(ctx context.Context, workspaceDir, sessionID, effort string) (backend.Session, error) {
	ov := b.getOverlay(sessionID)
	ov.Effort = effort
	if err := b.setOverlay(sessionID, ov); err != nil {
		return backend.Session{}, err
	}
	return b.GetSession(ctx, workspaceDir, sessionID)
}

func (b *Backend) ReplyPermission(ctx context.Context, workspaceDir string, sessionID string, requestID string, decision backend.Decision, message string) error {
	// galopin's own approvals (session_spawn/session_send) are held here and
	// never forwarded: opencode does not know them.
	if strings.HasPrefix(requestID, galopinAskPrefix) {
		return b.replyGalopinAsk(ctx, sessionID, requestID, decision, message)
	}
	// 2.x keeps an "always" in a project-wide saved store that outlives the
	// session and sits beneath galopin's ceiling: whatever the caller says,
	// opencode is answered once (the exception, if any, is galopin's own).
	if decision == backend.DecisionAlways {
		decision = backend.DecisionOnce
	}
	body := map[string]any{"decision": string(decision)}
	if message != "" {
		body["message"] = message
	}
	err := b.doJSON(ctx, http.MethodPost, "/api/session/"+url.PathEscape(sessionID)+"/permission/"+url.PathEscape(requestID)+"/reply", body, nil)
	if err != nil && strings.Contains(err.Error(), "status 404") && strings.Contains(err.Error(), "PermissionNotFoundError") {
		// opencode no longer holds the ask: something else answered it (the
		// machine's own auto-answer for a subagent its root allows, another
		// client) or its process restarted. Not a failure the caller can fix.
		return fmt.Errorf("%w: %v", backend.ErrPermissionGone, err)
	}
	return err
}

// agentEntries is GET /api/agent for a directory. A location opencode has just
// opened answers with the agents loaded so far (the config layers, the project's
// own agents and the plugins' arrive one after another), so the first read per
// directory and process is repeated until two answers in a row agree; later
// reads are single, since a warm location is already complete.
func (b *Backend) agentEntries(ctx context.Context, workspaceDir string) ([]map[string]any, error) {
	b.perm.agentMu.Lock()
	warm := b.perm.agentsWarm[workspaceDir]
	b.perm.agentMu.Unlock()
	var last []map[string]any
	prev := ""
	for attempt := 0; attempt < 16; attempt++ {
		var raw []any
		if err := b.doData(ctx, http.MethodGet, withLoc("/api/agent", workspaceDir), nil, &raw); err != nil {
			return nil, err
		}
		last = asMaps(raw)
		if warm {
			return last, nil
		}
		enc, _ := json.Marshal(last)
		if len(last) > 0 && string(enc) == prev {
			b.perm.agentMu.Lock()
			if b.perm.agentsWarm == nil {
				b.perm.agentsWarm = map[string]bool{}
			}
			b.perm.agentsWarm[workspaceDir] = true
			b.perm.agentMu.Unlock()
			return last, nil
		}
		prev = string(enc)
		select {
		case <-ctx.Done():
			return last, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	return last, nil
}

func (b *Backend) Modes(ctx context.Context, workspaceDir string) ([]backend.Mode, error) {
	entries, err := b.agentEntries(ctx, workspaceDir)
	if err != nil {
		return nil, err
	}
	out := make([]backend.Mode, 0, len(entries))
	for _, m := range entries {
		if mode, ok := modeFromAgentMap(m); ok {
			out = append(out, mode)
		}
	}
	return out, nil
}

// AgentModels implements backend.AgentLister from the same GET /api/agent
// Modes reads: every agent the server can run — primary modes AND subagents —
// mapped to its configured model, "" when the agent pins none. The command
// gate needs the FULL list, not the primary projection: a command naming a
// subagent must resolve too. A failed read answers nil — the dispatch then
// refuses agent-naming commands rather than assuming a model the server never
// confirmed (the same fail-closed shape as L6).
//
// opencode answers /api/agent per directory: a project's own agents exist only
// for that workspace, so the directory is always sent.
func (b *Backend) AgentModels(ctx context.Context, workspaceDir string) map[string]string {
	entries, err := b.agentEntries(ctx, workspaceDir)
	if err != nil {
		b.cfg.Logf("opencode: listing agents for the command gate: %v", err)
		return nil
	}
	out := make(map[string]string, len(entries))
	for _, m := range entries {
		name := getStr(m, "id", "name")
		if name == "" {
			continue
		}
		out[name] = modelRefString(getMap(m, "model"))
	}
	return out
}

// modelRefString is "<providerID>/<id>" for a model reference, "" for none.
func modelRefString(ref map[string]any) string {
	id, p := getStr(ref, "id"), getStr(ref, "providerID")
	if id == "" {
		return ""
	}
	if p == "" {
		return id
	}
	return p + "/" + id
}

func (b *Backend) Models(ctx context.Context, workspaceDir string) ([]backend.Model, error) {
	var list []any
	if err := b.doData(ctx, http.MethodGet, withLoc("/api/model", workspaceDir), nil, &list); err != nil {
		return nil, err
	}
	var def map[string]any
	_ = b.doData(ctx, http.MethodGet, withLoc("/api/model/default", workspaceDir), nil, &def)
	defID := modelRefString(def)
	var out []backend.Model
	newLimits := map[string]int{}
	for _, mm := range asMaps(list) {
		if !getBool(mm, "enabled") && mm["enabled"] != nil {
			continue
		}
		providerID, modelID := getStr(mm, "providerID"), getStr(mm, "modelID", "id")
		id := providerID + "/" + modelID
		model := backend.Model{ID: id, Label: getStr(mm, "name"), ProviderID: providerID}
		if model.Label == "" {
			model.Label = modelID
		}
		if limit := getMap(mm, "limit"); limit != nil {
			model.ContextWindow = getInt(limit, "context")
			newLimits[id] = model.ContextWindow
		}
		// The model's own image claim: capabilities.input lists its input
		// modalities. A model nobody claims anything about stays false — the
		// wire's fail-closed answer.
		for _, in := range asStringList(getMap(mm, "capabilities")["input"]) {
			if in == "image" {
				model.Images = true
			}
		}
		model.Efforts = variantIDsV2(getSlice(mm, "variants"))
		model.Reasoning = len(model.Efforts) > 0
		model.IsDefault = defID != "" && defID == id
		out = append(out, model)
	}
	b.modelsMu.Lock()
	b.modelLimit = newLimits
	b.modelsMu.Unlock()
	return out, nil
}

func asStringList(v any) []string { return asStrings(v) }

// variantIDsV2 lists a model's variant ids (thinking-effort levels), usual ones
// low to high, others after, alphabetically; disabled ones are left out.
func variantIDsV2(variants []any) []string {
	m := map[string]any{}
	for _, v := range asMaps(variants) {
		id := getStr(v, "id")
		if id != "" {
			m[id] = v
		}
	}
	return variantIDs(m)
}

// messagePageLimit is how many messages one list call reads.
const messagePageLimit = 100

// messagesPage reads one page of a session's messages. order is "asc" or
// "desc"; cursor continues a previous page.
func (b *Backend) messagesPage(ctx context.Context, sessionID, order, cursor string, limit int) (msgs []any, next string, err error) {
	path := "/api/session/" + url.PathEscape(sessionID) + "/message?limit=" + strconv.Itoa(limit)
	if cursor != "" {
		// the cursor carries its own order: the server refuses both
		path += "&cursor=" + url.QueryEscape(cursor)
	} else {
		path += "&order=" + order
	}
	var env struct {
		Data   []any `json:"data"`
		Cursor struct {
			Next string `json:"next"`
		} `json:"cursor"`
	}
	if err := b.doJSONLimit(ctx, http.MethodGet, path, nil, &env, maxTranscriptBytes); err != nil {
		return nil, "", err
	}
	return env.Data, env.Cursor.Next, nil
}

// allMessages reads a session's whole message list, oldest first.
func (b *Backend) allMessages(ctx context.Context, sessionID string) ([]any, error) {
	var all []any
	cursor := ""
	for page := 0; page < 1000; page++ {
		msgs, next, err := b.messagesPage(ctx, sessionID, "asc", cursor, messagePageLimit)
		if err != nil {
			return nil, err
		}
		all = append(all, msgs...)
		if next == "" || len(msgs) == 0 {
			break
		}
		cursor = next
	}
	return all, nil
}

func (b *Backend) entryToTranscript(sessionID string, entry map[string]any) backend.TranscriptEntry {
	info := getMap(entry, "info")
	msg := messageFromMap(info)
	b.resolveClientMessageID(sessionID, &msg)
	var parts []backend.Part
	for _, pm := range asMaps(getSlice(entry, "parts")) {
		parts = append(parts, b.mapPart(sessionID, pm))
	}
	return backend.TranscriptEntry{Message: msg, Parts: parts}
}

func (b *Backend) Transcript(ctx context.Context, workspaceDir string, sessionID string) (backend.Transcript, error) {
	// A reverted session still stores the messages from its revert point on
	// (until the next prompt), but they are no longer part of it. The revert
	// point is read BEFORE the message list, never after: the next prompt's
	// cleanup deletes those messages and only then clears the marker, so a
	// marker read first is either still set (the list may still hold the
	// reverted messages, and we cut at it) or already cleared (the list is
	// read after the deletion). Read the other way round, a cleanup landing
	// between the two reads returns the reverted turn with no marker to hide
	// it, and the transcript resurrects a turn that was rolled back.
	revertedFrom := b.revertPoint(ctx, sessionID)
	raw, err := b.allMessages(ctx, sessionID)
	if err != nil {
		return backend.Transcript{}, err
	}
	tr := backend.Transcript{Status: backend.StatusIdle}
	for _, entry := range v1Entries(sessionID, raw, b.isPreface) {
		info := getMap(entry, "info")
		if revertedFrom != "" && getStr(info, "id") == revertedFrom {
			break
		}
		te := b.entryToTranscript(sessionID, entry)
		tr.Messages = append(tr.Messages, te)
		if te.Message.Role == "assistant" {
			if u := usageFromMessageMap(info); u != nil {
				b.fillContextMax(info, u)
				tr.Usage = u
				b.setSessionUsage(sessionID, u)
			}
			if te.Message.Error != "" {
				tr.Status = backend.StatusError
			}
		}
	}

	var permsRaw []any
	if err := b.doData(ctx, http.MethodGet, "/api/session/"+url.PathEscape(sessionID)+"/permission", nil, &permsRaw); err == nil {
		for _, pm := range asMaps(permsRaw) {
			p := v1Permission(pm)
			b.enrichAsk(ctx, p)
			tr.Permissions = append(tr.Permissions, permissionFromMap(p))
		}
	}

	// Unanswered question-tool asks: forms still pending for the session.
	var forms []any
	if err := b.doData(ctx, http.MethodGet, "/api/session/"+url.PathEscape(sessionID)+"/form", nil, &forms); err == nil {
		for _, fm := range asMaps(forms) {
			if state := getMap(fm, "state"); state != nil && getStr(state, "status") != "pending" {
				continue
			}
			if qm, ok := v1Question(fm); ok {
				q := questionRequestFromMap(qm)
				if q.id != "" {
					tr.Questions = append(tr.Questions, backend.QuestionRequest{ID: q.id, Questions: q.questions, CallID: q.callID})
				}
			}
		}
	}
	return tr, nil
}

// History implements backend.HistoryPager (PROTOCOL.md §6 session.history):
// the newest limit messages strictly older than before, ascending — the same
// per-message mapping Transcript applies, minus permissions, questions,
// status and usage (live state no older page carries), and under the same
// revert cut, so a page can never resurrect a rolled-back turn.
//
// 2.x pages by an opaque cursor; its encoding ({id, order, direction},
// base64url) is the one the server hands back as `cursor.next`, built here for
// a message the caller names, newest first. The list includes entries that are
// not messages to galopin (idle markers, agent switches), so pages are read
// until limit mappable entries are found or the list ends.
func (b *Backend) History(ctx context.Context, workspaceDir, sessionID, before string, limit int) (backend.HistoryPage, error) {
	if before == "" {
		return backend.HistoryPage{}, fmt.Errorf("history needs the message id to page below")
	}
	if limit < 1 {
		return backend.HistoryPage{}, fmt.Errorf("history needs a positive limit")
	}
	// The revert point is read BEFORE the message list, exactly as Transcript
	// reads it (see there).
	revertedFrom := b.revertPoint(ctx, sessionID)
	cursor, err := messageCursor(before)
	if err != nil {
		return backend.HistoryPage{}, err
	}
	var entries []map[string]any // newest first
	more := false
	for page := 0; page < 20; page++ {
		msgs, next, err := b.messagesPage(ctx, sessionID, "desc", cursor, messagePageLimit)
		if err != nil {
			if strings.Contains(err.Error(), "status 404") || strings.Contains(err.Error(), "status 400") {
				// A message the storage no longer holds (a revert's cleanup
				// deletes the reverted turns) has nothing older to page
				// through: an empty page ends the walk instead of failing it.
				return backend.HistoryPage{}, nil
			}
			return backend.HistoryPage{}, err
		}
		// the page is newest first; v1Entries wants oldest first
		for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
			msgs[i], msgs[j] = msgs[j], msgs[i]
		}
		pageEntries := v1Entries(sessionID, msgs, b.isPreface)
		for i := len(pageEntries) - 1; i >= 0; i-- {
			entries = append(entries, pageEntries[i])
		}
		if len(entries) > limit {
			more = true
			break
		}
		if next == "" || len(msgs) == 0 {
			break
		}
		cursor = next
	}
	if len(entries) > limit {
		entries = entries[:limit]
	}
	// ascending
	for i, j := 0, len(entries)-1; i < j; i, j = i+1, j-1 {
		entries[i], entries[j] = entries[j], entries[i]
	}
	pageOut := backend.HistoryPage{HasMore: more}
	for _, entry := range entries {
		if revertedFrom != "" && getStr(getMap(entry, "info"), "id") == revertedFrom {
			break
		}
		pageOut.Entries = append(pageOut.Entries, b.entryToTranscript(sessionID, entry))
	}
	if len(pageOut.Entries) > 0 {
		pageOut.Before = pageOut.Entries[0].Message.ID
	}
	return pageOut, nil
}

// messageCursor encodes the paging cursor 2.x's message list answers with for
// "the messages after this one, newest first": base64url of
// {"id","order":"desc","direction":"next"}.
func messageCursor(messageID string) (string, error) {
	body, err := json.Marshal(struct {
		ID        string `json:"id"`
		Order     string `json:"order"`
		Direction string `json:"direction"`
	}{messageID, "desc", "next"})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(body), nil
}

func (b *Backend) Diff(ctx context.Context, workspaceDir string, sessionID string) ([]backend.FileDiff, error) {
	var raw []any
	if err := b.doData(ctx, http.MethodGet, "/api/session/"+url.PathEscape(sessionID)+"/diff", nil, &raw); err != nil {
		return nil, err
	}
	out := make([]backend.FileDiff, 0, len(raw))
	for _, m := range asMaps(raw) {
		out = append(out, fileDiffFromPatch(workspaceDir, m))
	}
	return mergeOwnDiffs(workspaceDir, out, b.diffs.Diffs(sessionID)), nil
}

func (b *Backend) Children(ctx context.Context, workspaceDir string, sessionID string) ([]backend.Session, error) {
	var env struct {
		Data []map[string]any `json:"data"`
	}
	path := "/api/session?limit=200&parentID=" + url.QueryEscape(sessionID)
	if workspaceDir != "" {
		path += "&directory=" + url.QueryEscape(workspaceDir)
	}
	if err := b.doJSON(ctx, http.MethodGet, path, nil, &env); err != nil {
		return nil, err
	}
	out := make([]backend.Session, 0, len(env.Data))
	for _, m := range env.Data {
		out = append(out, sessionFromMap(sessionInfoV1(m)))
	}
	return out, nil
}

func (b *Backend) Compact(ctx context.Context, _ string, sessionID string) error {
	// 2.x compacts on the session's own model; the manual compaction is marked
	// reason "manual" (PROTOCOL.md §7's compaction part distinguishes it from
	// opencode's own context-overflow trigger).
	// The session's own model is the one that summarizes, so the overlay's choice
	// is written first, as a prompt would.
	if err := b.applySelection(ctx, sessionID); err != nil {
		return err
	}
	return b.doJSON(ctx, http.MethodPost, "/api/session/"+url.PathEscape(sessionID)+"/compact", map[string]any{}, nil)
}

// pendingForm reads one pending form of a session.
func (b *Backend) pendingForm(ctx context.Context, sessionID, formID string) (map[string]any, error) {
	var form map[string]any
	if err := b.doData(ctx, http.MethodGet, "/api/session/"+url.PathEscape(sessionID)+"/form/"+url.PathEscape(formID), nil, &form); err != nil {
		return nil, err
	}
	return form, nil
}

// ReplyQuestion answers a pending question (a form: one field per question).
func (b *Backend) ReplyQuestion(ctx context.Context, workspaceDir, sessionID, requestID string, answers [][]string) error {
	form, err := b.pendingForm(ctx, sessionID, requestID)
	if err != nil {
		return err
	}
	body := map[string]any{"answer": formAnswer(form, answers)}
	return b.doJSON(ctx, http.MethodPost, "/api/session/"+url.PathEscape(sessionID)+"/form/"+url.PathEscape(requestID)+"/reply", body, nil)
}

// RejectQuestion dismisses a pending question without answering it — opencode
// reports the tool call itself as an error ("The user dismissed this question").
func (b *Backend) RejectQuestion(ctx context.Context, workspaceDir, sessionID, requestID string) error {
	return b.doJSON(ctx, http.MethodDelete, "/api/session/"+url.PathEscape(sessionID)+"/form/"+url.PathEscape(requestID), nil, nil)
}

// splitModelID turns "<providerID>/<modelID>" into its two halves. A
// malformed id (no slash) is passed through as the model half with an
// empty provider, which opencode will simply refuse — better than this
// package guessing.
func splitModelID(id string) (providerID, modelID string) {
	if i := strings.IndexByte(id, '/'); i >= 0 {
		return id[:i], id[i+1:]
	}
	return "", id
}

// effortOrder ranks the usual variant ids, so a picker lists them low to high.
var effortOrder = map[string]int{"minimal": 0, "low": 1, "medium": 2, "high": 3, "max": 4}

// variantIDs lists a model's enabled variant ids (opencode's thinking-effort
// levels), usual ones in low-to-high order, any others after, alphabetically.
func variantIDs(variants map[string]any) []string {
	var ids []string
	for id, raw := range variants {
		if v, ok := raw.(map[string]any); ok && getBool(v, "disabled") {
			continue
		}
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		ri, iok := effortOrder[ids[i]]
		rj, jok := effortOrder[ids[j]]
		switch {
		case iok && jok:
			return ri < rj
		case iok != jok:
			return iok
		default:
			return ids[i] < ids[j]
		}
	})
	return ids
}

// enrichAsk adds the call's arguments to a permission payload read from a REST
// listing (PendingAsks, Transcript): the event stream's adapter already saw them
// go by, a listing did not.
func (b *Backend) enrichAsk(ctx context.Context, p map[string]any) {
	tool := getMap(p, "tool")
	mid, call := getStr(tool, "messageID"), getStr(tool, "callID")
	sid := getStr(p, "sessionID")
	if mid == "" || call == "" || sid == "" {
		return
	}
	b.asm.mu.Lock()
	in := b.asm.inputs[mid+":"+call]
	b.asm.mu.Unlock()
	if in == nil {
		var raw map[string]any
		if err := b.doData(ctx, http.MethodGet, "/api/session/"+url.PathEscape(sid)+"/message/"+url.PathEscape(mid), nil, &raw); err == nil {
			for _, c := range asMaps(getSlice(raw, "content")) {
				if getStr(c, "type") == "tool" && getStr(c, "id") == call {
					in = getMap(getMap(c, "state"), "input")
				}
			}
		}
	}
	addAskMetadata(p, in)
}
