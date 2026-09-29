package backend

import "context"

// Capabilities is what a backend can do beyond the floor every backend
// implements, advertised in the link's hello frame (PROTOCOL.md §5) so
// Cerea can hide affordances a given backend lacks instead of the backend
// faking them.
type Capabilities struct {
	Diff       bool `json:"diff"`
	Children   bool `json:"children"`
	Usage      bool `json:"usage"`
	Compact    bool `json:"compact"`
	Images     bool `json:"images"`
	Files      bool `json:"files"`
	Worktrees  bool `json:"worktrees"`
	AutoAccept bool `json:"autoAccept"`
	// Questions is the user-question tool design's own capability: whether
	// this backend has a native multiple-choice question mechanism
	// (opencode: the built-in "question" tool, GET/POST /question). ACP
	// reports false — ACP has no wire message for it.
	Questions bool `json:"questions"`
	// Revert is rolling a session back to before one of its messages (and
	// Unrevert undoing that): opencode's POST /session/:id/revert. RevertFiles
	// says whether that also restores the workspace files the reverted turns
	// changed (opencode: yes, from its per-step snapshots).
	Revert      bool `json:"revert"`
	RevertFiles bool `json:"revertFiles"`
	// Efforts is a per-session thinking effort (session.setEffort), picked
	// from the model's Efforts: opencode sends it as the prompt's variant.
	Efforts bool `json:"efforts"`
	// Commands is listing and running slash commands (PROTOCOL.md §6
	// backend.commands / session.command). opencode advertises it only when
	// the server's own GET /doc lists the session.command operation — probed,
	// never a version string. ACP reports it always: its
	// available_commands_update carries the list per session.
	Commands bool `json:"commands"`
	// ToolImages is listing a tool call's images on its part and serving
	// their bytes by sha256 (PROTOCOL.md §6 session.attachment).
	ToolImages bool `json:"toolImages"`
	// AgentTools says galopin has installed its own agent-coordination tools
	// (session_list/session_spawn/session_send) into this backend
	// (PROTOCOL.md §6 "Agent tools"). Steer says a prompt sent while the
	// session's turn runs is folded into that turn instead of refused.
	AgentTools bool `json:"agentTools"`
	Steer      bool `json:"steer"`
}

// CreateSessionOptions are session.create's optional fields (PROTOCOL.md
// §6). Empty ModeID/ModelID mean "let the backend choose its default".
type CreateSessionOptions struct {
	Title   string
	ModeID  string
	ModelID string
	// SpawnedBy marks the new top-level session as one another session
	// created with session_spawn; the backend persists it.
	SpawnedBy *SpawnedBy
}

// Prompt is one session.prompt call's payload (PROTOCOL.md §6).
type Prompt struct {
	Text            string
	ClientMessageID string
	Attachments     []Attachment
	// Command, when set, marks the user message this prompt creates as a
	// slash command run (PROTOCOL.md §6 session.command). The ACP backend
	// sets it — the message is its own synthesis; opencode ignores it, its
	// marker is derived from the minted messageID instead.
	Command *MessageCommand
	// SentBy marks the user message this prompt creates as another
	// session's session_send; Preface is the text (a synthetic part) that
	// tells the target's model who wrote it.
	SentBy  *MessageSender
	Preface string
}

// Backend is what internal/sessions drives per coding-agent backend: create
// and manage sessions, send prompts, stream normalized events, answer
// permission requests, and report modes/models. See the package doc for why
// this is shaped like ACP without being ACP.
//
// workspaceDir is always an absolute, already-validated directory (internal
// /workspaces and internal/policy have done their checks before a Backend
// method is ever called); a Backend implementation trusts it.
type Backend interface {
	ID() string
	Version() string
	Capabilities() Capabilities

	ListSessions(ctx context.Context, workspaceDir string) ([]Session, error)
	GetSession(ctx context.Context, workspaceDir, sessionID string) (Session, error)
	CreateSession(ctx context.Context, workspaceDir string, opts CreateSessionOptions) (Session, error)
	RenameSession(ctx context.Context, workspaceDir, sessionID, title string) (Session, error)
	DeleteSession(ctx context.Context, workspaceDir, sessionID string) error

	Prompt(ctx context.Context, workspaceDir, sessionID string, prompt Prompt) error
	Cancel(ctx context.Context, workspaceDir, sessionID string) error

	SetMode(ctx context.Context, workspaceDir, sessionID, modeID string) (Session, error)
	SetModel(ctx context.Context, workspaceDir, sessionID, modelID string) (Session, error)

	ReplyPermission(ctx context.Context, workspaceDir, sessionID, requestID string, decision Decision, message string) error

	Modes(ctx context.Context, workspaceDir string) ([]Mode, error)
	Models(ctx context.Context, workspaceDir string) ([]Model, error)

	// Transcript is the backend's own persisted record of a session. It is
	// what internal/sessions seeds a session's state from lazily, the first
	// time anything asks about a session it hasn't seen an event for yet
	// since this process started (PROTOCOL.md §7).
	Transcript(ctx context.Context, workspaceDir, sessionID string) (Transcript, error)

	// Subscribe streams every event of every session this backend knows
	// about, from now on. internal/sessions subscribes once, at process
	// start, and keeps the channel for the process's lifetime; a backend
	// implementation is responsible for reconnecting its own underlying
	// transport (opencode's SSE stream) internally and must not close the
	// channel just because one connection attempt failed. The channel
	// closing at all means the subscription is over for good — the caller
	// treats that as fatal (PROTOCOL.md §7: a new epoch, because this
	// process's view of events cannot be trusted to resume).
	Subscribe(ctx context.Context) (<-chan BackendEvent, error)
}

// BackendEvent pairs a backend's own session identity with the normalized
// Event, so a subscriber fanning out events (internal/sessions) can route
// each one without the backend having to know about workspace or session
// registries that live above it.
type BackendEvent struct {
	WorkspaceDir string
	SessionID    string
	Event        Event
}

// Differ is the optional "diff" capability (PROTOCOL.md §6 session.diff).
type Differ interface {
	Diff(ctx context.Context, workspaceDir, sessionID string) ([]FileDiff, error)
}

// Childrener is the optional "children" capability (session.children):
// subagent sessions spawned within a parent.
type Childrener interface {
	Children(ctx context.Context, workspaceDir, sessionID string) ([]Session, error)
}

// Reverter is the optional "revert" capability: roll a session back to just
// before messageID (that message and everything after it leave the
// transcript, and with RevertFiles the files they changed are restored), and
// undo the last such rollback while no new prompt has been sent.
type Reverter interface {
	Revert(ctx context.Context, workspaceDir, sessionID, messageID string) error
	Unrevert(ctx context.Context, workspaceDir, sessionID string) error
}

// EffortSetter is the optional "efforts" capability: remember a thinking
// effort for a session ("" for the model's default), used on every prompt.
type EffortSetter interface {
	SetEffort(ctx context.Context, workspaceDir, sessionID, effort string) (Session, error)
}

// Compactor is the optional "compact" capability: manual context
// compaction (opencode: POST /session/:id/summarize).
type Compactor interface {
	Compact(ctx context.Context, workspaceDir, sessionID string) error
}

// Asker is the optional "questions" capability (the user-question tool
// design): answering or dismissing a pending multi-question ask (opencode:
// POST /question/:id/reply|reject). answers is one slice per question, each
// the labels chosen for that question, in order — the same shape opencode's
// own reply body takes ("each answer is an array of selected labels").
type Asker interface {
	ReplyQuestion(ctx context.Context, workspaceDir, sessionID, requestID string, answers [][]string) error
	RejectQuestion(ctx context.Context, workspaceDir, sessionID, requestID string) error
}

// AttachmentSource is the optional "toolImages" capability: the bytes of an
// image a tool part listed, by the sha256 it listed. A backend that no longer
// holds them answers ErrAttachmentGone; a sha the session never produced is
// ErrAttachmentUnknown.
type AttachmentSource interface {
	Attachment(ctx context.Context, workspaceDir, sessionID, sha256 string) (mime string, data []byte, err error)
}

// ToolCall is one call of a galopin-installed tool (PROTOCOL.md §6 "Agent
// tools"), as the backend's tool shim relays it: the tool's name, the
// calling session and its call/message ids, and the model's raw arguments.
type ToolCall struct {
	Tool      string
	SessionID string
	CallID    string
	MessageID string
	Args      []byte
}

// ToolRefusal is a handler error the model should read as the tool's
// answer (a gate said no, the person declined): reported as a tool error
// with exactly this text. Any other handler error is an internal failure,
// reported generically.
type ToolRefusal struct{ Message string }

func (e *ToolRefusal) Error() string { return e.Message }

// ToolHandler answers a tool call; the text is the tool's result. It may
// block (an approval), and ctx is cancelled when the call is aborted.
type ToolHandler func(ctx context.Context, call ToolCall) (string, error)

// ToolHost is the optional "agentTools" capability: a backend that installed
// galopin's tools, relays their calls to a handler, and holds galopin's own
// approvals (never opencode's permission system).
type ToolHost interface {
	// SetToolHandler installs the handler; calls before it is set are refused.
	SetToolHandler(h ToolHandler)
	// Ask raises galopin's own permission request for a held tool call and
	// blocks until a person answers it through ReplyPermission (or ctx is
	// cancelled, which withdraws it). The request is never auto-accepted.
	Ask(ctx context.Context, workspaceDir, sessionID string, req PermissionRequest) (Decision, string, error)
	// SpawnMarks is every session_spawn marker the backend remembers, by
	// child session id (a copy).
	SpawnMarks() map[string]SpawnedBy
}
