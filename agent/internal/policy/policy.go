// Package policy holds the machine's own veto (PROTOCOL.md §4 "C4"): a
// policy.json set once by `enroll` flags, loaded by `run`, and never
// writable over the link. Cerea can ask for what the policy allows; it can
// never change the policy itself.
package policy

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"galopin/internal/fsutil"
	"galopin/internal/permrules"
)

// Policy is the whole file (PROTOCOL.md §5). Defaults are all the safe
// answer: no responder, no workspace outside what's explicitly listed once
// any root is configured, no models beyond the gateway's own.
//
// A policy.json written before the permission pass-through may still carry
// `autoAccept`: it is ignored on load and dropped on save. Auto-accept is no
// longer a machine rule; Permission.Responders is the only machine-side word
// about it, and nothing is translated from the old one.
type Policy struct {
	// Permission is the machine's say over opencode's permission system.
	Permission      Permission `json:"permission"`
	WorkspaceRoots  []string   `json:"workspaceRoots"`
	AllowFreeModels bool       `json:"allowFreeModels"`
	// Files is the /code explorer's read access to workspace files: "read"
	// (the default, confined and redacted) or "off" (`enroll --no-files`).
	Files string `json:"files,omitempty"`
	// FileDeny adds globs to the default secret deny list (`--file-deny`).
	FileDeny []string `json:"fileDeny,omitempty"`
	// NoDefaultFileDeny drops the default deny list (`--no-default-file-deny`),
	// leaving only FileDeny.
	NoDefaultFileDeny bool `json:"noDefaultFileDeny,omitempty"`
	// Terminal gates every terminal.* op: "allowed" or "denied" (the
	// default; `enroll --allow-terminal` opens it). ADR 0090: a terminal is
	// a remote shell with no model and no permission rules in the way, so
	// it stays off unless the owner explicitly opts in.
	Terminal string `json:"terminal,omitempty"`
	// MaxTerminals caps concurrently open terminals per machine (default 8).
	// terminal.open beyond it answers invalid.
	MaxTerminals int `json:"maxTerminals,omitempty"`
	// CommandShell gates the shell expansion a slash command's template can
	// do (PROTOCOL.md §6 session.command): "allowed" or "denied" (the
	// default; `enroll --allow-command-shell` opens it). While denied,
	// session.command refuses a command whose template expands shell AND
	// every command whose shell is unknown (an MCP prompt, an ACP command)
	// — the expansion runs outside every permission rule, so it is off
	// until an owner explicitly opts in. A local `galopin policy set` can
	// only turn it off.
	CommandShell string `json:"commandShell,omitempty"`
	// AgentTools gates galopin's own agent-coordination tools
	// (session_list/session_spawn/session_send, PROTOCOL.md §6 "Agent
	// tools"): "allowed" (the default) or "denied" (`enroll --no-agent-tools`,
	// `policy set --no-agent-tools`). Allowed adds nothing without a
	// per-call approval that auto-accept cannot reach, so it is on by
	// default; denied installs no tool at all. A local `galopin policy set`
	// can only turn it off.
	AgentTools string `json:"agentTools,omitempty"`
	// ProjectConfig gates the opencode configuration a workspace's own repo
	// carries (opencode.json, .opencode/ plugins, tools, commands, agents
	// and MCP servers, AGENTS.md/CLAUDE.md): "allowed" or "denied" (the
	// default; `enroll --allow-project-config` opens it). A cloned repo is
	// untrusted input: its config can point the gateway provider at another
	// endpoint, and its plugins are code that runs as the user. While denied
	// galopin starts opencode with OPENCODE_DISABLE_PROJECT_CONFIG=1. A
	// local `galopin policy set` can only turn it off.
	ProjectConfig string `json:"projectConfig,omitempty"`
	// BackgroundSubagents gates opencode's background task tool
	// (OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS): "allowed" or "denied"
	// (the default; `enroll --allow-background-subagents` opens it). While
	// denied galopin never sets the env flag, so a task with background:true
	// fails closed inside opencode ("Background subagents require
	// OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"). A local
	// `galopin policy set` can only turn it off.
	BackgroundSubagents string `json:"backgroundSubagents,omitempty"`
}

// Permission is what the machine decides about opencode's permissions
// (PROTOCOL.md §6 "Permissions"). Nothing in it is writable over the link.
type Permission struct {
	// Rules are galopin's own rules for every session on the machine, key →
	// "allow" | "ask" | "deny" (pattern "*"). They are applied as session
	// rules, which sit above opencode's static config file, so they win over
	// whatever an installer wrote there; the Max ceiling then caps them.
	Rules map[string]string `json:"rules,omitempty"`
	// Max is the ceiling: the most a key may ever be, whatever any rule or
	// any "always" says. A key absent from Max is not capped. `enroll`
	// defaults bash to "ask"; `galopin policy set` may only lower a value.
	Max map[string]string `json:"max,omitempty"`
	// Responders says whether a session may be put in auto-accept at all
	// ("allowed" | "denied", default denied): the owner's consent to a
	// client-side responder answering asks with "once". It was
	// Policy.autoAccept, and `enroll --allow-auto-accept` still sets it.
	Responders string `json:"responders,omitempty"`
}

// RespondersAllowed reports whether auto-accept may be switched on.
func (p Permission) RespondersAllowed() bool { return p.Responders == TerminalAllowed }

// Ceiling is Max as the rule package's type.
func (p Permission) Ceiling() permrules.Ceiling {
	c := permrules.Ceiling{Max: map[string]permrules.Action{}}
	for k, v := range p.Max {
		c.Max[k] = permrules.Action(v)
	}
	return c
}

// OwnRules is Rules as the rule package's type, sorted.
func (p Permission) OwnRules() []permrules.Rule {
	m := map[string]permrules.Action{}
	for k, v := range p.Rules {
		m[k] = permrules.Action(v)
	}
	return permrules.OwnRules(m)
}

// Validate refuses a value that would silently mean something else: an action
// word that is not one of the three (a typo in a ceiling must not uncap), or a
// pattern where a key is expected.
func (p Permission) Validate() error {
	check := func(field string, m map[string]string) error {
		for k, v := range m {
			if k == "" || permrules.IsWildcard(k) {
				return fmt.Errorf("permission.%s: %q is not a permission key (a literal name such as \"bash\")", field, k)
			}
			if !permrules.Action(v).Valid() {
				return fmt.Errorf("permission.%s.%s: %q is not allow, ask or deny", field, k, v)
			}
		}
		return nil
	}
	if err := check("rules", p.Rules); err != nil {
		return err
	}
	if err := check("max", p.Max); err != nil {
		return err
	}
	switch p.Responders {
	case "", TerminalAllowed, TerminalDenied:
		return nil
	}
	return fmt.Errorf("permission.responders: %q is not allowed or denied", p.Responders)
}

// FilesRead and FilesOff are Policy.Files's two values.
const (
	FilesRead = "read"
	FilesOff  = "off"
)

// TerminalAllowed and TerminalDenied are Policy.Terminal's two values.
const (
	TerminalAllowed = "allowed"
	TerminalDenied  = "denied"
)

// DefaultMaxTerminals is Policy.MaxTerminals's value when unset (PROTOCOL.md §4/§9.3).
const DefaultMaxTerminals = 8

// DefaultFileDeny is the secret deny list (PROTOCOL.md §9.4). A "!" entry
// exempts what the entries before it matched. It is not a boundary against
// the agent or a terminal; it keeps secrets off screens and out of logs.
var DefaultFileDeny = []string{
	".env", ".env.*", "!.env.example", "!.env.sample", "!.env.template", ".envrc",
	"*.pem", "*.key", "*.p12", "*.pfx", "*.kdbx",
	"id_rsa*", "id_ecdsa*", "id_ed25519*",
	".netrc", ".npmrc", ".pypirc", ".git-credentials",
	".aws/credentials", ".docker/config.json", "*.tfstate", "secrets.y*ml",
}

// FilesAllowed reports whether the explorer may read this machine's
// workspace files at all.
func (p Policy) FilesAllowed() bool { return p.Files != FilesOff }

// TerminalAllowed reports whether this machine permits terminal.* ops at
// all. Default denied: an owner opts in with `enroll --allow-terminal`.
func (p Policy) TerminalAllowed() bool { return p.Terminal == TerminalAllowed }

// CommandShellAllowed reports whether this machine permits a command's
// template to expand shell. Default denied: an owner opts in with
// `enroll --allow-command-shell`.
func (p Policy) CommandShellAllowed() bool { return p.CommandShell == TerminalAllowed }

// AgentToolsAllowed reports whether galopin installs its agent-coordination
// tools. Default allowed: an owner opts out with `enroll --no-agent-tools`.
func (p Policy) AgentToolsAllowed() bool { return p.AgentTools != TerminalDenied }

// ProjectConfigAllowed reports whether opencode loads a workspace's own
// config. Default denied: an owner opts in with `enroll --allow-project-config`.
func (p Policy) ProjectConfigAllowed() bool { return p.ProjectConfig == TerminalAllowed }

// BackgroundSubagentsAllowed reports whether opencode may run background
// subagents (task background:true). Default denied: an owner opts in with
// `enroll --allow-background-subagents`.
func (p Policy) BackgroundSubagentsAllowed() bool {
	return p.BackgroundSubagents == TerminalAllowed
}

// EffectiveMaxTerminals is p.MaxTerminals, or DefaultMaxTerminals when unset.
func (p Policy) EffectiveMaxTerminals() int {
	if p.MaxTerminals <= 0 {
		return DefaultMaxTerminals
	}
	return p.MaxTerminals
}

// EffectiveFileDeny is the deny list in force: the defaults (unless
// dropped), then the owner's own additions.
func (p Policy) EffectiveFileDeny() []string {
	var out []string
	if !p.NoDefaultFileDeny {
		out = append(out, DefaultFileDeny...)
	}
	return append(out, p.FileDeny...)
}

// GatewayProviderID is the provider id `enroll` writes into opencode.json
// (store.go's buildOpencodeConfig). When AllowFreeModels is false, this is
// the only provider whose models are ever listed or accepted — see
// FilterModelIDs.
const GatewayProviderID = "pystino"

// Default is what a machine with no policy.json at all gets: everything
// closed. `enroll`'s flags are what opens any of it.
func Default() Policy {
	return Policy{
		Permission:          Permission{Responders: TerminalDenied},
		AllowFreeModels:     false,
		Files:               FilesRead,
		Terminal:            TerminalDenied,
		CommandShell:        TerminalDenied,
		AgentTools:          TerminalAllowed,
		ProjectConfig:       TerminalDenied,
		BackgroundSubagents: TerminalDenied,
	}
}

// Load reads policy.json, or returns Default() when the file does not
// exist — a machine that has never run `enroll` with any policy flag has
// the safe defaults, not a missing-file error.
func Load(path string) (Policy, error) {
	body, err := fsutil.ReadFileOrEmpty(path)
	if err != nil {
		return Policy{}, err
	}
	if body == nil {
		return Default(), nil
	}
	var p Policy
	if err := json.Unmarshal(body, &p); err != nil {
		return Policy{}, fmt.Errorf("parsing %s: %w", path, err)
	}
	if err := p.Permission.Validate(); err != nil {
		return Policy{}, fmt.Errorf("%s: %w", path, err)
	}
	if p.Permission.Responders == "" {
		p.Permission.Responders = TerminalDenied
	}
	if p.Files == "" {
		p.Files = FilesRead
	}
	if p.Terminal == "" {
		p.Terminal = TerminalDenied
	}
	if p.CommandShell == "" {
		p.CommandShell = TerminalDenied
	}
	if p.AgentTools == "" {
		p.AgentTools = TerminalAllowed
	}
	if p.ProjectConfig == "" {
		p.ProjectConfig = TerminalDenied
	}
	if p.BackgroundSubagents == "" {
		p.BackgroundSubagents = TerminalDenied
	}
	return p, nil
}

// Save persists policy.json atomically at 0600 (R8, via fsutil).
func Save(path string, p Policy) error {
	body, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	return fsutil.WriteFileAtomic(path, append(body, '\n'), 0o600)
}

// AllowsWorkspace reports whether path is permitted by p.WorkspaceRoots. No
// roots configured means unrestricted (the enroll-time default: an operator
// who never passed --workspace-root hasn't opted into confinement).
func (p Policy) AllowsWorkspace(path string) (bool, error) {
	return Allowed(p.WorkspaceRoots, path)
}

// Allowed is the pure, testable check behind AllowsWorkspace: path is
// permitted when roots is empty, or when path resolves (Clean +
// EvalSymlinks) to one of roots or a descendant of one. Resolving both
// sides defeats a workspace path that is a symlink pointing outside every
// configured root — a bare prefix check on the unresolved strings would
// miss that.
func Allowed(roots []string, path string) (bool, error) {
	if len(roots) == 0 {
		return true, nil
	}
	resolved, err := ResolvePath(path)
	if err != nil {
		return false, err
	}
	for _, root := range roots {
		resolvedRoot, err := ResolvePath(root)
		if err != nil {
			// An unreadable or since-deleted root can't match anything; it
			// simply contributes no permission, rather than failing every
			// check that happens to run after it.
			continue
		}
		if resolved == resolvedRoot || strings.HasPrefix(resolved, resolvedRoot+string(filepath.Separator)) {
			return true, nil
		}
	}
	return false, nil
}

// ResolvePath makes path absolute, cleans it, and resolves symlinks — the
// canonical form every workspace-root comparison in this package is done
// against.
func ResolvePath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolving %s: %w", path, err)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("resolving %s: %w", path, err)
	}
	return filepath.Clean(resolved), nil
}

// FilterModelIDs applies AllowFreeModels to a list of "<providerId>/<model>"
// ids: unrestricted when true, else only ids under GatewayProviderID.
// Kept provider-agnostic (ids, not backend.Model) so this package never
// needs to import internal/backend.
func (p Policy) FilterModelIDs(ids []string) []string {
	if p.AllowFreeModels {
		return ids
	}
	prefix := GatewayProviderID + "/"
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if strings.HasPrefix(id, prefix) {
			out = append(out, id)
		}
	}
	return out
}
