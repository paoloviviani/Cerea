package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"galopin/internal/backend"
	backendopencode "galopin/internal/backend/opencode"
	"galopin/internal/checkout"
	"galopin/internal/files"
	"galopin/internal/link"
	"galopin/internal/policy"
	"galopin/internal/sessions"
	"galopin/internal/terminal"
	"galopin/internal/workspaces"
)

// machine ties every internal package together into the one thing the
// link's Handler needs: given an op and its args, do the corresponding
// thing to the workspace registry, the session materializer or the
// backend, and return a result link can marshal into a res frame.
type machine struct {
	workspaces *workspaces.Registry
	back       backend.Backend
	mat        *sessions.Materializer
	pol        policy.Policy
	files      *files.Service
	terminals  *terminal.Manager

	mu                 sync.Mutex
	sessionWorkspaceID map[string]string // sessionID -> workspace registry id
	channelTerminal    map[string]string // terminal.attach channel -> terminal id, for inbound binary routing

	// lnk delivers terminal output/notice frames once the link is up. It is
	// nil until AttachLink runs (run.go, after both are constructed —
	// machine.Handle only ever gets called once the link has paired, so by
	// then it is always set) and in tests that never call AttachLink, in
	// which case terminal output/notices are simply dropped.
	lnk *link.Link
	// audit is galopin's local, tamper-resistant record (PROTOCOL.md §9.3):
	// terminal open/close and policy refusals, never content. Nil-safe.
	audit *auditLogger
}

func newMachine(reg *workspaces.Registry, back backend.Backend, mat *sessions.Materializer, pol policy.Policy) *machine {
	return &machine{
		workspaces:         reg,
		back:               back,
		mat:                mat,
		pol:                pol,
		files:              files.New(pol.EffectiveFileDeny()),
		terminals:          terminal.NewManager(nil),
		sessionWorkspaceID: map[string]string{},
		channelTerminal:    map[string]string{},
	}
}

// AttachLink wires the machine to its live link, once both exist (run.go
// constructs the link after the machine, since the link's Hello/Handler
// callbacks need the machine and the machine's terminal callbacks need the
// link). It also makes the machine link.BinaryHandler-compatible.
func (mc *machine) AttachLink(lnk *link.Link) { mc.lnk = lnk }

// AttachAudit wires the local audit log (run.go; nil in tests that don't
// need one).
func (mc *machine) AttachAudit(a *auditLogger) { mc.audit = a }

// HandleBinary implements link.BinaryHandler: routes an inbound term.input
// or term.ack frame to whichever terminal owns channel (PROTOCOL.md §9.2).
// A channel with no known terminal (already detached, or never attached —
// a stale frame from a reconnect race) is silently dropped, same as an
// unknown op would be refused loudly; a transport-level frame has no `res`
// to answer, so there is nothing to refuse into.
func (mc *machine) HandleBinary(kind byte, channel string, offset uint64, payload []byte) {
	mc.mu.Lock()
	termID, ok := mc.channelTerminal[channel]
	mc.mu.Unlock()
	if !ok {
		return
	}
	t, err := mc.terminals.Get(termID)
	if err != nil {
		return
	}
	switch kind {
	case link.BinTermInput:
		_, _ = t.Write(payload)
	case link.BinTermAck:
		_ = t.Ack(channel, offset)
	}
}

func opErrf(code, format string, args ...any) *link.OpError {
	return &link.OpError{Code: code, Message: fmt.Sprintf(format, args...)}
}

func notFound(what string) *link.OpError  { return opErrf("not_found", "%s not found", what) }
func invalidArgs(err error) *link.OpError { return opErrf("invalid", "bad arguments: %v", err) }

// backendErr wraps a backend's error. A sentinel the backend returns for a
// caller-addressable state problem — a prompt on a session that is already
// mid-turn — is the caller's mistake, not the backend's: it answers with
// the invalid code every other invalid-state refusal uses, not "backend".
func backendErr(err error) *link.OpError {
	if errors.Is(err, backend.ErrSessionBusy) {
		return opErrf("invalid", "%v", err)
	}
	return opErrf("backend", "%v", err)
}

// trackSession records sessionID's workspace both in the materializer
// (which needs the directory) and here (which needs the registry's own
// opaque workspace id, since a Backend only ever knows a directory).
func (mc *machine) trackSession(w workspaces.Workspace, s backend.Session) {
	mc.mat.Track(w.Path, s)
	mc.mu.Lock()
	mc.sessionWorkspaceID[s.ID] = w.ID
	mc.mu.Unlock()
}

func (mc *machine) resolveSession(sessionID string) (dir, workspaceID string, operr *link.OpError) {
	dir, ok := mc.mat.WorkspaceDir(sessionID)
	if !ok {
		return "", "", notFound("session")
	}
	mc.mu.Lock()
	workspaceID = mc.sessionWorkspaceID[sessionID]
	mc.mu.Unlock()
	return dir, workspaceID, nil
}

// enrich fills in the fields only this process's own state can supply — a
// Backend has no notion of workspace registry ids, pending permissions or
// auto-accept. A single-session enrichment; a listing enriches many
// sessions at once through enrichAll instead, which shares one
// ChildSummaries pass across all of them rather than paying its O(tracked
// sessions) cost per session.
func (mc *machine) enrich(s backend.Session, workspaceID string) backend.Session {
	s.WorkspaceID = workspaceID
	s.PendingPermissions = mc.mat.PendingPermissions(s.ID)
	s.AutoAccept = mc.mat.AutoAccept(s.ID)
	s.RootID = mc.mat.RootOf(s.ID)
	s.ChildSummary = mc.mat.ChildSummary(s.ID)
	if status, ok := mc.mat.Status(s.ID); ok && status != "" {
		s.Status = status
	}
	return s
}

// enrichAll enriches every session in sessions, sharing one
// mc.mat.ChildSummaries() pass instead of calling ChildSummary per session
// (each of which rescans every tracked session on its own — O(N²) over a
// listing of N).
func (mc *machine) enrichAll(sessions []backend.Session, workspaceIDs []string) []backend.Session {
	summaries := mc.mat.ChildSummaries()
	out := make([]backend.Session, len(sessions))
	for i, s := range sessions {
		s.WorkspaceID = workspaceIDs[i]
		s.PendingPermissions = mc.mat.PendingPermissions(s.ID)
		s.AutoAccept = mc.mat.AutoAccept(s.ID)
		s.RootID = mc.mat.RootOf(s.ID)
		s.ChildSummary = summaries[s.ID]
		if status, ok := mc.mat.Status(s.ID); ok && status != "" {
			s.Status = status
		}
		out[i] = s
	}
	return out
}

// Handle implements link.Handler: PROTOCOL.md §6's whole op table.
func (mc *machine) Handle(ctx context.Context, op string, args json.RawMessage) (any, *link.OpError) {
	switch op {
	case "files.list", "files.stat", "files.read", "files.status":
		return mc.opFiles(ctx, op, args)
	case "terminal.list", "terminal.open", "terminal.attach", "terminal.detach", "terminal.resize", "terminal.rename", "terminal.close":
		return mc.opTerminal(ctx, op, args)
	case "workspace.list":
		return mc.opWorkspaceList()
	case "workspace.suggest":
		return mc.opWorkspaceSuggest(args)
	case "workspace.create":
		return mc.opWorkspaceCreate(ctx, args)
	case "workspace.rename":
		return mc.opWorkspaceRename(args)
	case "workspace.archive":
		return mc.opWorkspaceArchive(ctx, args)

	case "session.list":
		return mc.opSessionList(ctx, args)
	case "session.get":
		return mc.opSessionGet(ctx, args)
	case "session.create":
		return mc.opSessionCreate(ctx, args)
	case "session.prompt":
		return mc.opSessionPrompt(ctx, args)
	case "session.command":
		return mc.opSessionCommand(ctx, args)
	case "session.cancel":
		return mc.opSessionCancel(ctx, args)
	case "session.rename":
		return mc.opSessionRename(ctx, args)
	case "session.archive", "session.delete":
		return mc.opSessionDelete(ctx, args)
	case "session.setMode":
		return mc.opSessionSetMode(ctx, args)
	case "session.setModel":
		return mc.opSessionSetModel(ctx, args)
	case "session.setEffort":
		return mc.opSessionSetEffort(ctx, args)
	case "session.setAutoAccept":
		return mc.opSessionSetAutoAccept(args)
	case "session.sync":
		return mc.opSessionSync(ctx, args)
	case "session.diff":
		return mc.opSessionDiff(ctx, args)
	case "session.children":
		return mc.opSessionChildren(ctx, args)
	case "session.revert":
		return mc.opSessionRevert(ctx, args)
	case "session.unrevert":
		return mc.opSessionUnrevert(ctx, args)
	case "session.compact":
		return mc.opSessionCompact(ctx, args)

	case "permission.reply":
		return mc.opPermissionReply(ctx, args)

	case "question.reply":
		return mc.opQuestionReply(ctx, args)

	case "backend.modes":
		return mc.opBackendModes(ctx, args)
	case "backend.models":
		return mc.opBackendModels(ctx, args)
	case "backend.commands":
		return mc.opBackendCommands(ctx, args)

	default:
		return nil, opErrf("unsupported", "unknown op %q", op)
	}
}

func (mc *machine) opWorkspaceList() (any, *link.OpError) {
	return map[string]any{"workspaces": orEmpty(mc.workspaces.List(false))}, nil
}

func (mc *machine) opWorkspaceSuggest(args json.RawMessage) (any, *link.OpError) {
	var a struct {
		Prefix string `json:"prefix"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	dirs, err := workspaces.Suggest(a.Prefix, mc.pol.WorkspaceRoots)
	if err != nil {
		return nil, backendErr(err)
	}
	return map[string]any{"directories": orEmpty(dirs)}, nil
}

func (mc *machine) opWorkspaceCreate(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		Path     string `json:"path"`
		Title    string `json:"title,omitempty"`
		Worktree *struct {
			From   string `json:"from"`
			Branch string `json:"branch"`
			Base   string `json:"base,omitempty"`
		} `json:"worktree,omitempty"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	if a.Worktree != nil {
		from, ok := mc.workspaces.Get(a.Worktree.From)
		if !ok {
			return nil, notFound("workspace")
		}
		w, err := mc.workspaces.CreateWorktree(ctx, from, a.Worktree.Branch, a.Worktree.Base, mc.pol.WorkspaceRoots)
		if err != nil {
			return nil, opErrf("forbidden", "%v", err)
		}
		return map[string]any{"workspace": w}, nil
	}
	title := a.Title
	if title == "" {
		title = a.Path
	}
	w, err := mc.workspaces.Create(title, a.Path, mc.pol.WorkspaceRoots)
	if err != nil {
		return nil, opErrf("forbidden", "%v", err)
	}
	return map[string]any{"workspace": w}, nil
}

func (mc *machine) opWorkspaceRename(args json.RawMessage) (any, *link.OpError) {
	var a struct {
		WorkspaceID string `json:"workspaceId"`
		Title       string `json:"title"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	w, err := mc.workspaces.Rename(a.WorkspaceID, a.Title)
	if err != nil {
		return nil, notFound("workspace")
	}
	return map[string]any{"workspace": w}, nil
}

func (mc *machine) opWorkspaceArchive(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		WorkspaceID    string `json:"workspaceId"`
		RemoveWorktree bool   `json:"removeWorktree,omitempty"`
		Force          bool   `json:"force,omitempty"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	if a.RemoveWorktree {
		w, ok := mc.workspaces.Get(a.WorkspaceID)
		if !ok {
			return nil, notFound("workspace")
		}
		if w.WorktreeOf == "" {
			return nil, opErrf("invalid", "workspace %q is not a worktree", w.Name)
		}
		from, ok := mc.workspaces.Get(w.WorktreeOf)
		if !ok {
			return nil, notFound("source workspace")
		}
		if err := workspaces.RemoveWorktree(ctx, from.Path, w.Path, a.Force); err != nil {
			return nil, backendErr(err)
		}
	}
	if err := mc.workspaces.Archive(a.WorkspaceID); err != nil {
		return nil, notFound("workspace")
	}
	return map[string]any{}, nil
}

func (mc *machine) opSessionList(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		WorkspaceID string `json:"workspaceId,omitempty"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, invalidArgs(err)
		}
	}
	var wsList []workspaces.Workspace
	if a.WorkspaceID != "" {
		w, ok := mc.workspaces.Get(a.WorkspaceID)
		if !ok {
			return nil, notFound("workspace")
		}
		wsList = []workspaces.Workspace{w}
	} else {
		wsList = mc.workspaces.List(false)
	}
	type listed struct {
		s           backend.Session
		workspaceID string
	}
	var all []listed
	for _, w := range wsList {
		sessList, err := mc.back.ListSessions(ctx, w.Path)
		if err != nil {
			return nil, backendErr(err)
		}
		for _, s := range sessList {
			mc.trackSession(w, s)
			all = append(all, listed{s, w.ID})
		}
	}
	// Enriched only once every listed session is tracked, so a parent's
	// childSummary counts children listed after it. Subagents are listed
	// too, under their own workspace (a parent and its child can live in
	// different worktrees), carrying parentId/rootId so the list marks them
	// rather than hiding them. enrichAll shares one ChildSummaries() pass
	// across the whole listing instead of one ChildSummary() scan per
	// session (sessions_test.go's TestChildSummariesMatchesChildSummary
	// covers the O(N²) this replaced).
	sessList := make([]backend.Session, len(all))
	workspaceIDs := make([]string, len(all))
	for i, l := range all {
		sessList[i] = l.s
		workspaceIDs[i] = l.workspaceID
	}
	out := mc.enrichAll(sessList, workspaceIDs)
	return map[string]any{"sessions": orEmpty(out)}, nil
}

func (mc *machine) opSessionGet(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	dir, workspaceID, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	s, err := mc.back.GetSession(ctx, dir, a.SessionID)
	if err != nil {
		return nil, backendErr(err)
	}
	return map[string]any{"session": mc.enrich(s, workspaceID)}, nil
}

func (mc *machine) opSessionCreate(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		WorkspaceID string `json:"workspaceId"`
		Title       string `json:"title,omitempty"`
		ModeID      string `json:"modeId,omitempty"`
		ModelID     string `json:"modelId,omitempty"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	w, ok := mc.workspaces.Get(a.WorkspaceID)
	if !ok {
		return nil, notFound("workspace")
	}
	s, err := mc.back.CreateSession(ctx, w.Path, backend.CreateSessionOptions{Title: a.Title, ModeID: a.ModeID, ModelID: a.ModelID})
	if err != nil {
		return nil, backendErr(err)
	}
	mc.trackSession(w, s)
	return map[string]any{"session": mc.enrich(s, w.ID)}, nil
}

func (mc *machine) opSessionPrompt(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID       string               `json:"sessionId"`
		Text            string               `json:"text"`
		ClientMessageID string               `json:"clientMessageId,omitempty"`
		Attachments     []backend.Attachment `json:"attachments,omitempty"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	dir, _, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	err := mc.back.Prompt(ctx, dir, a.SessionID, backend.Prompt{
		Text: a.Text, ClientMessageID: a.ClientMessageID, Attachments: a.Attachments,
	})
	if err != nil {
		return nil, backendErr(err)
	}
	return map[string]any{}, nil
}

func (mc *machine) opSessionCancel(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	dir, _, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	if err := mc.back.Cancel(ctx, dir, a.SessionID); err != nil {
		return nil, backendErr(err)
	}
	return map[string]any{}, nil
}

func (mc *machine) opSessionRename(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string `json:"sessionId"`
		Title     string `json:"title"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	dir, workspaceID, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	s, err := mc.back.RenameSession(ctx, dir, a.SessionID, a.Title)
	if err != nil {
		return nil, backendErr(err)
	}
	return map[string]any{"session": mc.enrich(s, workspaceID)}, nil
}

func (mc *machine) opSessionDelete(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	dir, _, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	if err := mc.back.DeleteSession(ctx, dir, a.SessionID); err != nil {
		return nil, backendErr(err)
	}
	return map[string]any{}, nil
}

func (mc *machine) opSessionSetMode(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string `json:"sessionId"`
		ModeID    string `json:"modeId"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	dir, workspaceID, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	s, err := mc.back.SetMode(ctx, dir, a.SessionID, a.ModeID)
	if err != nil {
		return nil, backendErr(err)
	}
	return map[string]any{"session": mc.enrich(s, workspaceID)}, nil
}

func (mc *machine) opSessionSetModel(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string `json:"sessionId"`
		ModelID   string `json:"modelId"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	dir, workspaceID, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	if !mc.pol.AllowFreeModels {
		filtered := mc.pol.FilterModelIDs([]string{a.ModelID})
		if len(filtered) == 0 {
			return nil, opErrf("forbidden", "model %q is not a gateway model, and this machine does not allow free models", a.ModelID)
		}
	}
	s, err := mc.back.SetModel(ctx, dir, a.SessionID, a.ModelID)
	if err != nil {
		return nil, backendErr(err)
	}
	return map[string]any{"session": mc.enrich(s, workspaceID)}, nil
}

// opSessionSetEffort sets (or, with null, clears) the thinking effort sent
// with the session's prompts (PROTOCOL.md §6 session.setEffort).
func (mc *machine) opSessionSetEffort(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string  `json:"sessionId"`
		Effort    *string `json:"effort"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	effort := ""
	if a.Effort != nil {
		effort = strings.TrimSpace(*a.Effort)
		if effort == "" || len(effort) > 32 {
			return nil, opErrf("invalid", "effort must be a variant id, or null for the model's default")
		}
	}
	dir, workspaceID, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	setter, ok := mc.back.(backend.EffortSetter)
	if !ok || !mc.back.Capabilities().Efforts {
		return nil, opErrf("unsupported", "backend %s has no efforts capability", mc.back.ID())
	}
	s, err := setter.SetEffort(ctx, dir, a.SessionID, effort)
	if err != nil {
		return nil, backendErr(err)
	}
	return map[string]any{"session": mc.enrich(s, workspaceID)}, nil
}

func (mc *machine) opSessionSetAutoAccept(args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string `json:"sessionId"`
		Enabled   bool   `json:"enabled"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	if err := mc.mat.SetAutoAccept(a.SessionID, a.Enabled); err != nil {
		if err == sessions.ErrAutoAcceptForbidden {
			return nil, opErrf("forbidden", "%v", err)
		}
		return nil, notFound("session")
	}
	_, workspaceID, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	return map[string]any{"session": map[string]any{
		"id": a.SessionID, "workspaceId": workspaceID, "autoAccept": mc.mat.AutoAccept(a.SessionID),
	}}, nil
}

func (mc *machine) opSessionSync(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string `json:"sessionId"`
		Epoch     string `json:"epoch,omitempty"`
		AfterSeq  int64  `json:"afterSeq,omitempty"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	res, err := mc.mat.Sync(ctx, a.SessionID, a.Epoch, a.AfterSeq)
	if err != nil {
		if err == sessions.ErrUnknownSession {
			return nil, notFound("session")
		}
		return nil, backendErr(err)
	}
	out := map[string]any{"epoch": res.Epoch, "seq": res.Seq}
	if res.Snapshot != nil {
		out["snapshot"] = res.Snapshot
		return out, nil
	}
	envs := make([]map[string]any, 0, len(res.Events))
	for _, env := range res.Events {
		root := env.RootSessionID
		if root == "" {
			root = env.SessionID
		}
		envs = append(envs, map[string]any{
			"sessionId": env.SessionID, "epoch": env.Epoch, "seq": env.Seq, "rootSessionId": root, "event": eventToWire(env.Event),
		})
	}
	out["events"] = orEmpty(envs)
	return out, nil
}

func (mc *machine) opSessionDiff(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	dir, _, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	// The checkout's uncommitted changes, from git, are what the pane shows: a
	// backend's own session diff misses files a shell command wrote. Only a
	// workspace outside git falls back to the backend's notion of a diff.
	if files, err := checkout.Diff(ctx, dir); err == nil {
		return map[string]any{"files": orEmpty(files)}, nil
	} else if !errors.Is(err, checkout.ErrNotARepo) {
		return nil, backendErr(err)
	}
	differ, ok := mc.back.(backend.Differ)
	if !ok {
		return nil, opErrf("unsupported", "backend %s has no diff capability", mc.back.ID())
	}
	files, err := differ.Diff(ctx, dir, a.SessionID)
	if err != nil {
		return nil, backendErr(err)
	}
	return map[string]any{"files": orEmpty(files)}, nil
}

func (mc *machine) opSessionChildren(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	dir, workspaceID, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	childrener, ok := mc.back.(backend.Childrener)
	if !ok {
		return nil, opErrf("unsupported", "backend %s has no children capability", mc.back.ID())
	}
	children, err := childrener.Children(ctx, dir, a.SessionID)
	if err != nil {
		return nil, backendErr(err)
	}
	// Each child is anchored at the parent's tool call that spawned it: the
	// parent's transcript records the child's session id on that call.
	spawnedBy := map[string]string{}
	if parent, err := mc.mat.Sync(ctx, a.SessionID, "", 0); err == nil && parent.Snapshot != nil {
		for _, entry := range parent.Snapshot.Messages {
			for _, part := range entry.Parts {
				if part.Type == backend.PartTool && part.SubtaskSessionID != "" {
					spawnedBy[part.SubtaskSessionID] = part.CallID
				}
			}
		}
	}
	out := make([]backend.Session, 0, len(children))
	for _, c := range children {
		// Register the tree edge with the materializer too: a child the
		// backend reports here may never have been Tracked from its own
		// events yet, and its parent linkage is what routes its later
		// envelopes (and inherits auto-accept) to this session's root.
		if c.ParentID == "" {
			c.ParentID = a.SessionID
		}
		mc.mat.Track(dir, c)
		c.ParentToolCallID = spawnedBy[c.ID]
		out = append(out, mc.enrich(c, workspaceID))
	}
	return map[string]any{"sessions": orEmpty(out)}, nil
}

// opSessionRevert rolls a session back to just before messageId (PROTOCOL.md
// §6 session.revert), then drops the materializer's copy of its history so a
// fresh session.sync re-reads the rolled-back transcript.
func (mc *machine) opSessionRevert(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string `json:"sessionId"`
		MessageID string `json:"messageId"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	if a.MessageID == "" {
		return nil, opErrf("invalid", "messageId is required")
	}
	dir, _, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	reverter, ok := mc.back.(backend.Reverter)
	if !ok || !mc.back.Capabilities().Revert {
		return nil, opErrf("unsupported", "backend %s has no revert capability", mc.back.ID())
	}
	if status, known := mc.mat.Status(a.SessionID); known && (status == backend.StatusBusy || status == backend.StatusRetry) {
		return nil, opErrf("invalid", "the session is mid-turn; stop it before rolling back")
	}
	if err := reverter.Revert(ctx, dir, a.SessionID, a.MessageID); err != nil {
		return nil, backendErr(err)
	}
	mc.mat.Reseed(a.SessionID)
	return map[string]any{}, nil
}

// opSessionUnrevert undoes the last revert while no new prompt has been sent.
func (mc *machine) opSessionUnrevert(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	dir, _, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	reverter, ok := mc.back.(backend.Reverter)
	if !ok || !mc.back.Capabilities().Revert {
		return nil, opErrf("unsupported", "backend %s has no revert capability", mc.back.ID())
	}
	if err := reverter.Unrevert(ctx, dir, a.SessionID); err != nil {
		return nil, backendErr(err)
	}
	mc.mat.Reseed(a.SessionID)
	return map[string]any{}, nil
}

func (mc *machine) opSessionCompact(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	dir, _, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	compactor, ok := mc.back.(backend.Compactor)
	if !ok {
		return nil, opErrf("unsupported", "backend %s has no compact capability", mc.back.ID())
	}
	if err := compactor.Compact(ctx, dir, a.SessionID); err != nil {
		return nil, backendErr(err)
	}
	return map[string]any{}, nil
}

func (mc *machine) opPermissionReply(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string `json:"sessionId"`
		RequestID string `json:"requestId"`
		Decision  string `json:"decision"`
		Message   string `json:"message,omitempty"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	dir, _, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	if err := mc.back.ReplyPermission(ctx, dir, a.SessionID, a.RequestID, backend.Decision(a.Decision), a.Message); err != nil {
		return nil, backendErr(err)
	}
	return map[string]any{}, nil
}

// opQuestionReply implements `question.reply` (the user-question tool
// design): answer with `decision: "answer"` and `answers` (one slice of
// chosen labels per question, in order), or dismiss it with `decision:
// "reject"`. `unsupported` when the backend has no native question
// mechanism (PROTOCOL.md/the task's "ACP reports questions: false").
func (mc *machine) opQuestionReply(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID string     `json:"sessionId"`
		RequestID string     `json:"requestId"`
		Decision  string     `json:"decision"`
		Answers   [][]string `json:"answers,omitempty"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	dir, _, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	asker, ok := mc.back.(backend.Asker)
	if !ok {
		return nil, opErrf("unsupported", "backend %s has no question capability", mc.back.ID())
	}
	switch a.Decision {
	case "answer":
		if err := asker.ReplyQuestion(ctx, dir, a.SessionID, a.RequestID, a.Answers); err != nil {
			return nil, backendErr(err)
		}
	case "reject":
		if err := asker.RejectQuestion(ctx, dir, a.SessionID, a.RequestID); err != nil {
			return nil, backendErr(err)
		}
	default:
		return nil, opErrf("invalid", "decision must be %q or %q, got %q", "answer", "reject", a.Decision)
	}
	return map[string]any{}, nil
}

func (mc *machine) opBackendModes(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		WorkspaceID string `json:"workspaceId,omitempty"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, invalidArgs(err)
		}
	}
	dir := ""
	if a.WorkspaceID != "" {
		w, ok := mc.workspaces.Get(a.WorkspaceID)
		if !ok {
			return nil, notFound("workspace")
		}
		dir = w.Path
	}
	modes, err := mc.back.Modes(ctx, dir)
	if err != nil {
		return nil, backendErr(err)
	}
	return map[string]any{"modes": orEmpty(modes)}, nil
}

func (mc *machine) opBackendModels(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		WorkspaceID string `json:"workspaceId,omitempty"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, invalidArgs(err)
		}
	}
	dir := ""
	if a.WorkspaceID != "" {
		w, ok := mc.workspaces.Get(a.WorkspaceID)
		if !ok {
			return nil, notFound("workspace")
		}
		dir = w.Path
	}
	models, err := mc.back.Models(ctx, dir)
	if err != nil {
		return nil, backendErr(err)
	}
	hidden := 0
	if !mc.pol.AllowFreeModels {
		hidden = len(models)
		filtered := models[:0]
		for _, m := range models {
			if m.ProviderID == policy.GatewayProviderID {
				filtered = append(filtered, m)
			}
		}
		models = filtered
		hidden -= len(models)
	}
	// hidden lets the panel say why the list is short (PROTOCOL.md §6) instead
	// of looking broken; the ids themselves never leave the machine.
	return map[string]any{"models": orEmpty(models), "hidden": hidden}, nil
}

// opBackendCommands answers the / menu's listing (PROTOCOL.md §6
// backend.commands): the workspace's commands with their origin, shell
// facts and template hash — never a template. Like backend.models, the
// caller names a workspace or a session; one of the two is required,
// because a command list is a directory's.
func (mc *machine) opBackendCommands(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		WorkspaceID string `json:"workspaceId,omitempty"`
		SessionID   string `json:"sessionId,omitempty"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, invalidArgs(err)
		}
	}
	dir := ""
	if a.SessionID != "" {
		d, _, operr := mc.resolveSession(a.SessionID)
		if operr != nil {
			return nil, operr
		}
		dir = d
	} else if a.WorkspaceID != "" {
		w, ok := mc.workspaces.Get(a.WorkspaceID)
		if !ok {
			return nil, notFound("workspace")
		}
		dir = w.Path
	} else {
		return nil, opErrf("invalid", "workspaceId or sessionId is required")
	}
	commander, ok := mc.commander()
	if !ok {
		return nil, opErrf("unsupported", "backend %s cannot list commands", mc.back.ID())
	}
	commands, err := commander.ListCommands(ctx, dir, a.SessionID)
	if err != nil {
		return nil, backendErr(err)
	}
	return map[string]any{"commands": orEmpty(commands)}, nil
}

// opSessionCommand runs one slash command in one session (PROTOCOL.md §6).
// The gates run in this order — capability, the command existing, the
// template the caller reviewed being the one still on disk, the policy
// vetoes, the agent-escalation rule — because each later gate is only
// meaningful once the earlier ones held. Every refusal is audited with the
// command's name, origin and shell fact and never its arguments; so is the
// run itself.
func (mc *machine) opSessionCommand(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		SessionID       string               `json:"sessionId"`
		Name            string               `json:"name"`
		Arguments       string               `json:"arguments"`
		ClientMessageID string               `json:"clientMessageId,omitempty"`
		Attachments     []backend.Attachment `json:"attachments,omitempty"`
		TemplateHash    string               `json:"templateHash,omitempty"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	if a.Name == "" {
		return nil, opErrf("invalid", "name is required")
	}
	dir, _, operr := mc.resolveSession(a.SessionID)
	if operr != nil {
		return nil, operr
	}
	commander, ok := mc.commander()
	if !ok {
		return nil, opErrf("unsupported", "backend %s cannot run commands", mc.back.ID())
	}

	// The command's own record, resolved now: the listed entry plus its
	// template expanded with opencode's own argument substitution ($1..$n,
	// $ARGUMENTS, append-when-no-placeholder) — never trusted from a listing
	// the panel saw minutes ago, and never scanned from the bare template
	// alone (a snippet or a ref smuggled in through the arguments only
	// exists after substitution).
	command, expanded, operr := mc.resolveCommand(ctx, dir, a.SessionID, a.Name, a.Arguments)
	if operr != nil {
		return nil, operr
	}
	shellWord := shellWord(command.Shell)
	origin := string(command.Origin)

	refuse := func(code, format string, args ...any) (any, *link.OpError) {
		mc.audit.command(command.Name, origin, shellWord, "refused")
		mc.audit.refusal("session.command", fmt.Sprintf(format, args...))
		return nil, opErrf(code, format, args...)
	}

	// The template the panel confirmed is the template still on disk.
	if a.TemplateHash != "" && a.TemplateHash != command.TemplateHash {
		return refuse("conflict", "this command changed on the machine since it was reviewed; review it again")
	}

	// The expanded text is what opencode detects shell on and resolves
	// @files from — so it is what the gates read too. The listing's own
	// scan still decides the menu badge and the confirmation sheet (the
	// reviewable unit), but a gate that read only the template would miss
	// everything the arguments smuggle in.
	expandedShell, _, expandedRefs := backendopencode.ScanExpanded(expanded)
	gateShell := (command.Shell != nil && *command.Shell) || expandedShell
	gateRefs := append(append([]string{}, command.FileRefs...), expandedRefs...)

	// The commandShell veto: a template that expands shell runs outside
	// every permission rule, so denied means refused — and so does unknown
	// (an MCP prompt, an ACP command: nobody has seen a template to scan),
	// which is what keeps MCP prompts and ACP commands off until opted in.
	if !mc.pol.CommandShellAllowed() && (command.Shell == nil || gateShell) {
		if command.Shell == nil {
			return refuse("forbidden", "this command's shell expansion is unknown, and this machine denies command shell")
		}
		return refuse("forbidden", "this command expands shell, and this machine denies command shell: re-enroll with --allow-command-shell to allow it")
	}

	// @path references go into the prompt at expansion time, so a denied
	// file would land in the transcript and the gateway's logs with no ask.
	// The same deny list the explorer redacts with — and checked whether or
	// not the shell policy allowed the run.
	for _, ref := range gateRefs {
		if files.MatchDeny(mc.pol.EffectiveFileDeny(), ref) {
			return refuse("forbidden", "this command reads %q, which this machine's file deny list refuses", ref)
		}
	}

	// The agent-escalation gate (rev1 §3.1, corrected against the real
	// binary): opencode picks the run's agent as the command's own `agent:`
	// frontmatter whenever one is set — whatever agent this process sends
	// along is ignored in that case. Overriding is therefore impossible, so
	// an escalation is refused outright rather than rewritten: a repo
	// command naming a more permissive agent than the session's overlay mode
	// never runs there, subtask or not (a subtask's child would additionally
	// run unsupervised in the other agent).
	sessionMode := ""
	if s, err := mc.back.GetSession(ctx, dir, a.SessionID); err == nil {
		sessionMode = s.ModeID
	}
	escalating := overlayModeWinsAgent(sessionMode, command.Agent)
	if escalating {
		if command.Subtask {
			return refuse("forbidden", "this command runs in agent %q as a subtask, and this session is in the more restrictive mode %q", command.Agent, sessionMode)
		}
		return refuse("forbidden", "this command names agent %q, which is more permissive than this session's mode %q", command.Agent, sessionMode)
	}
	// No escalation: the command's agent applies when it names one (that is
	// what opencode runs), else the session's own mode rides along for an
	// agentless command (the 2026-09-26 plan's step 5).
	agent := command.Agent
	if agent == "" {
		agent = sessionMode
	}

	// A command's own model: frontmatter can name a non-gateway provider,
	// which spends outside the enrolled account — the same gate setModel
	// applies, and the same answer.
	modelsToGate := []string{}
	if command.Model != "" {
		modelsToGate = append(modelsToGate, command.Model)
	}
	if command.Agent != "" {
		if agentModel, known := mc.agentModel(ctx, dir, command.Agent); known {
			modelsToGate = append(modelsToGate, agentModel)
		} else if !mc.pol.AllowFreeModels {
			return refuse("forbidden", "this command runs in agent %q, whose model is unknown, and this machine does not allow free models", command.Agent)
		}
	}
	if !mc.pol.AllowFreeModels {
		if filtered := mc.pol.FilterModelIDs(modelsToGate); len(filtered) != len(modelsToGate) {
			return refuse("forbidden", "this command pins a model outside the gateway (%q), and this machine does not allow free models", strings.Join(modelsToGate, ", "))
		}
	}

	mc.audit.command(command.Name, origin, shellWord, "run")
	run := backend.CommandRun{
		Name:            command.Name,
		Arguments:       a.Arguments,
		ClientMessageID: a.ClientMessageID,
		Attachments:     a.Attachments,
		TemplateHash:    a.TemplateHash,
		Agent:           agent,
	}
	if err := commander.RunCommand(ctx, dir, a.SessionID, run); err != nil {
		if errors.Is(err, backend.ErrSessionBusy) {
			return nil, opErrf("invalid", "%v", err)
		}
		return nil, backendErr(err)
	}
	return map[string]any{}, nil
}

// commander reports the backend's commands capability as a usable
// Commander, or that it has none: both the advertised capability and the
// interface must hold, because a backend that claims commands without
// implementing the half would otherwise answer every call unsupported.
func (mc *machine) commander() (backend.Commander, bool) {
	if !mc.back.Capabilities().Commands {
		return nil, false
	}
	commander, ok := mc.back.(backend.Commander)
	return commander, ok
}

// modesOrEmpty lists the backend's modes, an empty slice when it cannot
// answer — the escalation gate then treats any named agent as an
// escalation while an overlay mode is set (PROTOCOL.md §6).
func (mc *machine) modesOrEmpty(ctx context.Context, dir string) []backend.Mode {
	modes, err := mc.back.Modes(ctx, dir)
	if err != nil {
		return nil
	}
	return modes
}

// agentModel reads the named agent's configured model from the backend's
// own agent list, for the free-model gate's second input. Unknown when the
// backend lists no such agent or exposes no model for it.
func (mc *machine) agentModel(ctx context.Context, dir, agent string) (string, bool) {
	for _, mode := range mc.modesOrEmpty(ctx, dir) {
		if mode.ID == agent {
			return mode.Model, mode.Model != ""
		}
	}
	return "", false
}

// resolveCommand answers the run path's command record plus its template
// expanded with the caller's arguments. Backends whose commands carry
// server-side templates resolve both halves; the rest (ACP has nothing to
// expand) resolve the listing and gate from it.
func (mc *machine) resolveCommand(ctx context.Context, dir, sessionID, name, arguments string) (backend.Command, string, *link.OpError) {
	commander, ok := mc.commander()
	if !ok {
		return backend.Command{}, "", opErrf("unsupported", "backend %s cannot run commands", mc.back.ID())
	}
	if resolver, ok := commander.(backend.CommanderResolver); ok {
		resolved, err := resolver.ResolveCommand(ctx, dir, sessionID, name, arguments)
		if err != nil {
			if errors.Is(err, backend.ErrCommandNotFound) {
				return backend.Command{}, "", opErrf("not_found", "no command named %q here", name)
			}
			return backend.Command{}, "", backendErr(err)
		}
		return resolved.Command, resolved.Expanded, nil
	}
	commands, err := commander.ListCommands(ctx, dir, sessionID)
	if err != nil {
		return backend.Command{}, "", backendErr(err)
	}
	for i := range commands {
		if commands[i].Name == name {
			return commands[i], "", nil
		}
	}
	return backend.Command{}, "", opErrf("not_found", "no command named %q here", name)
}

// shellWord names the command's shell fact for the audit row: true, false,
// or unknown — never the snippets themselves.
func shellWord(shell *bool) string {
	switch {
	case shell == nil:
		return "unknown"
	case *shell:
		return "true"
	default:
		return "false"
	}
}

// overlayModeWinsAgent is the agent-escalation gate's decision (rev1 §3.1,
// corrected twice: first against the real binary, which runs cmd.agent
// whenever one is set (overriding is impossible), and then against its
// live mode listing, which orders [build, plan] — list order is not a
// restrictiveness scale, so the gate reads none. Any named agent differing
// from the session's overlay mode refuses: the session's mode can only be
// changed by setMode, never smuggled in by a command. A command that names
// no agent, or the session's own mode, is not an escalation — the overlay
// (or nothing) rides along exactly as before.
func overlayModeWinsAgent(sessionMode, cmdAgent string) bool {
	return sessionMode != "" && cmdAgent != "" && cmdAgent != sessionMode
}

// orEmpty turns a nil slice into an empty one. Go marshals nil as null, and
// PROTOCOL.md types every list as an array: Cerea's strict parsing either
// rejects a null or crashes on it, as the first end-to-end runs showed.
func orEmpty[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

// opFiles answers the read-only explorer's ops (PROTOCOL.md §9.3). They are
// machine ops: handled before any backend, confined by os.Root to the
// workspace's directory, and refused outright when the owner enrolled with
// --no-files.
func (mc *machine) opFiles(ctx context.Context, op string, args json.RawMessage) (any, *link.OpError) {
	if !mc.pol.FilesAllowed() {
		return nil, opErrf("forbidden", "this machine was enrolled with --no-files: re-enroll without it to browse files here")
	}
	var a struct {
		WorkspaceID string `json:"workspaceId"`
		Path        string `json:"path"`
		Ignored     *bool  `json:"ignored"`
		Offset      int64  `json:"offset"`
		Length      int64  `json:"length"`
		As          string `json:"as"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	w, ok := mc.workspaces.Get(a.WorkspaceID)
	if !ok {
		return nil, notFound("workspace")
	}
	var (
		res any
		err error
	)
	switch op {
	case "files.list":
		res, err = mc.files.List(ctx, w.Path, a.Path, a.Ignored == nil || *a.Ignored)
	case "files.stat":
		var e files.Entry
		e, err = mc.files.Stat(w.Path, a.Path)
		res = map[string]any{"entry": e}
	case "files.read":
		res, err = mc.files.Read(w.Path, a.Path, a.Offset, a.Length, a.As)
	case "files.status":
		res, err = mc.files.Status(ctx, w.Path)
	}
	if err != nil {
		return nil, filesErr(err)
	}
	return res, nil
}

func filesErr(err error) *link.OpError {
	msg := err.Error()
	for _, code := range []error{files.ErrInvalid, files.ErrForbidden, files.ErrNotFound, files.ErrTooLarge} {
		if errors.Is(err, code) {
			return &link.OpError{Code: code.Error(), Message: strings.TrimPrefix(msg, code.Error()+": ")}
		}
	}
	return opErrf("unavailable", "%v", err)
}

// opTerminal answers terminal.* (PROTOCOL.md §9.3). Like opFiles, these are
// machine ops handled before any backend switch, confined by policy first:
// denied outright when the machine was enrolled without --allow-terminal.
func (mc *machine) opTerminal(ctx context.Context, op string, args json.RawMessage) (any, *link.OpError) {
	if !mc.pol.TerminalAllowed() {
		mc.audit.refusal(op, "terminal denied by machine policy")
		return nil, opErrf("forbidden", "this machine was enrolled with terminal denied: re-enroll with --allow-terminal to use a terminal here")
	}
	switch op {
	case "terminal.list":
		return mc.opTerminalList(args)
	case "terminal.open":
		return mc.opTerminalOpen(args)
	case "terminal.attach":
		return mc.opTerminalAttach(args)
	case "terminal.detach":
		return mc.opTerminalDetach(args)
	case "terminal.resize":
		return mc.opTerminalResize(args)
	case "terminal.rename":
		return mc.opTerminalRename(args)
	case "terminal.close":
		return mc.opTerminalClose(ctx, args)
	default:
		return nil, opErrf("unsupported", "unknown op %q", op)
	}
}

func (mc *machine) opTerminalList(args json.RawMessage) (any, *link.OpError) {
	var a struct {
		WorkspaceID string `json:"workspaceId,omitempty"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, invalidArgs(err)
		}
	}
	return map[string]any{"terminals": orEmpty(mc.terminals.List(a.WorkspaceID))}, nil
}

func (mc *machine) opTerminalOpen(args json.RawMessage) (any, *link.OpError) {
	var a struct {
		WorkspaceID string `json:"workspaceId"`
		Cwd         string `json:"cwd,omitempty"`
		Cols        int    `json:"cols"`
		Rows        int    `json:"rows"`
		Title       string `json:"title,omitempty"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	w, ok := mc.workspaces.Get(a.WorkspaceID)
	if !ok {
		return nil, notFound("workspace")
	}
	title := a.Title
	if title == "" {
		title = w.Name
	}
	t, err := mc.terminals.Open(terminal.OpenConfig{
		WorkspaceID: w.ID, WorkspaceRoot: w.Path, Cwd: a.Cwd, Cols: a.Cols, Rows: a.Rows, Title: title,
		OnOutput: mc.terminalOutput, OnNotice: mc.terminalNotice,
	}, mc.pol.EffectiveMaxTerminals())
	if err != nil {
		if errors.Is(err, terminal.ErrTooMany) {
			return nil, opErrf("invalid", "%v", err)
		}
		if errors.Is(err, terminal.ErrInvalidCwd) {
			mc.audit.refusal("terminal.open", err.Error())
			return nil, opErrf("invalid", "%v", err)
		}
		return nil, backendErr(err)
	}
	snap := t.Snapshot()
	mc.audit.terminalOpen(snap.ID, snap.Cwd, snap.Shell)
	mc.terminalStateNotice(snap)
	return map[string]any{"terminal": snap}, nil
}

func (mc *machine) opTerminalAttach(args json.RawMessage) (any, *link.OpError) {
	var a struct {
		TerminalID string `json:"terminalId"`
		Channel    string `json:"channel"`
		From       *int64 `json:"from,omitempty"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	if a.Channel == "" {
		return nil, opErrf("invalid", "channel is required")
	}
	t, err := mc.terminals.Get(a.TerminalID)
	if err != nil {
		return nil, notFound("terminal")
	}
	from, reset, prelude, snap := t.Attach(a.Channel, a.From)
	mc.mu.Lock()
	mc.channelTerminal[a.Channel] = a.TerminalID
	mc.mu.Unlock()
	result := map[string]any{"terminal": snap, "from": from, "reset": reset}
	if reset {
		result["prelude"] = base64.StdEncoding.EncodeToString(prelude)
		t.Nudge()
	}
	return result, nil
}

func (mc *machine) opTerminalDetach(args json.RawMessage) (any, *link.OpError) {
	var a struct {
		TerminalID string `json:"terminalId"`
		Channel    string `json:"channel"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	t, err := mc.terminals.Get(a.TerminalID)
	if err != nil {
		return nil, notFound("terminal")
	}
	_ = t.Detach(a.Channel)
	mc.mu.Lock()
	delete(mc.channelTerminal, a.Channel)
	mc.mu.Unlock()
	return map[string]any{}, nil
}

func (mc *machine) opTerminalResize(args json.RawMessage) (any, *link.OpError) {
	var a struct {
		TerminalID string `json:"terminalId"`
		Cols       int    `json:"cols"`
		Rows       int    `json:"rows"`
		Claim      *bool  `json:"claim,omitempty"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	t, err := mc.terminals.Get(a.TerminalID)
	if err != nil {
		return nil, notFound("terminal")
	}
	claim := a.Claim == nil || *a.Claim
	applied, err := t.Resize(a.Cols, a.Rows, claim)
	if err != nil {
		return nil, backendErr(err)
	}
	return map[string]any{"applied": applied}, nil
}

func (mc *machine) opTerminalRename(args json.RawMessage) (any, *link.OpError) {
	var a struct {
		TerminalID string `json:"terminalId"`
		Title      string `json:"title"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	t, err := mc.terminals.Get(a.TerminalID)
	if err != nil {
		return nil, notFound("terminal")
	}
	t.Rename(a.Title)
	snap := t.Snapshot()
	mc.terminalStateNotice(snap)
	return map[string]any{"terminal": snap}, nil
}

func (mc *machine) opTerminalClose(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	var a struct {
		TerminalID string `json:"terminalId"`
		Force      bool   `json:"force,omitempty"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, invalidArgs(err)
	}
	t, err := mc.terminals.Get(a.TerminalID)
	if err != nil {
		return nil, notFound("terminal")
	}
	if t.State() == terminal.StateExited {
		// Already dead: signaling it again is a no-op, and the caller (the
		// UI's Close/Remove on an exited tab) means "gone for good", not
		// "kept until ExitRetention expires" — so drop it from the registry
		// right away instead of leaving it for terminal.list to keep showing.
		_ = mc.terminals.Remove(a.TerminalID)
	} else {
		t.Close(a.Force)
	}
	mc.audit.terminalClose(a.TerminalID)
	return map[string]any{}, nil
}

// terminalOutput and terminalNotice are the callbacks every terminal.Open
// gets (terminal.OutputFunc / terminal.NoticeFunc): deliver to the link, or
// drop when there is none yet (a test machine that never called
// AttachLink).
func (mc *machine) terminalOutput(terminalID, channel string, offset uint64, payload []byte) {
	if mc.lnk == nil {
		return
	}
	_ = mc.lnk.SendTerminalOutput(channel, offset, payload)
}

func (mc *machine) terminalNotice(terminalID string, n terminal.Notice) {
	if mc.lnk != nil {
		_ = mc.lnk.PublishNotice(map[string]string{"terminalId": terminalID}, n)
	}
	if n.Kind == "terminal.exit" {
		mc.audit.terminalClose(terminalID)
	}
}

func (mc *machine) terminalStateNotice(snap terminal.Snapshot) {
	if mc.lnk == nil {
		return
	}
	_ = mc.lnk.PublishNotice(map[string]string{"terminalId": snap.ID}, terminal.Notice{Kind: "terminal.state", Terminal: &snap})
}
