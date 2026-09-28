package backend

import "context"

// The commands capability (PROTOCOL.md §6 backend.commands / session.command):
// a backend that can list a workspace's slash commands and run one in a
// session. opencode implements both over its own HTTP API; ACP maps them
// onto available_commands_update and an ordinary prompt.

// Source is where a command's definition lives, as the backend reports it
// (opencode's own vocabulary; ACP's available_commands_update carries none
// and answers "command").
type Source string

const (
	SourceCommand Source = "command"
	SourceMCP     Source = "mcp"
	SourceSkill   Source = "skill"
)

// Origin is who owns the command in deployment terms, derived by the
// backend: "builtin" (opencode's own init/review), "project" (defined in
// this workspace's repo — code the person may never have reviewed),
// "machine" (user-level or config-defined), or "" when the backend cannot
// say (ACP carries no scope).
type Origin string

const (
	OriginBuiltin Origin = "builtin"
	OriginMachine Origin = "machine"
	OriginProject Origin = "project"
)

// Command is one listed slash command (PROTOCOL.md §6 backend.commands).
// A command has a prompt's power once run; the fields here exist so the
// panel can show what a run would do WITHOUT ever carrying the template
// itself — the shell snippets and file refs are what a person must see,
// and the template text never leaves the machine.
type Command struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Source      Source   `json:"source"`
	Origin      Origin   `json:"origin,omitempty"`
	Hints       []string `json:"hints"`
	// Agent is the command's own `agent:` frontmatter, empty when unset —
	// what the agent-escalation gate reads (PROTOCOL.md §6 session.command).
	Agent string `json:"agent,omitempty"`
	// Model is the command's own `model:` frontmatter, "provider/model"
	// shaped, empty when unset — the free-model gate reads it.
	Model string `json:"model,omitempty"`
	// Subtask marks a command that spawns its own child session (opencode's
	// `review`): with a named agent under a more restrictive overlay mode it
	// is refused outright rather than overridden.
	Subtask bool `json:"subtask,omitempty"`
	// Shell: true when the template expands a `` !`…` `` shell snippet, false
	// when it provably does not, nil when unknown (an MCP prompt, an ACP
	// command — nothing exposed a template to scan). The commandShell policy
	// refuses nil and true alike while denied.
	Shell *bool `json:"shell"`
	// ShellSnippets are the `` !`…` `` expansions the template would run,
	// each at most 200 characters, at most 10 — what a confirmation sheet
	// shows a person before the first run. Empty when Shell is not true.
	ShellSnippets []string `json:"shellSnippets,omitempty"`
	// FileRefs are the `@path` references the template expands in — checked
	// against the machine's fileDeny list before anything runs.
	FileRefs []string `json:"fileRefs,omitempty"`
	// TemplateHash is sha256 of the template, when the backend could read
	// one: the panel's first-run confirmation carries it back, and a run
	// whose hash no longer matches answers conflict.
	TemplateHash string `json:"templateHash,omitempty"`
}

// CommandRun is session.command's payload (PROTOCOL.md §6), what the
// dispatcher hands the backend after the gates pass.
type CommandRun struct {
	Name string
	// Arguments is the raw argument string; the backend sends it verbatim.
	Arguments string
	// ClientMessageID, when set, is recorded against the message the
	// command produces — the exact mapping the prompt path mints.
	ClientMessageID string
	Attachments     []Attachment
	// TemplateHash is the hash the run was confirmed against, when the
	// panel confirmed one; the backend (or dispatcher) answers conflict when
	// the command's template has changed since.
	TemplateHash string
	// Agent is the effective agent to send with the run: the command's own
	// `agent:` frontmatter, or the session's overlay mode when that is more
	// restrictive (the escalation gate's outcome). Empty sends none.
	Agent string
}

// MessageCommand is the transcript marker on the user message a command
// produced (PROTOCOL.md §7): the panel renders "/name args" as the bubble
// and folds the expanded template into a collapsed disclosure. Never
// carries the expanded text.
type MessageCommand struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// Commander is the optional "commands" capability: list a workspace's
// commands and run one in a session. RunCommand returns once the run is
// accepted — the turn itself streams as events, and a failure after
// acceptance arrives as an error event on the session.
type Commander interface {
	ListCommands(ctx context.Context, workspaceDir, sessionID string) ([]Command, error)
	RunCommand(ctx context.Context, workspaceDir, sessionID string, run CommandRun) error
}

// ResolvedCommand is the run path's answer: the listed command plus its
// template expanded with opencode's own argument substitution, in one
// listing — so the run and the gates read the same text.
type ResolvedCommand struct {
	Command  Command
	Expanded string
}

// CommanderResolver is the optional half of Commander backends whose
// commands carry server-side templates (opencode): resolving the expanded
// text machine-side, which the gates then scan. Backends without it (ACP
// has no template to expand) are gated from the listing alone.
type CommanderResolver interface {
	Commander
	ResolveCommand(ctx context.Context, workspaceDir, sessionID, name, arguments string) (ResolvedCommand, error)
}
