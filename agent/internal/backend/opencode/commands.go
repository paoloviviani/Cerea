package opencode

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"galopin/internal/backend"
)

// The commands capability over opencode's HTTP API (PROTOCOL.md §6
// backend.commands / session.command): GET /command per directory lists
// what a workspace can run, POST /session/:id/command runs one. Two things
// this file owns beyond the plain mapping: the /doc probe that decides
// whether the capability exists at all (never a version string — rev1 §2),
// and the template scan, which reduces a template to the facts a person
// must see (shell snippets, file refs, a hash) and never carries the
// template itself anywhere.

// shellSnippetRe matches one !`…` expansion, however long — a pathological
// 500-character snippet must still count as shell (the commandShell gate
// reads that), with its displayed form truncated to the 200-char cap.
// Same shape as opencode's SHELL_REGEX (/!`([^`]+)`/g); the one-character
// minimum is enforced by requiring a non-empty capture below.
var shellSnippetRe = regexp.MustCompile("!`([^`]*)`")

// fileRefRe is opencode's FILE_REGEX (/(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g)
// minus the lookbehind Go cannot express: the caller drops matches whose
// preceding character is a word character or a backtick (see
// fileRefsIn). Trailing punctuation never survives the capture groups, so
// "@.env." resolves to ".env" the way opencode reads it — and an email
// address never matches at all.
var fileRefRe = regexp.MustCompile("@(\\.?[^\\s`,.]*(?:\\.[^\\s`,.]+)*)")

// argsTokenRe, quoteTrimRe and placeholderRe are opencode's argument
// machine, verbatim: how `session.command` splits the arguments string
// before substituting $1..$n and $ARGUMENTS into the template.
var argsTokenRe = regexp.MustCompile(`(?i)\[Image\s+[0-9]+\]|"[^"]*"|'[^']*'|[^\s"']+`)

var placeholderRe = regexp.MustCompile(`\$([0-9]+)`)

// maxShellSnippets caps how many snippets one command's scan keeps.
const maxShellSnippets = 10

// builtinCommands are opencode's own two commands, always listed: they are
// the implementation's, not any repo's.
var builtinCommands = map[string]bool{"init": true, "review": true}

// probeTimeout bounds the /doc probe and the state-directory listing.
const probeTimeout = 10 * time.Second

// ScanExpanded scans already-expanded command text (a template after
// opencode's argument substitution) for the gate facts: same shell and
// @path rules as the template scan, minus the display caps that only the
// reviewable listing needs (snippets are dropped here — the sheet shows
// the template's, never a run's arguments-adjacent text).
func ScanExpanded(expanded string) (shell bool, _ []string, fileRefs []string) {
	for _, m := range shellSnippetRe.FindAllStringSubmatch(expanded, -1) {
		if len(m) > 1 && m[1] != "" {
			shell = true
			break
		}
	}
	return shell, nil, fileRefsIn(expanded)
}

// scanTemplate reduces a template to what a person must see: whether it
// expands shell, the snippets (each ≤200 chars, at most 10), and the
// @path references.
func scanTemplate(template string) (shell bool, shellSnippets []string, fileRefs []string) {
	for _, m := range shellSnippetRe.FindAllStringSubmatch(template, maxShellSnippets) {
		if len(m) > 1 && m[1] != "" {
			snippet := m[1]
			if len(snippet) > 200 {
				snippet = snippet[:200]
			}
			shellSnippets = append(shellSnippets, snippet)
		}
	}
	shell = len(shellSnippets) > 0
	return shell, shellSnippets, fileRefsIn(template)
}

// fileRefsIn lists the @path references a text resolves, emulating
// opencode's negative lookbehind by hand: a match preceded by a word
// character or a backtick is not a reference (an email address, or text
// inside a shell snippet's own backticks).
func fileRefsIn(text string) []string {
	var refs []string
	for _, loc := range fileRefRe.FindAllStringSubmatchIndex(text, -1) {
		if len(loc) < 4 || loc[2] < 0 {
			continue
		}
		if loc[0] > 0 {
			prev := text[loc[0]-1]
			if prev == '_' || prev == '`' || isASCIILetterOrDigit(prev) {
				continue
			}
		}
		ref := text[loc[2]:loc[3]]
		if ref == "" {
			continue
		}
		refs = append(refs, ref)
	}
	return refs
}

func isASCIILetterOrDigit(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
}

// splitArgs mirrors opencode's argsRegex: [Image N] counts as one token,
// quoted strings keep their spaces, everything else splits on whitespace.
func splitArgs(arguments string) []string {
	raw := argsTokenRe.FindAllString(arguments, -1)
	out := make([]string, 0, len(raw))
	for _, token := range raw {
		out = append(out, trimOneQuote(token))
	}
	return out
}

// trimOneQuote mirrors opencode's quoteTrimRegex (/^["']|["']$/g): exactly
// one leading and one trailing quote character go, never the whole run.
func trimOneQuote(token string) string {
	if len(token) >= 2 {
		first, last := token[0], token[len(token)-1]
		if (first == '"' || first == '\'') && (last == '"' || last == '\'') {
			return token[1 : len(token)-1]
		}
		if first == '"' || first == '\'' {
			return token[1:]
		}
		if last == '"' || last == '\'' {
			return token[:len(token)-1]
		}
	} else if len(token) == 1 && (token[0] == '"' || token[0] == '\'') {
		return ""
	}
	return token
}

// ExpandArguments reproduces opencode's session.command substitution
// machine-side (SessionPrompt.command): $N placeholders take the Nth
// argument (the highest-numbered one swallowing the rest), $ARGUMENTS
// takes the whole string, and with neither present a non-blank argument
// string is appended. The gates scan the RESULT — opencode detects shell
// and resolves @files on the combined text, so scanning the bare template
// would miss a snippet or a ref smuggled in through the arguments.
func ExpandArguments(template, arguments string) string {
	args := splitArgs(arguments)
	matches := placeholderRe.FindAllStringSubmatch(template, -1)
	last := 0
	for _, m := range matches {
		var position int
		fmt.Sscanf(m[1], "%d", &position)
		if position > last {
			last = position
		}
	}
	withArgs := placeholderRe.ReplaceAllStringFunc(template, func(match string) string {
		var position int
		fmt.Sscanf(match[1:], "%d", &position)
		argIndex := position - 1
		if argIndex < 0 || argIndex >= len(args) {
			return ""
		}
		if position == last {
			return strings.Join(args[argIndex:], " ")
		}
		return args[argIndex]
	})
	expanded := strings.ReplaceAll(withArgs, "$ARGUMENTS", arguments)
	if len(matches) == 0 && !strings.Contains(template, "$ARGUMENTS") && strings.TrimSpace(arguments) != "" {
		expanded = expanded + "\n\n" + arguments
	}
	return expanded
}

// commandFromRaw maps one GET /command entry plus its own template scan
// into the wire shape. The template itself is used here on the machine and
// never leaves it.
func commandFromRaw(raw map[string]any) backend.Command {
	cmd := backend.Command{
		Name:        getStr(raw, "name"),
		Description: getStr(raw, "description"),
		Source:      backend.Source(getStr(raw, "source", "source_")),
		Hints:       asStrings(getSlice(raw, "hints")),
		Agent:       getStr(raw, "agent"),
		Model:       getStr(raw, "model"),
		Subtask:     getBool(raw, "subtask"),
	}
	if cmd.Source == "" {
		cmd.Source = backend.SourceCommand
	}
	if cmd.Source == backend.SourceMCP {
		// An MCP prompt's text is fetched from the server at run time, so
		// whether it expands shell is unknown until the IT says otherwise
		// (rev1 §3.2). Unknown shell is refused under a denied policy.
		cmd.Shell = nil
		return cmd
	}
	template := getStr(raw, "template")
	if template == "" {
		// No template exposed to scan: shell is unknown, and without one
		// there is no hash a confirmation could pin.
		cmd.Shell = nil
		return cmd
	}
	shell, snippets, refs := scanTemplate(template)
	cmd.Shell = &shell
	cmd.ShellSnippets = snippets
	cmd.FileRefs = refs
	sum := sha256.Sum256([]byte(template))
	cmd.TemplateHash = hex.EncodeToString(sum[:])
	return cmd
}

// listedCommand is one GET /command entry with its template alongside:
// the scan's display facts ride the Command, but the dispatch's gates need
// the expanded text, and only the template plus the arguments produce it.
type listedCommand struct {
	cmd      backend.Command
	template string
}

// listRawCommands answers one directory's command list, scanned, templates
// alongside.
func (b *Backend) listRawCommands(ctx context.Context, directory string) ([]listedCommand, error) {
	var raw []any
	if err := b.doJSON(ctx, http.MethodGet, "/command"+directoryQuery(directory), nil, &raw); err != nil {
		return nil, err
	}
	out := make([]listedCommand, 0, len(raw))
	for _, entry := range asMaps(raw) {
		cmd := commandFromRaw(entry)
		if cmd.Name == "" {
			continue
		}
		out = append(out, listedCommand{cmd: cmd, template: getStr(entry, "template")})
	}
	return out, nil
}

// stateCommands lists galopin's own state directory once per process: the
// baseline the workspace listing's origins are proven against. A name is
// only ever machine or builtin here when the state entry says the same
// thing the workspace entry says (hash for machine scope, metadata for the
// two builtins whose templates interpolate the worktree path); anything
// else is the repo's, whatever name it borrowed.
func (b *Backend) stateCommands(ctx context.Context) map[string]backend.Command {
	b.stateCmdMu.Lock()
	defer b.stateCmdMu.Unlock()
	if b.stateCmdBaseline != nil {
		return b.stateCmdBaseline
	}
	b.stateCmdBaseline = map[string]backend.Command{}
	if b.cfg.StateDir == "" {
		return b.stateCmdBaseline
	}
	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	listed, err := b.listRawCommands(probeCtx, b.cfg.StateDir)
	if err != nil {
		b.cfg.Logf("opencode: listing the state directory's commands: %v", err)
		return b.stateCmdBaseline
	}
	for _, entry := range listed {
		b.stateCmdBaseline[entry.cmd.Name] = entry.cmd
	}
	return b.stateCmdBaseline
}

// builtinMetadataEqual says whether a workspace entry is opencode's own
// builtin rather than a repo file borrowing the name: description, agent,
// model, subtask, source and hints must all match the state baseline's.
// The template hash is deliberately excluded — init's template interpolates
// the worktree path, so byte-identical builtins hash differently per
// directory. Residual, documented in PROTOCOL.md §6: a body-modified copy
// with byte-identical frontmatter mislabels as builtin (but its shell
// snippets still gate, because those are scanned from the actual text).
func builtinMetadataEqual(state, workspace backend.Command) bool {
	return state.Description == workspace.Description &&
		state.Agent == workspace.Agent &&
		state.Model == workspace.Model &&
		state.Subtask == workspace.Subtask &&
		state.Source == workspace.Source &&
		strings.Join(state.Hints, "\x00") == strings.Join(workspace.Hints, "\x00")
}

// commandsSupported reports whether the opencode server's own GET /doc
// lists the session.command operation — the /doc probe the capability is
// advertised from, cached per process generation and re-probed after a
// supervised restart. A probe that fails answers false: a server that
// cannot describe itself does not get the capability claimed for it.
func (b *Backend) commandsSupported() bool {
	b.commandsMu.Lock()
	defer b.commandsMu.Unlock()
	if b.commandsGen == b.backendGen && b.commandsPtr != nil {
		return *b.commandsPtr
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	var doc map[string]any
	if err := b.doJSON(ctx, http.MethodGet, "/doc", nil, &doc); err != nil {
		b.cfg.Logf("opencode: probing GET /doc for session.command: %v", err)
		supported := false
		b.commandsPtr = &supported
		b.commandsGen = b.backendGen
		return false
	}
	supported := docListsSessionCommand(doc)
	b.commandsPtr = &supported
	b.commandsGen = b.backendGen
	return supported
}

// docListsSessionCommand walks GET /doc's paths looking for any operation
// whose operationId is session.command — shape-tolerant on purpose, so a
// path rename between versions does not silently drop the capability.
func docListsSessionCommand(doc map[string]any) bool {
	paths, _ := doc["paths"].(map[string]any)
	for _, pathItem := range paths {
		methods, ok := pathItem.(map[string]any)
		if !ok {
			continue
		}
		for _, method := range methods {
			operation, ok := method.(map[string]any)
			if !ok {
				continue
			}
			if getStr(operation, "operationId") == "session.command" {
				return true
			}
		}
	}
	return false
}

// ListCommands implements backend.Commander for opencode: the workspace's
// list diffed against the state directory's (cached per process) to derive
// each command's origin. sessionID is unused — opencode's list is
// per-directory, not per-session.
// assignOrigin proves a listed entry's origin against the state baseline:
// builtin only when every field but the (worktree-interpolated) template
// matches, machine scope only on a template-hash match, the repo's
// otherwise — whatever name the repo borrowed.
func assignOrigin(cmd *backend.Command, baseline map[string]backend.Command) {
	base, ok := baseline[cmd.Name]
	switch {
	case builtinCommands[cmd.Name]:
		if ok && builtinMetadataEqual(base, *cmd) {
			cmd.Origin = backend.OriginBuiltin
		} else {
			cmd.Origin = backend.OriginProject
		}
	case cmd.Source == backend.SourceMCP || cmd.Source == backend.SourceSkill:
		cmd.Origin = backend.OriginMachine
	default:
		if ok && base.TemplateHash != "" && base.TemplateHash == cmd.TemplateHash {
			cmd.Origin = backend.OriginMachine
		} else {
			cmd.Origin = backend.OriginProject
		}
	}
}

func (b *Backend) ListCommands(ctx context.Context, workspaceDir, _ string) ([]backend.Command, error) {
	listed, err := b.listRawCommands(ctx, workspaceDir)
	if err != nil {
		return nil, err
	}
	state := b.stateCommands(ctx)
	out := make([]backend.Command, 0, len(listed))
	for _, entry := range listed {
		cmd := entry.cmd
		assignOrigin(&cmd, state)
		out = append(out, cmd)
	}
	return out, nil
}

// ResolveCommand answers the run path's question — the listed command plus
// its template expanded with opencode's own argument substitution — in one
// listing, so the run and the gates read the same text. Unknown names
// answer errCommandNotFound; the dispatch maps it to not_found.
func (b *Backend) ResolveCommand(ctx context.Context, workspaceDir, _ string, name, arguments string) (backend.ResolvedCommand, error) {
	listed, err := b.listRawCommands(ctx, workspaceDir)
	if err != nil {
		return backend.ResolvedCommand{}, err
	}
	state := b.stateCommands(ctx)
	for _, entry := range listed {
		if entry.cmd.Name != name {
			continue
		}
		cmd := entry.cmd
		assignOrigin(&cmd, state)
		return backend.ResolvedCommand{Command: cmd, Expanded: ExpandArguments(entry.template, arguments)}, nil
	}
	return backend.ResolvedCommand{}, backend.ErrCommandNotFound
}

// RunCommand implements backend.Commander's run half: the exact
// client-message mapping and the transcript marker are recorded BEFORE the
// POST, which then runs in a goroutine on the long-lived client — the call
// blocks for the whole turn, and the fast CRUD client's deadline would cut
// it off. This method returns once the run is accepted; a late failure
// becomes an error event on the session.
func (b *Backend) RunCommand(ctx context.Context, workspaceDir, sessionID string, run backend.CommandRun) error {
	messageID := mintMessageID()
	if run.ClientMessageID != "" {
		b.recordExactClientMessageID(messageID, run.ClientMessageID)
		b.claimPendingClientMessageID(sessionID, messageID, run.ClientMessageID)
	}
	b.recordCommandMarker(messageID, run.Name, run.Arguments)

	// The turn outlives this request: it runs on the process's own context,
	// not the caller's (an op reply must not cancel a running command).
	// No lifecycle yet (tests drive the backend against a fake server
	// without Start) falls back to Background — the same shape every other
	// method's context handling takes.
	lifecycle, ok := b.lifecycleContext()
	if !ok {
		lifecycle = context.Background()
	}
	go func() {
		if err := b.postCommand(lifecycle, workspaceDir, sessionID, run, messageID); err != nil {
			message := fmt.Sprintf("The command %q failed: %v", run.Name, err)
			// opencode's error body rides in here, unbounded (up to the
			// 4MB response cap): keep the event to a readable head.
			if len(message) > 1024 {
				message = message[:1024] + "…"
			}
			b.emitInjected(workspaceDir, sessionID, backend.Event{
				Kind:         backend.EventError,
				ErrorMessage: message,
			})
		}
	}()
	return nil
}

// postCommand is the blocking half of session.command: one long call that
// answers only after the whole turn has run (the 2026-09-26 plan §1.2).
func (b *Backend) postCommand(ctx context.Context, workspaceDir, sessionID string, run backend.CommandRun, messageID string) error {
	body := map[string]any{
		"command":   run.Name,
		"arguments": run.Arguments,
		"messageID": messageID,
	}
	if run.Agent != "" {
		body["agent"] = run.Agent
	}
	ov := b.getOverlay(sessionID)
	if ov.ModelID != "" {
		// session.command takes the model as one "provider/model" string,
		// unlike prompt_async's object (plan §1.2).
		body["model"] = ov.ModelID
	}
	if ov.Effort != "" {
		body["variant"] = ov.Effort
	}
	if len(run.Attachments) > 0 {
		parts := make([]map[string]any, 0, len(run.Attachments))
		for _, a := range run.Attachments {
			parts = append(parts, map[string]any{
				"type": "file", "mime": a.Mime, "filename": a.Filename, "url": a.URL,
			})
		}
		body["parts"] = parts
	}

	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		b.baseURL()+"/session/"+url.PathEscape(sessionID)+"/command"+directoryQuery(workspaceDir), bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.SetBasicAuth("opencode", b.cfg.Password)

	resp, err := b.longClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("status %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

// emitInjected pushes a backend-generated event into the Subscribe stream —
// the only way a late command failure can reach the transcript, since the
// normalized event stream is otherwise a pure SSE pump. Dropped silently
// when nobody subscribed.
func (b *Backend) emitInjected(workspaceDir, sessionID string, ev backend.Event) {
	b.injectMu.Lock()
	ch := b.injectCh
	b.injectMu.Unlock()
	if ch == nil {
		return
	}
	select {
	case ch <- backend.BackendEvent{WorkspaceDir: workspaceDir, SessionID: sessionID, Event: ev}:
	default:
	}
}
