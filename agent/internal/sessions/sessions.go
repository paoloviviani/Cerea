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
	"time"

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

// heldAsk is one held ask id's bookkeeping.
type heldAsk struct {
	holds int
	gone  bool
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
	// parentSince is when the tree edge was learned. ReconcileChildren
	// reads it: an edge learned a moment ago may be a child the answer it
	// reconciles against could not list yet (the spawn race), and must not
	// be pruned on the strength of one answer.
	parentSince time.Time
	// recordSeen: the session's own record (Track, or a session event) was
	// seen, so a session with no parent is known to be top-level rather than
	// a child whose edge has not arrived yet.
	recordSeen bool

	seq  int64
	ring []Envelope

	messageOrder []string
	messages     map[string]*backend.Message
	partOrder    map[string][]string
	parts        map[string]map[string]*backend.Part
	// touched is the seq of the last live event that wrote to a message's
	// info (touchedMessage) or to one of its parts (touchedPart). A resync
	// reads it to tell what a transcript fetched earlier cannot have known
	// about, one part at a time (see resync).
	touched map[string]int64
	// removed is the seq of the live event that removed a part (a tombstone),
	// so a resync whose fetch began before the removal does not bring the part
	// back from the transcript's older copy.
	removed map[string]int64
	// lastResyncAt is the fetchedAt of the newest resync applied; a resync
	// whose fetch began earlier (two overlapped) is discarded, or it would
	// revert what the newer one took.
	lastResyncAt int64
	// generation is bumped by Reseed; a resync whose fetch began in an older
	// one holds a pre-revert transcript and is discarded.
	generation int

	permissionOrder []string
	permissions     map[string]*backend.PermissionRequest

	// questionOrder/questions are the unanswered question-tool asks, kept
	// for the same reason as permissions: a snapshot must still offer them.
	questionOrder []string
	questions     map[string]*backend.QuestionRequest

	// queued is the follow-ups the backend last announced as waiting.
	queued []backend.QueuedPrompt

	status backend.SessionStatus
	retry  *backend.RetryInfo
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
		touched:      map[string]int64{},
		removed:      map[string]int64{},
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
		Queued:      s.queued,
		Status:      s.status,
		Retry:       s.retry,
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
	onChild func(workspaceDir, childID string)
	// onAsk is told, outside the lock, of each permission ask a subagent
	// session raises (its root's selector may already allow it).
	onAsk       func(workspaceDir string, req backend.PermissionRequest)
	newChildren []string
	// onAskFilter is consulted, without the lock held and before any state
	// is touched, for every permission ask a LIVE event carries (root and
	// child sessions alike, opencode's own asks and galopin's own gp_ asks —
	// both arrive as EventPermissionAsked). When it returns true the ask is
	// consumed: it is never recorded in the ring, never published, and onAsk
	// is never told of it. The filter must be fast and do no I/O itself: a
	// rejection that needs work (answering the ask, auditing it) belongs in
	// a goroutine the filter's owner starts. It runs before the
	// materializer lock is taken, so read-only materializer calls such as
	// RootOf are safe; anything that could block or re-enter event
	// application is not.
	onAskFilter func(workspaceDir string, req backend.PermissionRequest) bool
	// onAskStamp says, for every ask that stays a card (live, or seeded from
	// the backend's history), its permission class; the answer is carried on
	// the request as Class. Like the filter it is called without the lock held.
	onAskStamp func(workspaceDir string, req backend.PermissionRequest) (class string, readOnly bool)
	// onAskLeak marks an ask whose call carries a local secret's value (names only).
	onAskLeak func(workspaceDir string, req backend.PermissionRequest) (key, file string)

	// held is the asks the machine consumed to hold while it learns their
	// session's place in the tree (HoldAsk), by id: how many holds are open (the
	// same ask can pass the filter twice: a re-delivered event, the sync sweep) and
	// whether it was answered or withdrawn meanwhile, so ReleaseAsk does not bring
	// back a card for an ask that no longer exists. Guarded by mu.
	held map[string]*heldAsk

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
	if st, exists := m.sessions[sess.ID]; exists {
		// A startup listing naming an old child's parent is not news: the
		// OnChild hook is for children a live event reveals.
		seen := len(m.newChildren)
		m.setParentLocked(sess.ID, sess.ParentID)
		m.newChildren = m.newChildren[:seen]
		st.recordSeen = true
		return
	}
	st := newSessionState(workspaceDir, sess.ID)
	st.recordSeen = true
	st.status = sess.Status
	st.parentID = sess.ParentID
	if sess.ParentID != "" {
		st.parentSince = time.Now()
	}
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
		st.parentSince = time.Now()
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

// OnChildAsk installs the callback told of every permission ask a subagent
// session raises, so the machine can answer one its root's selector allows. Set
// before Start.
func (m *Materializer) OnChildAsk(fn func(workspaceDir string, req backend.PermissionRequest)) {
	m.onAsk = fn
}

// OnAskFilter installs the pre-filter consulted for every permission ask a
// live event carries, before the ask is recorded or published (see
// onAskFilter). An ask it consumes never becomes a card anywhere. Set before
// Start.
func (m *Materializer) OnAskFilter(fn func(workspaceDir string, req backend.PermissionRequest) bool) {
	m.onAskFilter = fn
}

// OnAskStamp installs the permission-class marker (see onAskStamp). Set
// before Start.
func (m *Materializer) OnAskStamp(fn func(workspaceDir string, req backend.PermissionRequest) (string, bool)) {
	m.onAskStamp = fn
}

// OnAskLeak installs the secret-value marker: for every ask that stays a card it
// says which local secret's value the call carries (key, file), or "" for none.
// Set before Start.
func (m *Materializer) OnAskLeak(fn func(workspaceDir string, req backend.PermissionRequest) (key, file string)) {
	m.onAskLeak = fn
}

// stampPending gives their class to the asks the materializer holds for
// sessionID: the seeded ones, which never passed through a live event. Called
// without the lock held.
func (m *Materializer) stampPending(sessionID string) {
	if m.onAskStamp == nil {
		return
	}
	m.mu.Lock()
	st, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return
	}
	dir := st.workspaceDir
	pending := make([]backend.PermissionRequest, 0, len(st.permissionOrder))
	for _, id := range st.permissionOrder {
		if req, ok := st.permissions[id]; ok {
			pending = append(pending, *req)
		}
	}
	m.mu.Unlock()
	classes := make([]string, len(pending))
	readOnly := make([]bool, len(pending))
	leakKey := make([]string, len(pending))
	leakFile := make([]string, len(pending))
	for i, req := range pending {
		classes[i], readOnly[i] = m.onAskStamp(dir, req)
		if m.onAskLeak != nil {
			leakKey[i], leakFile[i] = m.onAskLeak(dir, req)
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, req := range pending {
		if cur, ok := st.permissions[req.ID]; ok {
			cur.Class = classes[i]
			cur.ReadOnly = readOnly[i]
			cur.SecretKey, cur.SecretFile = leakKey[i], leakFile[i]
		}
	}
}

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

// BackgroundTaskOf says whether childID is a background task of its parent:
// the parent's task call that started it carries background:true. It returns
// the parent and the task's title. False when the parent's call is not known
// (a parent whose transcript was never loaded), so nothing is guessed.
func (m *Materializer) BackgroundTaskOf(childID string) (parentID, title string, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	child, found := m.sessions[childID]
	if !found || child.parentID == "" {
		return "", "", false
	}
	parent, found := m.sessions[child.parentID]
	if !found {
		return "", "", false
	}
	for _, parts := range parent.parts {
		for _, p := range parts {
			if p.Type != backend.PartTool || p.Tool != "task" || p.SubtaskSessionID != childID {
				continue
			}
			if bg, _ := p.Input["background"].(bool); !bg {
				return "", "", false
			}
			title, _ = p.Input["description"].(string)
			if title == "" {
				title = p.Title
			}
			if title == "" {
				title = "background task"
			}
			return child.parentID, title, true
		}
	}
	return "", "", false
}

// HasMessages reports whether the materializer holds any message of the
// session (live or seeded).
func (m *Materializer) HasMessages(sessionID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.sessions[sessionID]
	return ok && len(st.messageOrder) > 0
}

// LastTurnAborted reports whether the session's newest assistant message was
// cut short by a Stop.
func (m *Materializer) LastTurnAborted(sessionID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.sessions[sessionID]
	if !ok {
		return false
	}
	for i := len(st.messageOrder) - 1; i >= 0; i-- {
		if msg := st.messages[st.messageOrder[i]]; msg != nil && msg.Role == "assistant" {
			return msg.Aborted
		}
	}
	return false
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

// Below reports whether childID sits strictly below ancestorID in the
// session tree (a child, grandchild, … — never the ancestor itself).
// Unknown ids are below nothing: a caller only ever sees the part of its
// own tree the tree actually knows. Cycle-safe like rootLocked.
func (m *Materializer) Below(childID, ancestorID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	seen := map[string]bool{childID: true}
	current := childID
	for {
		st, ok := m.sessions[current]
		if !ok || st.parentID == "" {
			return false
		}
		if st.parentID == ancestorID {
			return true
		}
		if seen[st.parentID] {
			return false
		}
		seen[st.parentID] = true
		current = st.parentID
	}
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
	m.applyBackendEvent(ctx, be, true)
}

// HoldAsk records that the ask id was consumed by the pre-filter to be decided
// later, so that a reply or a withdrawal that comes first is remembered. Holds
// are counted per id and a mark already made is kept: the same ask passing the
// filter twice must not forget that it was answered. The holder ends each hold
// with ReleaseAsk or DropHeld.
func (m *Materializer) HoldAsk(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.held == nil {
		m.held = map[string]*heldAsk{}
	}
	h := m.held[id]
	if h == nil {
		h = &heldAsk{}
		m.held[id] = h
	}
	h.holds++
}

// DropHeld ends a hold whose ask was decided without a card (answered).
func (m *Materializer) DropHeld(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.endHoldLocked(id)
}

// endHoldLocked closes one hold of id and reports whether the ask was answered
// or withdrawn meanwhile (false for an id that is not held).
func (m *Materializer) endHoldLocked(id string) (gone bool) {
	h := m.held[id]
	if h == nil {
		return false
	}
	gone = h.gone
	if h.holds--; h.holds <= 0 {
		delete(m.held, id)
	}
	return gone
}

// ReleaseAsk materialises a permission ask the pre-filter consumed to hold
// while it learned the ask's session tree, and that turned out to be a card:
// the same path as a live ask, without the filter (it already decided). An ask
// answered or withdrawn while it was held (the backend's reply event, or
// WithdrawPending) shows no card.
func (m *Materializer) ReleaseAsk(ctx context.Context, workspaceDir string, req backend.PermissionRequest) {
	m.applyBackendEvent(ctx, backend.BackendEvent{WorkspaceDir: workspaceDir, SessionID: req.SessionID,
		Event: backend.Event{Kind: backend.EventPermissionAsked, Request: &req}}, false)
}

// TreeKnown reports whether the materializer knows where a session sits in
// the tree: the top of the chain it can walk has had its own record seen (Track
// or a session event), so that top is a real top-level session. A session this
// says no to may be a child whose edge has not arrived, so it must not be
// taken for a root.
func (m *Materializer) TreeKnown(sessionID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.sessions[m.rootLocked(sessionID)]
	return ok && st.recordSeen
}

// MarkTreeKnown settles a session's place as far as it will be settled: its
// record could not be read, so the top of the chain walked so far is treated as
// top-level until an edge turns up (setParentLocked still takes one), and its
// asks stop being held.
func (m *Materializer) MarkTreeKnown(workspaceDir, sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	root := m.rootLocked(sessionID)
	st, ok := m.sessions[root]
	if !ok {
		// only sessionID itself is known to live in workspaceDir: a top known only
		// from a link is left to say where it lives itself
		dir := workspaceDir
		if root != sessionID {
			dir = ""
		}
		st = newSessionState(dir, root)
		m.sessions[root] = st
	}
	st.recordSeen = true
}

func (m *Materializer) applyBackendEvent(ctx context.Context, be backend.BackendEvent, filter bool) {
	if be.Event.Kind == backend.EventResync {
		go m.resync(ctx, be.WorkspaceDir, be.SessionID)
		return
	}
	if filter && be.Event.Kind == backend.EventPermissionAsked && be.Event.Request != nil && m.onAskFilter != nil {
		// Consulted before translateLocked: a consumed ask is never
		// materialised, so no permission.asked envelope reaches any client
		// and no card flashes. Seeded history (Sync's mergeSeedLocked) does
		// not pass through here.
		if m.onAskFilter(be.WorkspaceDir, *be.Event.Request) {
			return
		}
	}
	if be.Event.Kind == backend.EventPermissionAsked && be.Event.Request != nil && m.onAskStamp != nil {
		req := *be.Event.Request
		// both fields are overwritten, whatever the agent's request carried
		req.Class, req.ReadOnly = m.onAskStamp(be.WorkspaceDir, req)
		if m.onAskLeak != nil {
			req.SecretKey, req.SecretFile = m.onAskLeak(be.WorkspaceDir, req)
		} else {
			req.SecretKey, req.SecretFile = "", ""
		}
		be.Event.Request = &req
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
		st.recordSeen = true
	}
	switch {
	case be.Event.Kind == backend.EventPermissionReplied:
		// answered while held: its release must not bring a card back
		if h := m.held[be.Event.RequestID]; h != nil {
			h.gone = true
		}
	case !filter && be.Event.Kind == backend.EventPermissionAsked && be.Event.Request != nil:
		if m.endHoldLocked(be.Event.Request.ID) {
			m.mu.Unlock()
			return
		}
	}
	events := m.translateLocked(st, be.Event)
	envs := make([]Envelope, 0, len(events))
	for _, ev := range events {
		env := m.appendRingLocked(st, ev)
		envs = append(envs, env)
		if key := touchKey(ev); key != "" {
			st.touched[key] = env.Seq
		}
		if ev.Kind == backend.EventPartRemoved {
			st.removed[partKey(ev.MessageID, ev.PartID)] = env.Seq
		}
	}
	children := m.drainChildrenLocked()
	var childAsk *backend.PermissionRequest
	if be.Event.Kind == backend.EventPermissionAsked && be.Event.Request != nil && st.parentID != "" {
		r := *be.Event.Request
		childAsk = &r
	}
	m.mu.Unlock()
	if m.onChild != nil {
		for _, c := range children {
			m.onChild(c.dir, c.id)
		}
	}
	if childAsk != nil && m.onAsk != nil {
		m.onAsk(be.WorkspaceDir, *childAsk)
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
	// What the fetch below can know: everything up to this seq. A message a
	// live event wrote to after it is newer than the transcript.
	var fetchedAt int64
	var generation int
	if ok {
		fetchedAt = st.seq
		generation = st.generation
	}
	m.mu.Unlock()
	if !ok {
		return
	}
	tr, err := m.back.Transcript(ctx, workspaceDir, sessionID)
	if err != nil {
		return
	}
	m.mu.Lock()
	if fetchedAt < st.lastResyncAt || generation != st.generation {
		// a resync whose fetch began later has already applied a newer copy
		m.mu.Unlock()
		return
	}
	st.lastResyncAt = fetchedAt
	reseedKeepingLiveLocked(st, tr, fetchedAt)
	var envs []Envelope
	for _, entry := range tr.Messages {
		for _, p := range entry.Parts {
			// A part a live event wrote after the fetch is newer than the transcript's copy, which
			// was already announced live; every other tool part is announced from the transcript
			if p.Type != backend.PartTool || st.touched[partKey(p.MessageID, p.ID)] > fetchedAt || st.removed[partKey(p.MessageID, p.ID)] > 0 {
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
	m.stampPending(sessionID)
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
		st.retry = nil
		if ev.Status == backend.StatusRetry {
			st.retry = ev.Retry
		}
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

	case backend.EventQueue:
		st.queued = ev.Queued
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

func messageKey(id string) string { return "m:" + id }

func partKey(messageID, partID string) string { return "p:" + messageID + "/" + partID }

// touchKey names what a live event writes to: a message's info or one of its
// parts, or "" when it writes to neither.
func touchKey(ev backend.Event) string {
	switch {
	case ev.Kind == backend.EventMessage && ev.Message != nil:
		return messageKey(ev.Message.ID)
	case ev.Kind == backend.EventPart && ev.Part != nil:
		return partKey(ev.Part.MessageID, ev.Part.ID)
	case ev.Kind == backend.EventDelta:
		return partKey(ev.MessageID, ev.PartID)
	default:
		return ""
	}
}

// reseedKeepingLiveLocked is resync's swap: forget the held history and take
// the fetched transcript, except for what a live event wrote after the fetch
// began (its seq is above fetchedAt), judged per message info and per part. The
// fetch is a point-in-time read: a part the running turn wrote meanwhile is
// newer than it, and replacing that with the stale copy left a finished turn
// with no text in every later snapshot. But a part no live event touched since
// is taken from the transcript even on a message that did see live events:
// that is the whole reason for a resync (a dropped line, a gap) and the
// transcript holds state the live events never delivered. Caller holds m.mu.
func reseedKeepingLiveLocked(st *sessionState, tr backend.Transcript, fetchedAt int64) {
	oldOrder := st.messageOrder
	oldMessages := st.messages
	oldParts := st.parts
	oldPartOrder := st.partOrder
	oldTouched := st.touched
	oldRemoved := st.removed
	st.seeded = false
	st.ring = nil
	st.messageOrder = nil
	st.messages = map[string]*backend.Message{}
	st.partOrder = map[string][]string{}
	st.parts = map[string]map[string]*backend.Part{}
	st.touched = map[string]int64{}
	st.removed = map[string]int64{}
	mergeSeedLocked(st, tr)
	// A part removed live after the fetch began is gone, whatever the
	// transcript still says (unless a later live write recreated it).
	for key, rseq := range oldRemoved {
		if rseq <= fetchedAt || rseq < oldTouched[key] {
			continue
		}
		st.removed[key] = fetchedAt + 1
	}
	for id, parts := range st.parts {
		for pid := range parts {
			if st.removed[partKey(id, pid)] > 0 {
				delete(parts, pid)
				st.partOrder[id] = removeString(st.partOrder[id], pid)
			}
		}
	}
	for _, id := range oldOrder {
		liveInfo := oldTouched[messageKey(id)] > fetchedAt
		var liveParts []string
		for _, pid := range oldPartOrder[id] {
			if oldTouched[partKey(id, pid)] > fetchedAt {
				liveParts = append(liveParts, pid)
			}
		}
		if !liveInfo && len(liveParts) == 0 {
			continue
		}
		if _, inTranscript := st.messages[id]; !inTranscript {
			st.messageOrder = append(st.messageOrder, id)
			st.messages[id] = oldMessages[id]
			st.parts[id] = map[string]*backend.Part{}
		} else if liveInfo {
			st.messages[id] = oldMessages[id]
		}
		if st.parts[id] == nil {
			st.parts[id] = map[string]*backend.Part{}
		}
		if liveInfo {
			st.touched[messageKey(id)] = fetchedAt + 1
		}
		for _, pid := range liveParts {
			if _, seen := st.parts[id][pid]; !seen {
				st.partOrder[id] = append(st.partOrder[id], pid)
			}
			st.parts[id][pid] = oldParts[id][pid]
			st.touched[partKey(id, pid)] = fetchedAt + 1
		}
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
		m.stampPending(sessionID)
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

// SweepDeniedAsks collects the permission asks the materializer still holds
// for sessionID that the ask pre-filter consumes — a Deny root's asks,
// whether they arrived live or were seeded from history (seeding does not
// pass through the filter). It collects only: answering stays with the
// caller (rejectDenyAsk + WithdrawPermission, as for a mode switch). The
// filter is consulted without the lock held, like the live path; nil filter
// (no permissions backend) collects nothing.
func (m *Materializer) SweepDeniedAsks(sessionID string) []backend.PermissionRequest {
	m.mu.Lock()
	st, ok := m.sessions[sessionID]
	if !ok || m.onAskFilter == nil {
		m.mu.Unlock()
		return nil
	}
	dir := st.workspaceDir
	pending := make([]backend.PermissionRequest, 0, len(st.permissionOrder))
	for _, id := range st.permissionOrder {
		if req, ok := st.permissions[id]; ok {
			pending = append(pending, *req)
		}
	}
	filter := m.onAskFilter
	m.mu.Unlock()
	var out []backend.PermissionRequest
	for _, req := range pending {
		if filter(dir, req) {
			out = append(out, req)
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
	st.generation++
	st.seeded = false
	st.ring = nil
	st.messageOrder = nil
	st.messages = map[string]*backend.Message{}
	st.partOrder = map[string][]string{}
	st.parts = map[string]map[string]*backend.Part{}
	st.touched = map[string]int64{}
	st.removed = map[string]int64{}
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

// spawnEdgeGrace is how long an edge just learned is spared from
// ReconcileChildren: a child spawned while its parent's /children answer was
// being taken has an edge the answer could not name, and one reconcile must
// not read as its deletion. A minute covers any gap between the answer and
// the reconcile and delays noticing a real deletion by no more than a
// minute past the panel's next look.
const spawnEdgeGrace = time.Minute

// ReconcileChildren drops the tree edges the materializer learned for
// parentID's children that live does not name, so ChildSummary counts only
// children the backend still has (a deleted subagent must stop being
// counted). live is the backend's own answer, the authoritative list.
//
// Pruning an edge missing from the answer is safe because an edge always
// names a session that already existed when it was learned: opencode's task
// tool creates the child session and only then emits the part whose
// metadata carries the child's id, and session events and listings report
// existing sessions — so an answer taken later lists every edge learned
// before it, and a missing one was deleted in between. The one false
// positive is an edge learned while the answer was in flight; those are
// spared for spawnEdgeGrace instead.
//
// Only the edge is dropped: the child's own transcript state is kept, so a
// panel still reading the deleted session's transcript keeps what it had
// until the process restarts.
func (m *Materializer) ReconcileChildren(parentID string, live []string) {
	keep := make(map[string]bool, len(live))
	for _, id := range live {
		keep[id] = true
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, st := range m.sessions {
		if st.parentID != parentID || keep[id] {
			continue
		}
		if time.Since(st.parentSince) < spawnEdgeGrace {
			continue
		}
		st.parentID = ""
	}
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
	for _, h := range m.held {
		h.gone = true // an ask held for its tree is gone with the process too
	}
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

// WithdrawPermission closes one permission ask the materializer still holds,
// announcing it as rejected so no client keeps a card for it; a no-op when it
// holds none by that id. It is for an ask the backend says is already gone.
func (m *Materializer) WithdrawPermission(sessionID, requestID string) {
	m.mu.Lock()
	st, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return
	}
	if _, held := st.permissions[requestID]; !held {
		m.mu.Unlock()
		return
	}
	delete(st.permissions, requestID)
	st.permissionOrder = removeString(st.permissionOrder, requestID)
	env := m.appendRingLocked(st, backend.Event{
		Kind: backend.EventPermissionReplied, RequestID: requestID, Decision: backend.DecisionReject, By: "user",
	})
	m.mu.Unlock()
	m.publish(env)
}
