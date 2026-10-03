// Package sessions is the backend-agnostic materializer (PROTOCOL.md §7):
// it subscribes to a backend.Backend's event stream from process start,
// keeps a per-session transcript and ring buffer, enforces the text
// contract, and answers session.sync.
package sessions

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"

	"galopin/internal/backend"
	"galopin/internal/policy"
)

// ringCapacity is how many envelopes each session's ring buffer keeps
// (PROTOCOL.md §7 gives "e.g. last 2000").
const ringCapacity = 2000

// ErrUnknownSession is returned by any method keyed on a sessionID the
// materializer has never Tracked or created.
var ErrUnknownSession = errors.New("sessions: unknown session")

// Envelope is one pushed event, addressed by (epoch, seq) per session
// (PROTOCOL.md §5 "event" frame, §7). RootSessionID names the top-level
// ancestor of SessionID — the session itself for a top-level session — so
// a client watching a session also receives its descendants' envelopes
// (PROTOCOL.md §5 "event" frame, §7: subagent approvals surface mid-turn
// in the parent's view).
type Envelope struct {
	SessionID     string
	Epoch         string
	Seq           int64
	RootSessionID string
	Event         backend.Event
}

// SyncResult is session.sync's answer: either Events (a contiguous tail
// starting at afterSeq+1, when the epoch matches and the ring still holds
// it) or Snapshot (everything else — no prior epoch, an epoch mismatch, or
// a ring gap).
type SyncResult struct {
	Epoch    string
	Seq      int64
	Events   []Envelope
	Snapshot *backend.Transcript
}

// sessionState is the materializer's per-session working state: the
// reconstructed transcript (messages, parts, permissions, status, usage,
// todos) plus the ring buffer and seq counter events are assigned from.
type sessionState struct {
	sessionID    string
	workspaceDir string
	seeded       bool
	// parentID is the session this one was spawned from (opencode's
	// subagent/"subtask" tree, Session.ParentID), empty for a top-level
	// session. Learned from Track, from session events carrying it, and
	// from the parent's own task tool parts naming the child they
	// spawned — whichever arrives first.
	parentID string

	seq  int64
	ring []Envelope

	messageOrder []string
	messages     map[string]*backend.Message
	partOrder    map[string][]string
	parts        map[string]map[string]*backend.Part

	permissionOrder []string
	permissions     map[string]*backend.PermissionRequest

	// questionOrder/questions are the unanswered question-tool asks, kept
	// for the same reason as permissions: a snapshot must still offer them.
	questionOrder []string
	questions     map[string]*backend.QuestionRequest

	status backend.SessionStatus
	usage  *backend.Usage
	todos  []backend.Todo
}

func newSessionState(workspaceDir, sessionID string) *sessionState {
	return &sessionState{
		sessionID:    sessionID,
		workspaceDir: workspaceDir,
		messages:     map[string]*backend.Message{},
		partOrder:    map[string][]string{},
		parts:        map[string]map[string]*backend.Part{},
		permissions:  map[string]*backend.PermissionRequest{},
		questions:    map[string]*backend.QuestionRequest{},
	}
}

// since returns the envelopes after afterSeq, and whether the ring buffer
// still holds all of them. afterSeq == s.seq (already up to date) always
// succeeds with zero events, even on a session whose ring is empty.
func (s *sessionState) since(afterSeq int64) ([]Envelope, bool) {
	if afterSeq == s.seq {
		return []Envelope{}, true
	}
	if afterSeq > s.seq {
		return nil, false
	}
	if len(s.ring) == 0 {
		return nil, false
	}
	firstSeq := s.ring[0].Seq
	if afterSeq+1 < firstSeq {
		return nil, false // trimmed past what the caller needs
	}
	idx := int(afterSeq + 1 - firstSeq)
	if idx < 0 || idx > len(s.ring) {
		return nil, false
	}
	out := make([]Envelope, len(s.ring)-idx)
	copy(out, s.ring[idx:])
	return out, true
}

// snapshot reconstructs the current Transcript from tracked state.
func (s *sessionState) snapshot() backend.Transcript {
	entries := make([]backend.TranscriptEntry, 0, len(s.messageOrder))
	for _, mid := range s.messageOrder {
		msg, ok := s.messages[mid]
		if !ok {
			continue
		}
		var parts []backend.Part
		for _, pid := range s.partOrder[mid] {
			if p, ok := s.parts[mid][pid]; ok {
				part := *p
				if part.Role == "" {
					part.Role = msg.Role
				}
				parts = append(parts, part)
			}
		}
		entries = append(entries, backend.TranscriptEntry{Message: *msg, Parts: parts})
	}
	perms := make([]backend.PermissionRequest, 0, len(s.permissionOrder))
	for _, pid := range s.permissionOrder {
		if p, ok := s.permissions[pid]; ok {
			perms = append(perms, *p)
		}
	}
	questions := make([]backend.QuestionRequest, 0, len(s.questionOrder))
	for _, qid := range s.questionOrder {
		if q, ok := s.questions[qid]; ok {
			questions = append(questions, *q)
		}
	}
	return backend.Transcript{
		Messages:    entries,
		Permissions: perms,
		Questions:   questions,
		Status:      s.status,
		Usage:       s.usage,
		Todos:       s.todos,
	}
}

// Materializer is the whole per-machine event pipeline: one per running
// agent, wrapping exactly one backend.Backend.
type Materializer struct {
	back   backend.Backend
	policy policy.Policy
	// live is the permission part of the policy as it stands now: it can only
	// tighten while the process runs (policy.Live).
	live  *policy.Live
	epoch string

	mu       sync.Mutex
	sessions map[string]*sessionState

	// onChild is told, outside the lock, of each subagent session a LIVE event
	// first revealed (not one a startup listing found). newChildren is what
	// setParentLocked saw since the last drain.
	onChild     func(workspaceDir, childID string)
	newChildren []string

	outCh chan Envelope
}

// New builds a Materializer over b, gated by pol (read once at
// construction — a policy change requires a restart, same as any other
// enroll-time setting).
func New(b backend.Backend, pol policy.Policy) *Materializer {
	epoch, err := randomEpoch()
	if err != nil {
		// crypto/rand failing means the machine's entropy source is broken,
		// which every other secret-minting call in this program also
		// depends on; there is no degraded mode worth offering.
		panic(fmt.Sprintf("sessions: minting epoch: %v", err))
	}
	return &Materializer{
		back:     b,
		policy:   pol,
		live:     policy.NewLive(pol.Permission),
		epoch:    epoch,
		sessions: map[string]*sessionState{},
		outCh:    make(chan Envelope, 4096),
	}
}

func randomEpoch() (string, error) {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// Epoch is the process's own epoch, minted once at New and constant for
// the process's lifetime (PROTOCOL.md §7): a restart always mints a new
// one, which is precisely the signal that tells a client its cursor is
// stale and it must resync from a snapshot.
func (m *Materializer) Epoch() string { return m.epoch }

// Events is the live outward stream: every envelope this materializer
// emits, across every session, in emission order. Reading it is a
// best-effort convenience (a very slow or absent reader can miss live
// pushes) — session.sync's ring buffer and snapshot path are what
// guarantee no event is ever lost to a client that asks.
func (m *Materializer) Events() <-chan Envelope { return m.outCh }

// Track registers a session the materializer did not create itself — one
// discovered via the backend's own listing (e.g. at startup, or a subagent
// spawned as a "subtask" part) — so later event application and Sync know
// its workspace directory. A session already tracked is left alone: this
// must never clobber state built from live events.
func (m *Materializer) Track(workspaceDir string, sess backend.Session) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.sessions[sess.ID]; exists {
		// A startup listing naming an old child's parent is not news: the
		// OnChild hook is for children a live event reveals.
		seen := len(m.newChildren)
		m.setParentLocked(sess.ID, sess.ParentID)
		m.newChildren = m.newChildren[:seen]
		return
	}
	st := newSessionState(workspaceDir, sess.ID)
	st.status = sess.Status
	st.parentID = sess.ParentID
	m.sessions[sess.ID] = st
}

// setParentLocked records that childID was spawned from parentID. Empty
// parentIDs are ignored, a session is never its own parent, and an already
// known parent is never overwritten by a later (possibly staler) report —
// whichever source names the parent first wins. The child's state is
// created if no event has mentioned it yet, so a parent learned before the
// child's first event still applies. Caller holds m.mu.
func (m *Materializer) setParentLocked(childID, parentID string) {
	if parentID == "" || childID == parentID {
		return
	}
	st, ok := m.sessions[childID]
	if !ok {
		st = newSessionState("", childID)
		m.sessions[childID] = st
	}
	if st.parentID == "" {
		st.parentID = parentID
		m.newChildren = append(m.newChildren, childID)
	}
}

// drainChildrenLocked takes the children setParentLocked has seen since the
// last call, with the workspace each lives in. Caller holds m.mu.
func (m *Materializer) drainChildrenLocked() []childRef {
	if len(m.newChildren) == 0 {
		return nil
	}
	out := make([]childRef, 0, len(m.newChildren))
	for _, id := range m.newChildren {
		if st, ok := m.sessions[id]; ok {
			out = append(out, childRef{id: id, dir: st.workspaceDir})
		}
	}
	m.newChildren = nil
	return out
}

type childRef struct{ id, dir string }

// OnChild installs the callback told of every subagent session a live event
// reveals, so the machine can give it the ceiling at once. Set before Start.
func (m *Materializer) OnChild(fn func(workspaceDir, childID string)) { m.onChild = fn }

// ChildAgent is the subagent type a child session was started as, read from
// its parent's task call ("" until that call's input is known).
func (m *Materializer) ChildAgent(childID string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	child, ok := m.sessions[childID]
	if !ok || child.parentID == "" {
		return ""
	}
	parent, ok := m.sessions[child.parentID]
	if !ok {
		return ""
	}
	for _, parts := range parent.parts {
		for _, p := range parts {
			if p.Type == backend.PartTool && p.Tool == "task" && p.SubtaskSessionID == childID {
				if t, _ := p.Input["subagent_type"].(string); t != "" {
					return t
				}
			}
		}
	}
	return ""
}

// rootLocked walks the parent chain to the top-level ancestor, returning
// sessionID itself when it has no parent. Cycle-safe: a corrupted chain
// resolves to wherever the walk gives up rather than looping forever.
// Caller holds m.mu.
func (m *Materializer) rootLocked(sessionID string) string {
	seen := map[string]bool{sessionID: true}
	current := sessionID
	for {
		st, ok := m.sessions[current]
		if !ok || st.parentID == "" {
			return current
		}
		if seen[st.parentID] {
			return current
		}
		seen[st.parentID] = true
		current = st.parentID
	}
}

// RootOf returns the top-level ancestor of sessionID, or sessionID itself
// when it has no known parent. Exported for the wire layer, which tags
// every envelope with it (PROTOCOL.md §5).
func (m *Materializer) RootOf(sessionID string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rootLocked(sessionID)
}

// WorkspaceDir returns the workspace directory a known session belongs to
// — what the op dispatcher needs to call most Backend methods, which take
// a directory, not a session id alone.
func (m *Materializer) WorkspaceDir(sessionID string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.sessions[sessionID]
	if !ok {
		return "", false
	}
	return st.workspaceDir, true
}

// Status is the session's last-known turn-boundary state (PROTOCOL.md §6
// Session.status), tracked from live "status" events and Track's initial
// value.
func (m *Materializer) Status(sessionID string) (backend.SessionStatus, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.sessions[sessionID]
	if !ok {
		return "", false
	}
	return st.status, true
}

// Start begins consuming the backend's event stream in a goroutine, until
// ctx is cancelled or the backend's subscription itself ends (the backend
// doc's "fatal, needs a new epoch" case — Start returns nothing to signal
// that beyond the goroutine simply stopping; a caller that needs to notice
// should watch the same ctx, or wrap this backend in one that surfaces the
// failure some other way).
func (m *Materializer) Start(ctx context.Context) error {
	ch, err := m.back.Subscribe(ctx)
	if err != nil {
		return fmt.Errorf("subscribing to backend: %w", err)
	}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case be, ok := <-ch:
				if !ok {
					return
				}
				m.ApplyBackendEvent(ctx, be)
			}
		}
	}()
	return nil
}

// ApplyBackendEvent processes one raw backend event: translating it (the
// text contract), updating tracked state, and
// publishing whatever should reach a client. Exported so tests can drive it
// synchronously without a live goroutine or a real backend.
func (m *Materializer) ApplyBackendEvent(ctx context.Context, be backend.BackendEvent) {
	if be.Event.Kind == backend.EventResync {
		go m.resync(ctx, be.WorkspaceDir, be.SessionID)
		return
	}
	m.mu.Lock()
	st, exists := m.sessions[be.SessionID]
	if !exists {
		st = newSessionState(be.WorkspaceDir, be.SessionID)
		m.sessions[be.SessionID] = st
	} else if be.WorkspaceDir != "" {
		st.workspaceDir = be.WorkspaceDir
	}
	// A session event carries the session record itself, which names the
	// parent when this session is a subagent — the earliest point the
	// materializer can learn the tree edge for a child it never Tracked.
	if be.Event.Kind == backend.EventSession && be.Event.Session != nil {
		m.setParentLocked(be.SessionID, be.Event.Session.ParentID)
	}
	events := m.translateLocked(st, be.Event)
	envs := make([]Envelope, 0, len(events))
	for _, ev := range events {
		envs = append(envs, m.appendRingLocked(st, ev))
	}
	children := m.drainChildrenLocked()
	m.mu.Unlock()
	if m.onChild != nil {
		for _, c := range children {
			m.onChild(c.dir, c.id)
		}
	}

	for _, env := range envs {
		m.publish(env)
	}
}

// resync recovers from an event the backend could not deliver (an oversized
// line it had to skip): the session's held history is forgotten and re-read
// from the backend, and every tool part of the fresh transcript is announced
// again as a part event — a viewer already showing a call's result drops the
// repeat (its frames are keyed by call id), one that missed it now gets it.
// No status is announced: a transcript cannot say whether a turn is still
// running, and the backend's own next status event will. A session this process never saw is left
// alone: its first snapshot reads the backend anyway.
func (m *Materializer) resync(ctx context.Context, workspaceDir, sessionID string) {
	m.mu.Lock()
	st, ok := m.sessions[sessionID]
	if ok && workspaceDir == "" {
		workspaceDir = st.workspaceDir
	}
	m.mu.Unlock()
	if !ok {
		return
	}
	tr, err := m.back.Transcript(ctx, workspaceDir, sessionID)
	if err != nil {
		return
	}
	m.Reseed(sessionID)
	m.mu.Lock()
	mergeSeedLocked(st, tr)
	var envs []Envelope
	for _, entry := range tr.Messages {
		for _, p := range entry.Parts {
			if p.Type != backend.PartTool {
				continue
			}
			part := p
			if part.Role == "" {
				part.Role = entry.Message.Role
			}
			envs = append(envs, m.appendRingLocked(st, backend.Event{Kind: backend.EventPart, Part: &part}))
		}
	}
	m.mu.Unlock()
	for _, env := range envs {
		m.publish(env)
	}
}

// publish is best-effort (see Events's doc): a full channel drops the live
// push rather than blocking the event-processing goroutine, which would
// stall every session behind one slow reader.
func (m *Materializer) publish(env Envelope) {
	select {
	case m.outCh <- env:
	default:
	}
}

func (m *Materializer) appendRingLocked(st *sessionState, ev backend.Event) Envelope {
	st.seq++
	env := Envelope{SessionID: st.sessionID, Epoch: m.epoch, Seq: st.seq, RootSessionID: m.rootLocked(st.sessionID), Event: ev}
	st.ring = append(st.ring, env)
	if len(st.ring) > ringCapacity {
		trimmed := make([]Envelope, ringCapacity)
		copy(trimmed, st.ring[len(st.ring)-ringCapacity:])
		st.ring = trimmed
	}
	return env
}

// translateLocked applies one backend event to st, returning the event(s)
// to emit (usually zero or one). Caller holds m.mu.
func (m *Materializer) translateLocked(st *sessionState, ev backend.Event) []backend.Event {
	switch ev.Kind {
	case backend.EventMessage:
		if ev.Message == nil {
			return nil
		}
		if _, exists := st.messages[ev.Message.ID]; !exists {
			st.messageOrder = append(st.messageOrder, ev.Message.ID)
		}
		msg := *ev.Message
		st.messages[ev.Message.ID] = &msg
		return []backend.Event{ev}

	case backend.EventPart:
		return m.translatePartLocked(st, ev)

	case backend.EventDelta:
		if msg, ok := st.messages[ev.MessageID]; ok && ev.Role == "" {
			ev.Role = msg.Role
		}
		m.applyDeltaLocked(st, ev)
		return []backend.Event{ev}

	case backend.EventPartRemoved:
		if parts, ok := st.parts[ev.MessageID]; ok {
			delete(parts, ev.PartID)
		}
		st.partOrder[ev.MessageID] = removeString(st.partOrder[ev.MessageID], ev.PartID)
		return []backend.Event{ev}

	case backend.EventStatus:
		st.status = ev.Status
		return []backend.Event{ev}

	case backend.EventPermissionAsked:
		if ev.Request == nil {
			return nil
		}
		if _, exists := st.permissions[ev.Request.ID]; !exists {
			st.permissionOrder = append(st.permissionOrder, ev.Request.ID)
		}
		req := *ev.Request
		st.permissions[ev.Request.ID] = &req
		return []backend.Event{ev}

	case backend.EventPermissionReplied:
		delete(st.permissions, ev.RequestID)
		st.permissionOrder = removeString(st.permissionOrder, ev.RequestID)
		return []backend.Event{ev}

	case backend.EventUsage:
		st.usage = ev.Usage
		return []backend.Event{ev}

	case backend.EventSession:
		return []backend.Event{ev}

	case backend.EventError:
		return []backend.Event{ev}

	case backend.EventTodo:
		st.todos = ev.Todos
		return []backend.Event{ev}

	case backend.EventQuestionAsked:
		// A question is only remembered until answered, so a snapshot still
		// offers it.
		if _, exists := st.questions[ev.QuestionRequestID]; !exists {
			st.questionOrder = append(st.questionOrder, ev.QuestionRequestID)
		}
		st.questions[ev.QuestionRequestID] = &backend.QuestionRequest{
			ID:        ev.QuestionRequestID,
			Questions: ev.Questions,
			CallID:    ev.QuestionCallID,
		}
		return []backend.Event{ev}

	case backend.EventQuestionResolved:
		delete(st.questions, ev.QuestionRequestID)
		st.questionOrder = removeString(st.questionOrder, ev.QuestionRequestID)
		return []backend.Event{ev}

	default:
		// Forward-compatible: an event kind this build doesn't know yet is
		// dropped rather than forwarded blind (PROTOCOL.md §5 says unknown
		// kinds are ignored by both sides).
		return nil
	}
}

// translatePartLocked is the text contract (PROTOCOL.md §7): the first
// "part" event for a part id carries the text so far; a later "part" event
// for the same id is converted to a suffix delta when it only grew, dropped
// when it carries nothing new or has regressed, and re-baselined as a fresh
// upsert only when it is neither — never forwarded verbatim in a way that
// would contradict what was already sent.
func (m *Materializer) translatePartLocked(st *sessionState, ev backend.Event) []backend.Event {
	if ev.Part == nil {
		return nil
	}
	incoming := *ev.Part
	msgID, partID := incoming.MessageID, incoming.ID
	// A task/subtask part names the child session its call spawned —
	// the parent side of the same tree edge a session event reports
	// from the child's side. Recording it here means the link exists
	// before the child's own first event (including its first
	// permission.asked) ever arrives.
	if incoming.SubtaskSessionID != "" {
		m.setParentLocked(incoming.SubtaskSessionID, st.sessionID)
	}
	ensureMessageLocked(st, msgID, incoming.Role)
	// Backends like opencode keep the role on the message, not the part, but
	// PROTOCOL.md puts it on every part and delta so Cerea can tell the
	// person's own text from the agent's without tracking messages itself.
	if incoming.Role == "" {
		incoming.Role = st.messages[msgID].Role
	}
	ev.Part = &incoming

	parts, ok := st.parts[msgID]
	if !ok {
		parts = map[string]*backend.Part{}
		st.parts[msgID] = parts
	}
	existing, hasExisting := parts[partID]

	isText := incoming.Type == backend.PartText || incoming.Type == backend.PartReason
	if !hasExisting {
		st.partOrder[msgID] = append(st.partOrder[msgID], partID)
		stored := incoming
		parts[partID] = &stored
		return []backend.Event{ev}
	}
	if !isText {
		stored := incoming
		parts[partID] = &stored
		return []backend.Event{ev}
	}

	oldText, newText := existing.Text, incoming.Text
	switch {
	case newText == oldText:
		stored := incoming
		parts[partID] = &stored
		return nil
	case strings.HasPrefix(newText, oldText):
		delta := newText[len(oldText):]
		stored := incoming
		parts[partID] = &stored
		return []backend.Event{{
			Kind:      backend.EventDelta,
			MessageID: msgID,
			PartID:    partID,
			Role:      incoming.Role,
			Field:     "text",
			Delta:     delta,
		}}
	case strings.HasPrefix(oldText, newText):
		// A shorter resend of text already sent longer: no new information,
		// and forwarding it would regress what the client has assembled.
		return nil
	default:
		// Genuinely different content under the same part id (the backend
		// replaced it) — re-baseline as a fresh full upsert rather than a
		// delta, which could never express a non-suffix change truthfully.
		stored := incoming
		parts[partID] = &stored
		return []backend.Event{ev}
	}
}

// applyDeltaLocked folds a raw delta the backend itself emitted (as opposed
// to one this materializer synthesized in translatePartLocked) into the
// tracked part's text, creating a minimal placeholder part if this is
// somehow the first mention of it — defensive, since a well-behaved backend
// always sends a "part" event before any "delta" for the same id.
func (m *Materializer) applyDeltaLocked(st *sessionState, ev backend.Event) {
	ensureMessageLocked(st, ev.MessageID, ev.Role)
	parts, ok := st.parts[ev.MessageID]
	if !ok {
		parts = map[string]*backend.Part{}
		st.parts[ev.MessageID] = parts
	}
	p, ok := parts[ev.PartID]
	if !ok {
		p = &backend.Part{ID: ev.PartID, MessageID: ev.MessageID, Role: ev.Role, Type: backend.PartText}
		parts[ev.PartID] = p
		st.partOrder[ev.MessageID] = append(st.partOrder[ev.MessageID], ev.PartID)
	}
	p.Text += ev.Delta
}

// ensureMessageLocked registers msgID in message order with a placeholder
// Message if nothing has mentioned it yet. A backend that sends a part
// before (or without ever sending) a message-level event must not have its
// content silently dropped from the snapshot for want of metadata; a real
// EventMessage arriving later overwrites the placeholder in place, per the
// EventMessage case's own exists-check, without disturbing its position in
// messageOrder.
func ensureMessageLocked(st *sessionState, msgID, role string) {
	if _, exists := st.messages[msgID]; exists {
		return
	}
	st.messageOrder = append(st.messageOrder, msgID)
	st.messages[msgID] = &backend.Message{ID: msgID, Role: role}
}

// ActiveToolCall reports whether sessionID has a tool part for callID and
// tool that has not finished: how galopin proves a relayed tool call really
// is that session's, so a forged session id cannot borrow another's standing.
func (m *Materializer) ActiveToolCall(sessionID, tool, callID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.sessions[sessionID]
	if !ok {
		return false
	}
	for _, parts := range st.parts {
		for _, p := range parts {
			if p.Type == backend.PartTool && p.Tool == tool && p.CallID == callID &&
				(p.ToolStatus == backend.ToolPending || p.ToolStatus == backend.ToolRunning) {
				return true
			}
		}
	}
	return false
}

func removeString(list []string, s string) []string {
	for i, v := range list {
		if v == s {
			return append(list[:i:i], list[i+1:]...)
		}
	}
	return list
}

// Sync implements session.sync (PROTOCOL.md §6): a contiguous tail when
// epoch matches and the ring still holds it, else a full snapshot. A
// session's transcript is seeded from the backend's own persisted record
// exactly once, lazily, the first time a snapshot is needed and no live
// event has already supplied it — cheap for the common case (a session
// this process has been watching the whole time already has everything).
func (m *Materializer) Sync(ctx context.Context, sessionID, epoch string, afterSeq int64) (SyncResult, error) {
	m.mu.Lock()
	st, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return SyncResult{}, ErrUnknownSession
	}
	if epoch == m.epoch {
		if events, ok := st.since(afterSeq); ok {
			seq := st.seq
			m.mu.Unlock()
			return SyncResult{Epoch: m.epoch, Seq: seq, Events: events}, nil
		}
	}
	needsSeed := !st.seeded
	workspaceDir := st.workspaceDir
	m.mu.Unlock()

	if needsSeed {
		tr, err := m.back.Transcript(ctx, workspaceDir, sessionID)
		if err != nil {
			return SyncResult{}, fmt.Errorf("fetching transcript for %s: %w", sessionID, err)
		}
		m.mu.Lock()
		mergeSeedLocked(st, tr)
		m.mu.Unlock()
	}

	m.mu.Lock()
	snap := st.snapshot()
	seq := st.seq
	m.mu.Unlock()
	return SyncResult{Epoch: m.epoch, Seq: seq, Snapshot: &snap}, nil
}

// mergeSeedLocked folds a backend's persisted transcript into st, keeping
// whatever st already has for any message/permission id live events have
// already supplied (those are more current than a point-in-time fetch that
// may have raced them). Seeded messages are ones this process has not seen
// a live event for, which — since the materializer subscribes from process
// start — means they predate this epoch; they are ordered before whatever
// live messages are already tracked, rather than appended after (seeding
// happens lazily, possibly well after those live messages arrived, so
// insertion order alone would put history after activity that happened
// later in wall-clock time). Caller holds m.mu.
func mergeSeedLocked(st *sessionState, tr backend.Transcript) {
	if st.seeded {
		return
	}
	var seededOrder []string
	for _, entry := range tr.Messages {
		if _, exists := st.messages[entry.Message.ID]; exists {
			continue
		}
		msg := entry.Message
		st.messages[msg.ID] = &msg
		seededOrder = append(seededOrder, msg.ID)
		parts := map[string]*backend.Part{}
		order := make([]string, 0, len(entry.Parts))
		for _, p := range entry.Parts {
			part := p
			parts[p.ID] = &part
			order = append(order, p.ID)
		}
		st.parts[msg.ID] = parts
		st.partOrder[msg.ID] = order
	}
	st.messageOrder = append(seededOrder, st.messageOrder...)
	for _, perm := range tr.Permissions {
		if _, exists := st.permissions[perm.ID]; exists {
			continue
		}
		req := perm
		st.permissions[perm.ID] = &req
		st.permissionOrder = append(st.permissionOrder, perm.ID)
	}
	// Asks the backend already held predate any live one: they go first.
	var seededQuestions []string
	for _, q := range tr.Questions {
		if _, exists := st.questions[q.ID]; exists {
			continue
		}
		req := q
		st.questions[q.ID] = &req
		seededQuestions = append(seededQuestions, q.ID)
	}
	st.questionOrder = append(seededQuestions, st.questionOrder...)
	if st.usage == nil {
		st.usage = tr.Usage
	}
	if len(st.todos) == 0 {
		st.todos = tr.Todos
	}
	if st.status == "" {
		st.status = tr.Status
	}
	st.seeded = true
}

// PendingPermissions is the count of permission requests currently awaiting
// a reply for sessionID — the Session.pendingPermissions field
// (PROTOCOL.md §6), which is the materializer's own aggregation, not
// anything a backend reports directly.
func (m *Materializer) PendingPermissions(sessionID string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.sessions[sessionID]
	if !ok {
		return 0
	}
	return len(st.permissionOrder)
}

// PendingPermissionRequests returns copies of the permission requests
// currently awaiting a reply for sessionID, in the order they were asked —
// what permissions.pending serves. Empty, never nil, when none are waiting.
func (m *Materializer) PendingPermissionRequests(sessionID string) []backend.PermissionRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.sessions[sessionID]
	if !ok {
		return []backend.PermissionRequest{}
	}
	out := make([]backend.PermissionRequest, 0, len(st.permissionOrder))
	for _, id := range st.permissionOrder {
		if req, ok := st.permissions[id]; ok {
			out = append(out, *req)
		}
	}
	return out
}

// PendingQuestionRequests returns copies of the unanswered question-tool
// asks for sessionID, in the order they were asked — what
// permissions.pending serves alongside permissions. Empty, never nil.
func (m *Materializer) PendingQuestionRequests(sessionID string) []backend.QuestionRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.sessions[sessionID]
	if !ok {
		return []backend.QuestionRequest{}
	}
	out := make([]backend.QuestionRequest, 0, len(st.questionOrder))
	for _, id := range st.questionOrder {
		if req, ok := st.questions[id]; ok {
			out = append(out, *req)
		}
	}
	return out
}

// TrackedIDs returns every session id the materializer knows, top-level and
// subagent alike — what permissions.pending scans. Sorted for a stable wire
// order; callers must not mutate the session states through it.
func (m *Materializer) TrackedIDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		out = append(out, id)
	}
	// Insertion order would do, but a map's iteration order does not —
	// sort so two identical states answer identically.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// Reseed forgets what the materializer holds of sessionID's transcript
// (messages, parts, the ring of past envelopes), so the next session.sync
// from scratch answers with a snapshot re-read from the backend: after a
// revert the stored history no longer matches the session. seq keeps
// counting, so no cursor ever goes backwards; a client resyncs from scratch.
func (m *Materializer) Reseed(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.sessions[sessionID]
	if !ok {
		return
	}
	st.seeded = false
	st.ring = nil
	st.messageOrder = nil
	st.messages = map[string]*backend.Message{}
	st.partOrder = map[string][]string{}
	st.parts = map[string]map[string]*backend.Part{}
}

// ChildSummary counts sessionID's subagents from the tree edges the
// materializer has learned (from any workspace): its direct children, those
// of them mid-turn, and every descendant waiting on a permission reply. Nil
// when it has no known child.
//
// A single-session lookup: O(tracked sessions). session.list wants every
// listed session's summary at once — ChildSummaries below answers that in
// one O(tracked sessions) pass instead of N of these.
func (m *Materializer) ChildSummary(sessionID string) *backend.ChildSummary {
	m.mu.Lock()
	defer m.mu.Unlock()
	var sum backend.ChildSummary
	for id, st := range m.sessions {
		if id == sessionID || st.parentID == "" {
			continue
		}
		if st.parentID == sessionID {
			sum.Children++
			if st.status == backend.StatusBusy || st.status == backend.StatusRetry {
				sum.Running++
			}
		}
		if len(st.permissionOrder) > 0 && m.descendsFromLocked(id, sessionID) {
			sum.Waiting++
		}
	}
	if sum.Children == 0 {
		return nil
	}
	return &sum
}

// ChildSummaries computes every tracked session's ChildSummary in one pass,
// for session.list (PROTOCOL.md §6): calling ChildSummary once per listed
// session made the op O(sessions²) — each call rescanned the whole tracked
// set — which is what the subagent-count feature (added the night before
// this) turned into the /code sidebar's slow-after-reload symptom once a
// device had accumulated enough sessions. The result maps a session id to
// its summary; a session with no known child has no entry (nil, same as
// ChildSummary's own contract).
func (m *Materializer) ChildSummaries() map[string]*backend.ChildSummary {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[string]*backend.ChildSummary{}
	get := func(id string) *backend.ChildSummary {
		s, ok := out[id]
		if !ok {
			s = &backend.ChildSummary{}
			out[id] = s
		}
		return s
	}
	// Pass 1: direct children and how many of them are mid-turn.
	for _, st := range m.sessions {
		if st.parentID == "" {
			continue
		}
		parent := get(st.parentID)
		parent.Children++
		if st.status == backend.StatusBusy || st.status == backend.StatusRetry {
			parent.Running++
		}
	}
	// Pass 2: every session with a pending permission marks each of its
	// ancestors as having a waiting descendant — the same walk
	// descendsFromLocked did per (id, ancestor) pair, done once per session
	// instead of once per (session, listed session) pair.
	for id, st := range m.sessions {
		if len(st.permissionOrder) == 0 {
			continue
		}
		seen := map[string]bool{id: true}
		parentID := st.parentID
		for parentID != "" && !seen[parentID] {
			get(parentID).Waiting++
			seen[parentID] = true
			parent, ok := m.sessions[parentID]
			if !ok {
				break
			}
			parentID = parent.parentID
		}
	}
	for id, s := range out {
		if s.Children == 0 {
			delete(out, id)
		}
	}
	return out
}

// descendsFromLocked reports whether sessionID has ancestor somewhere up its
// parent chain. Cycle-safe. Caller holds m.mu.
func (m *Materializer) descendsFromLocked(sessionID, ancestor string) bool {
	seen := map[string]bool{sessionID: true}
	current := sessionID
	for {
		st, ok := m.sessions[current]
		if !ok || st.parentID == "" || seen[st.parentID] {
			return false
		}
		if st.parentID == ancestor {
			return true
		}
		seen[st.parentID] = true
		current = st.parentID
	}
}

// Live is the permission policy holder the materializer reads (see UseLive).
func (m *Materializer) Live() *policy.Live { return m.live }

// UseLive makes the materializer read the permission policy from live, the
// holder the rest of the agent shares. Call before Start.
func (m *Materializer) UseLive(live *policy.Live) { m.live = live }

// LatestUserMessage is the newest user message the materializer holds for
// sessionID: the one that started (or last steered) its current turn. False
// when the session has none.
func (m *Materializer) LatestUserMessage(sessionID string) (backend.Message, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.sessions[sessionID]
	if !ok {
		return backend.Message{}, false
	}
	for i := len(st.messageOrder) - 1; i >= 0; i-- {
		if msg := st.messages[st.messageOrder[i]]; msg != nil && msg.Role == "user" {
			return *msg, true
		}
	}
	return backend.Message{}, false
}

// WithdrawPending closes every permission and question ask the materializer
// still holds, announcing each as rejected/resolved so no client keeps a card
// for it. It is for the moment the backend process was restarted on purpose
// (a tightened ceiling): its asks lived in its memory and are gone, and a card
// for one would answer into nothing.
func (m *Materializer) WithdrawPending() {
	m.mu.Lock()
	var envs []Envelope
	for _, st := range m.sessions {
		for _, id := range append([]string(nil), st.permissionOrder...) {
			delete(st.permissions, id)
			envs = append(envs, m.appendRingLocked(st, backend.Event{
				Kind: backend.EventPermissionReplied, RequestID: id, Decision: backend.DecisionReject, By: "user",
			}))
		}
		st.permissionOrder = nil
		for _, id := range append([]string(nil), st.questionOrder...) {
			delete(st.questions, id)
			envs = append(envs, m.appendRingLocked(st, backend.Event{
				Kind: backend.EventQuestionResolved, QuestionRequestID: id, QuestionDecision: "rejected",
			}))
		}
		st.questionOrder = nil
	}
	m.mu.Unlock()
	for _, env := range envs {
		m.publish(env)
	}
}
