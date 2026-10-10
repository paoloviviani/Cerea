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

func directoryQuery(workspaceDir string) string {
	return "?directory=" + url.QueryEscape(workspaceDir)
}

func (b *Backend) Capabilities() backend.Capabilities {
	return backend.Capabilities{
		Diff: true, Children: true, Usage: true, Compact: true,
		Images: true, Files: true, Worktrees: false,
		Questions: true, Revert: true, RevertFiles: true, Efforts: true, ToolImages: true,
		// galopin's own tools are installed only with a ToolsDir; opencode
		// folds a prompt sent mid-turn into the running turn (prompt_async).
		AgentTools: b.toolsEnabled(), Steer: true,
		// A grant needs the tools and rules galopin composes itself.
		CoordinationGrant: b.toolsEnabled() && b.cfg.Permissions != nil,
		// The schedule tools are installed with the others.
		ScheduleTools: b.toolsEnabled(),
		// opencode's message list pages (limit/before on GET
		// /session/:id/message — verified against the pinned server's own
		// source and its httpapi tests), so History serves older pages.
		HistoryPaging: true,
		// Probed from the server's own GET /doc (never a version string):
		// commands exist only when the server lists session.command there.
		Commands: b.commandsSupported(),
	}
}

// Revert rolls the session back to just before messageID. opencode keeps the
// reverted messages until the next prompt (so Unrevert can bring them back),
// marking the session with revert.messageID; Transcript hides them.
func (b *Backend) Revert(ctx context.Context, workspaceDir, sessionID, messageID string) error {
	body := map[string]any{"messageID": messageID}
	return b.doJSON(ctx, http.MethodPost, "/session/"+url.PathEscape(sessionID)+"/revert"+directoryQuery(workspaceDir), body, nil)
}

// Unrevert restores what the last Revert hid (before any new prompt).
func (b *Backend) Unrevert(ctx context.Context, workspaceDir, sessionID string) error {
	return b.doJSON(ctx, http.MethodPost, "/session/"+url.PathEscape(sessionID)+"/unrevert"+directoryQuery(workspaceDir), nil, nil)
}

// revertPoint is the message a session is currently rolled back to (its
// revert.messageID), or "" when it is not reverted.
func (b *Backend) revertPoint(ctx context.Context, sessionID string) string {
	var m map[string]any
	if err := b.doJSON(ctx, http.MethodGet, "/session/"+url.PathEscape(sessionID), nil, &m); err != nil {
		return ""
	}
	return getStr(getMap(m, "revert"), "messageID", "messageId")
}

func (b *Backend) ListSessions(ctx context.Context, workspaceDir string) ([]backend.Session, error) {
	var raw []any
	if err := b.doJSON(ctx, http.MethodGet, "/session"+directoryQuery(workspaceDir), nil, &raw); err != nil {
		return nil, err
	}
	out := make([]backend.Session, 0, len(raw))
	for _, m := range asMaps(raw) {
		s := sessionFromMap(m)
		b.noteSession(s)
		out = append(out, b.withUsage(s))
	}
	return out, nil
}

func (b *Backend) GetSession(ctx context.Context, _ string, sessionID string) (backend.Session, error) {
	var m map[string]any
	if err := b.doJSON(ctx, http.MethodGet, "/session/"+url.PathEscape(sessionID), nil, &m); err != nil {
		return backend.Session{}, err
	}
	s := sessionFromMap(m)
	b.noteSession(s)
	ov := b.getOverlay(sessionID)
	s.ModeID, s.ModelID, s.Effort = ov.ModeID, ov.ModelID, ov.Effort
	if s.ModelID == "" && s.ParentID != "" {
		// A subagent runs on its parent's model and has no choice of its own
		// to report: say what it actually ran on, so the panel does not fall
		// back to naming the machine's default model for it.
		s.ModelID = b.subagentModel(ctx, sessionID)
	}
	return b.withUsage(s), nil
}

// subagentModel is the model a subagent's newest assistant message ran on:
// from the event stream when this process saw one, else from its newest
// messages (a short page, not the whole transcript), else "".
func (b *Backend) subagentModel(ctx context.Context, sessionID string) string {
	if m := b.sessionModelOf(sessionID); m != "" {
		return m
	}
	var raw []any
	if err := b.doJSON(ctx, http.MethodGet, "/session/"+url.PathEscape(sessionID)+"/message?limit=10", nil, &raw); err != nil {
		return ""
	}
	entries := asMaps(raw)
	for i := len(entries) - 1; i >= 0; i-- {
		info := getMap(entries[i], "info")
		if info == nil || getStr(info, "role") != "assistant" {
			continue
		}
		b.noteSessionModel(sessionID, info)
		if m := b.sessionModelOf(sessionID); m != "" {
			return m
		}
	}
	return ""
}

func (b *Backend) CreateSession(ctx context.Context, workspaceDir string, opts backend.CreateSessionOptions) (backend.Session, error) {
	body := map[string]any{}
	if opts.Title != "" {
		body["title"] = opts.Title
	}
	// The machine's rules ride in the create itself, so the session has them
	// before its first prompt can exist — there is no window to close.
	agent := opts.ModeID
	if agent == "" {
		agent = defaultAgent
	}
	var rules []permrules.Rule
	if b.cfg.Permissions != nil {
		var err error
		if rules, err = b.composeFor(ctx, workspaceDir, agent, ""); err != nil {
			return backend.Session{}, err
		}
		if len(rules) > 0 {
			body["permission"] = rules
		}
	}
	var m map[string]any
	if err := b.doJSON(ctx, http.MethodPost, "/session"+directoryQuery(workspaceDir), body, &m); err != nil {
		return backend.Session{}, err
	}
	s := sessionFromMap(m)
	if opts.ModeID != "" || opts.ModelID != "" || opts.SpawnedBy != nil || len(rules) > 0 {
		if err := b.setOverlay(s.ID, sessionOverlay{ModeID: opts.ModeID, ModelID: opts.ModelID, SpawnedBy: opts.SpawnedBy, RulesFP: permrules.Fingerprint(rules)}); err != nil {
			return backend.Session{}, err
		}
	}
	s.ModeID, s.ModelID = opts.ModeID, opts.ModelID
	return b.withUsage(s), nil
}

func (b *Backend) RenameSession(ctx context.Context, _ string, sessionID, title string) (backend.Session, error) {
	var m map[string]any
	if err := b.doJSON(ctx, http.MethodPatch, "/session/"+url.PathEscape(sessionID), map[string]any{"title": title}, &m); err != nil {
		return backend.Session{}, err
	}
	s := sessionFromMap(m)
	ov := b.getOverlay(sessionID)
	s.ModeID, s.ModelID = ov.ModeID, ov.ModelID
	return b.withUsage(s), nil
}

func (b *Backend) DeleteSession(ctx context.Context, _ string, sessionID string) error {
	b.att.Forget(sessionID)
	return b.doJSON(ctx, http.MethodDelete, "/session/"+url.PathEscape(sessionID), nil, nil)
}

func (b *Backend) Prompt(ctx context.Context, workspaceDir string, sessionID string, prompt backend.Prompt) error {
	// Before anything is recorded or sent: a session whose rules are stale (the
	// ceiling tightened, its mode changed) is never prompted under them.
	if err := b.ensureRules(ctx, workspaceDir, sessionID, b.agentFor(sessionID)); err != nil {
		return err
	}
	parts := make([]map[string]any, 0, 2+len(prompt.Attachments))
	if prompt.Preface != "" {
		// A synthetic part: the model reads it, the transcript never shows it
		// as the person's text (PROTOCOL.md §7).
		parts = append(parts, map[string]any{"type": "text", "text": prompt.Preface, "synthetic": true})
	}
	if prompt.Text != "" {
		parts = append(parts, map[string]any{"type": "text", "text": prompt.Text})
	}
	for _, a := range prompt.Attachments {
		parts = append(parts, map[string]any{
			"type": "file", "mime": a.Mime, "filename": a.Filename, "url": a.URL,
		})
	}
	// prompt_async takes a caller-minted messageID (1.18.32's GET /doc and
	// the plan's live probing of session.command, which honours the same
	// field as the user message's id), so the id is minted here and the
	// clientMessageId is recorded against it before the POST — exact
	// mapping, not the "next new user message" guess. The guess survives
	// only as a fallback: if a server ever ignored or rewrote the id, the
	// minted id would never appear in the transcript and the pending claim
	// below maps the clientMessageId to the next user message as before
	// (prompt_async answers 204 empty, so there is nothing in the response
	// to map from). The fake-server test pins both halves.
	messageID := mintMessageID()
	body := map[string]any{"parts": parts, "messageID": messageID}
	if b.cfg.Permissions != nil && b.PermissionMode(sessionID) == permrules.Deny {
		// prompt_async's `system` is appended to the system prompt for this
		// turn: an instruction, not something the person said, so a model
		// follows it instead of thinking aloud about it in its answer (which
		// it did when this rode as a synthetic part of the user message).
		body["system"] = denyNote
	}
	ov := b.getOverlay(sessionID)
	if ov.ModeID != "" {
		body["agent"] = ov.ModeID
	}
	if ov.ModelID != "" {
		providerID, modelID := splitModelID(ov.ModelID)
		body["model"] = map[string]string{"providerID": providerID, "modelID": modelID}
	}
	if ov.Effort != "" {
		body["variant"] = ov.Effort
	}
	if prompt.SentBy != nil {
		b.recordSentMarker(messageID, *prompt.SentBy)
	}
	if prompt.ClientMessageID != "" {
		b.recordExactClientMessageID(messageID, prompt.ClientMessageID)
		b.claimPendingClientMessageID(sessionID, messageID, prompt.ClientMessageID)
	}
	return b.doJSON(ctx, http.MethodPost, "/session/"+url.PathEscape(sessionID)+"/prompt_async", body, nil)
}

func (b *Backend) Cancel(ctx context.Context, _ string, sessionID string) error {
	return b.doJSON(ctx, http.MethodPost, "/session/"+url.PathEscape(sessionID)+"/abort", nil, nil)
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
	body := map[string]any{"reply": string(decision)}
	if message != "" {
		body["message"] = message
	}
	// directory is optional in the OpenAPI schema but load-bearing in
	// practice (found live): omitting it 404s with PermissionNotFoundError
	// even for a request id that was just seen in a live permission.asked
	// event for this exact session.
	err := b.doJSON(ctx, http.MethodPost, "/permission/"+url.PathEscape(requestID)+"/reply"+directoryQuery(workspaceDir), body, nil)
	if err != nil && strings.Contains(err.Error(), "status 404") && strings.Contains(err.Error(), "PermissionNotFoundError") {
		// opencode no longer holds the ask: something else answered it (the
		// machine's own auto-answer for a subagent its root allows, another
		// client) or its process restarted. Not a failure the caller can fix.
		return fmt.Errorf("%w: %v", backend.ErrPermissionGone, err)
	}
	return err
}

func (b *Backend) Modes(ctx context.Context, workspaceDir string) ([]backend.Mode, error) {
	var raw []any
	if err := b.doJSON(ctx, http.MethodGet, "/agent"+directoryQuery(workspaceDir), nil, &raw); err != nil {
		return nil, err
	}
	out := make([]backend.Mode, 0, len(raw))
	for _, m := range asMaps(raw) {
		if mode, ok := modeFromAgentMap(m); ok {
			out = append(out, mode)
		}
	}
	return out, nil
}

// AgentModels implements backend.AgentLister from the same GET /agent
// Modes reads: every agent the server can run — primary modes AND
// subagents (mode "subagent", build/plan carry none on 1.18.32) — mapped
// to its configured model, "" when the agent pins none. The command gate
// needs the FULL list, not the primary projection: a command naming a
// subagent must resolve too. A failed read answers nil — the dispatch
// then refuses agent-naming commands rather than assuming a model the
// server never confirmed (the same fail-closed shape as L6).
//
// M9: opencode answers /agent per directory — a project's own
// .opencode/agent/*.md and opencode.json agents exist only for that
// workspace. Omitting directory reads the server's own working directory
// instead, which for a machine supervising opencode is never the
// workspace: every project-defined agent then reads as absent (the gate
// falls through to "unlisted", not "listed with this model"), and a
// project agent redefining a builtin's name masks it in the other
// direction — the gate sees the global builtin's real model (or its lack
// of one) rather than the project's.
func (b *Backend) AgentModels(ctx context.Context, workspaceDir string) map[string]string {
	var raw []any
	if err := b.doJSON(ctx, http.MethodGet, "/agent"+directoryQuery(workspaceDir), nil, &raw); err != nil {
		b.cfg.Logf("opencode: listing agents for the command gate: %v", err)
		return nil
	}
	out := make(map[string]string, len(raw))
	for _, m := range asMaps(raw) {
		name := getStr(m, "name")
		if name == "" {
			continue
		}
		out[name] = getStr(m, "model")
	}
	return out
}

func (b *Backend) Models(ctx context.Context, _ string) ([]backend.Model, error) {
	var root map[string]any
	if err := b.doJSON(ctx, http.MethodGet, "/config/providers", nil, &root); err != nil {
		return nil, err
	}
	defaults := getMap(root, "default")
	var out []backend.Model
	newLimits := map[string]int{}
	for _, p := range asMaps(getSlice(root, "providers")) {
		providerID := getStr(p, "id")
		modelsField, _ := p["models"].(map[string]any)
		for modelID, raw := range modelsField {
			mm, _ := raw.(map[string]any)
			if mm == nil {
				continue
			}
			id := providerID + "/" + modelID
			model := backend.Model{
				ID:         id,
				Label:      getStr(mm, "name"),
				ProviderID: providerID,
			}
			if model.Label == "" {
				model.Label = modelID
			}
			if limit := getMap(mm, "limit"); limit != nil {
				model.ContextWindow = getInt(limit, "context")
				newLimits[id] = model.ContextWindow
			}
			if attach := getMap(mm, "attachment"); attach != nil {
				model.Images = getBool(attach, "image")
			}
			model.Reasoning = getBool(mm, "reasoning")
			model.Efforts = variantIDs(getMap(mm, "variants"))
			if defaults != nil && getStr(defaults, providerID) == modelID {
				model.IsDefault = true
			}
			out = append(out, model)
		}
	}
	b.modelsMu.Lock()
	b.modelLimit = newLimits
	b.modelsMu.Unlock()
	return out, nil
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
	var raw []any
	if err := b.doJSONLimit(ctx, http.MethodGet, "/session/"+url.PathEscape(sessionID)+"/message", nil, &raw, maxTranscriptBytes); err != nil {
		return backend.Transcript{}, err
	}
	tr := backend.Transcript{Status: backend.StatusIdle}
	for _, entry := range asMaps(raw) {
		info := getMap(entry, "info")
		if info == nil {
			info = entry
		}
		msg := messageFromMap(info)
		if revertedFrom != "" && msg.ID == revertedFrom {
			break
		}
		b.resolveClientMessageID(sessionID, &msg)
		var parts []backend.Part
		for _, pm := range asMaps(getSlice(entry, "parts")) {
			parts = append(parts, b.mapPart(sessionID, pm))
		}
		tr.Messages = append(tr.Messages, backend.TranscriptEntry{Message: msg, Parts: parts})
		if msg.Role == "assistant" {
			if u := usageFromMessageMap(info); u != nil {
				b.fillContextMax(info, u)
				tr.Usage = u
				b.setSessionUsage(sessionID, u)
			}
			if msg.Error != "" {
				tr.Status = backend.StatusError
			}
		}
	}

	var permsRaw []any
	if err := b.doJSON(ctx, http.MethodGet, "/permission", nil, &permsRaw); err == nil {
		for _, pm := range asMaps(permsRaw) {
			req := permissionFromMap(pm)
			if req.SessionID == sessionID {
				tr.Permissions = append(tr.Permissions, req)
			}
		}
	}

	// Unanswered question-tool asks: opencode keeps them per directory.
	var questionsRaw []any
	if err := b.doJSON(ctx, http.MethodGet, "/question"+directoryQuery(workspaceDir), nil, &questionsRaw); err == nil {
		for _, qm := range asMaps(questionsRaw) {
			q := questionRequestFromMap(qm)
			if q.sessionID == sessionID && q.id != "" {
				tr.Questions = append(tr.Questions, backend.QuestionRequest{
					ID: q.id, Questions: q.questions, CallID: q.callID,
				})
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
// opencode's own semantics, read from the pinned server's source and pinned
// by its httpapi tests (1.18.34): `limit` alone answers the newest limit
// messages, ascending; with `before` — an encoded cursor, not a bare id —
// the newest limit messages strictly older than it, ascending; the query
// reads limit+1 rows, so a page answering fewer than limit really is the
// last one.
func (b *Backend) History(ctx context.Context, workspaceDir, sessionID, before string, limit int) (backend.HistoryPage, error) {
	if before == "" {
		return backend.HistoryPage{}, fmt.Errorf("history needs the message id to page below")
	}
	if limit < 1 {
		return backend.HistoryPage{}, fmt.Errorf("history needs a positive limit")
	}
	// The revert point is read BEFORE the message list, exactly as Transcript
	// reads it: the next prompt's cleanup deletes the reverted messages and
	// only then clears the marker, and this order is the one that stays safe
	// across that race (see Transcript's comment).
	revertedFrom := b.revertPoint(ctx, sessionID)
	// The cursor carries the message's created time, so the message itself
	// is read first. One the storage no longer holds (a revert's cleanup
	// deletes the reverted turns) has nothing older to page through: an
	// empty page ends the walk instead of failing it.
	created, gone, err := b.messageCreated(ctx, sessionID, before)
	if err != nil {
		return backend.HistoryPage{}, err
	}
	if gone {
		return backend.HistoryPage{}, nil
	}
	cursor, err := opencodeCursor(before, created)
	if err != nil {
		return backend.HistoryPage{}, err
	}
	path := "/session/" + url.PathEscape(sessionID) + "/message?limit=" + strconv.Itoa(limit) +
		"&before=" + url.QueryEscape(cursor)
	var raw []any
	if err := b.doJSONLimit(ctx, http.MethodGet, path, nil, &raw, maxTranscriptBytes); err != nil {
		return backend.HistoryPage{}, err
	}
	entries := asMaps(raw)
	// An opencode too old to page would ignore the parameters and answer the
	// whole list; that must never be mapped into a page that reads like one.
	if len(entries) > limit {
		return backend.HistoryPage{}, fmt.Errorf("opencode answered %d messages for a %d-message history page", len(entries), limit)
	}
	page := backend.HistoryPage{}
	for _, entry := range entries {
		info := getMap(entry, "info")
		if info == nil {
			info = entry
		}
		msg := messageFromMap(info)
		if revertedFrom != "" && msg.ID == revertedFrom {
			break
		}
		b.resolveClientMessageID(sessionID, &msg)
		var parts []backend.Part
		for _, pm := range asMaps(getSlice(entry, "parts")) {
			parts = append(parts, b.mapPart(sessionID, pm))
		}
		page.Entries = append(page.Entries, backend.TranscriptEntry{Message: msg, Parts: parts})
	}
	if len(page.Entries) > 0 {
		page.Before = page.Entries[0].Message.ID
	}
	// A full page is opencode's own `more` (it fetched limit+1 rows); a
	// shorter one is the end even when a revert cut shrank it.
	page.HasMore = len(page.Entries) == limit
	return page, nil
}

// messageCreated reads one message's time.created — the half of opencode's
// paging cursor a bare message id does not carry. gone reports a message the
// storage no longer holds (HTTP 404), which the caller answers with an empty
// page rather than an error.
func (b *Backend) messageCreated(ctx context.Context, sessionID, messageID string) (created time.Time, gone bool, _ error) {
	var msg map[string]any
	path := "/session/" + url.PathEscape(sessionID) + "/message/" + url.PathEscape(messageID)
	if err := b.doJSON(ctx, http.MethodGet, path, nil, &msg); err != nil {
		if strings.Contains(err.Error(), "status 404") {
			return time.Time{}, true, nil
		}
		return time.Time{}, false, err
	}
	info := getMap(msg, "info")
	if info == nil {
		info = msg
	}
	ms := getFloat(getMap(info, "time"), "created")
	if ms <= 0 {
		return time.Time{}, false, fmt.Errorf("opencode message %s carries no created time", messageID)
	}
	return time.UnixMilli(int64(ms)), false, nil
}

// opencodeCursor encodes the message-list paging cursor the pinned opencode
// (1.18.34) answers `before` with: base64url of {"id","time"}, time the
// message's time.created in millis. GET /doc's `before` parameter and the
// paged answer's X-Next-Cursor header both carry one; a bare message id is
// a 400.
func opencodeCursor(messageID string, created time.Time) (string, error) {
	body, err := json.Marshal(struct {
		ID   string `json:"id"`
		Time int64  `json:"time"`
	}{ID: messageID, Time: created.UnixMilli()})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(body), nil
}

func (b *Backend) Diff(ctx context.Context, _ string, sessionID string) ([]backend.FileDiff, error) {
	var raw []any
	if err := b.doJSON(ctx, http.MethodGet, "/session/"+url.PathEscape(sessionID)+"/diff", nil, &raw); err != nil {
		return nil, err
	}
	out := make([]backend.FileDiff, 0, len(raw))
	for _, m := range asMaps(raw) {
		out = append(out, fileDiffFromMap(m))
	}
	return out, nil
}

func (b *Backend) Children(ctx context.Context, _ string, sessionID string) ([]backend.Session, error) {
	var raw []any
	if err := b.doJSON(ctx, http.MethodGet, "/session/"+url.PathEscape(sessionID)+"/children", nil, &raw); err != nil {
		return nil, err
	}
	out := make([]backend.Session, 0, len(raw))
	for _, m := range asMaps(raw) {
		out = append(out, sessionFromMap(m))
	}
	return out, nil
}

func (b *Backend) Compact(ctx context.Context, _ string, sessionID string) error {
	providerID, modelID, err := b.summarizeModel(ctx, sessionID)
	if err != nil {
		return err
	}
	// auto:false marks a person's "Compact now" (PROTOCOL.md §7's compaction
	// part distinguishes it from opencode's own context-overflow trigger).
	body := map[string]any{"providerID": providerID, "modelID": modelID, "auto": false}
	return b.doJSON(ctx, http.MethodPost, "/session/"+url.PathEscape(sessionID)+"/summarize", body, nil)
}

// summarizeModel picks the model a summarize runs on. Found live (1.18.34):
// POST /session/:id/summarize requires a JSON body {providerID, modelID,
// auto?} and answers 400 {"kind":"Payload"} without one — opencode keeps no
// session model of its own to fall back on. In order: the session overlay's
// model (the one this session's prompts go out on, as Prompt sends it), else
// the most recent assistant message's model (the session has run on
// something), else opencode's configured default.
func (b *Backend) summarizeModel(ctx context.Context, sessionID string) (providerID, modelID string, _ error) {
	if ov := b.getOverlay(sessionID); ov.ModelID != "" {
		providerID, modelID = splitModelID(ov.ModelID)
		return providerID, modelID, nil
	}
	var raw []any
	if err := b.doJSON(ctx, http.MethodGet, "/session/"+url.PathEscape(sessionID)+"/message", nil, &raw); err == nil {
		for _, entry := range asMaps(raw) {
			info := getMap(entry, "info")
			if info == nil {
				info = entry
			}
			if getStr(info, "role") != "assistant" {
				continue
			}
			if p, m := getStr(info, "providerID", "providerId"), getStr(info, "modelID", "modelId"); p != "" && m != "" {
				providerID, modelID = p, m
			}
		}
	}
	if providerID != "" && modelID != "" {
		return providerID, modelID, nil
	}
	var cfg map[string]any
	if err := b.doJSON(ctx, http.MethodGet, "/config", nil, &cfg); err == nil {
		if id := getStr(cfg, "model"); id != "" {
			providerID, modelID = splitModelID(id)
			return providerID, modelID, nil
		}
	}
	return "", "", fmt.Errorf("no model known for this session; send a message first")
}

// ReplyQuestion answers a pending question.asked (the user-question tool
// design). Like ReplyPermission, directory is required in practice even
// though the OpenAPI schema marks it optional — found live, the same
// PermissionNotFoundError-style 404 without it.
func (b *Backend) ReplyQuestion(ctx context.Context, workspaceDir, _, requestID string, answers [][]string) error {
	body := map[string]any{"answers": answers}
	return b.doJSON(ctx, http.MethodPost, "/question/"+url.PathEscape(requestID)+"/reply"+directoryQuery(workspaceDir), body, nil)
}

// RejectQuestion dismisses a pending question.asked without answering it —
// opencode reports the tool call itself as an error ("The user dismissed
// this question"), verified live.
func (b *Backend) RejectQuestion(ctx context.Context, workspaceDir, _, requestID string) error {
	return b.doJSON(ctx, http.MethodPost, "/question/"+url.PathEscape(requestID)+"/reject"+directoryQuery(workspaceDir), nil, nil)
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
