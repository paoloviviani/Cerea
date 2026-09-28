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
var shellSnippetRe = regexp.MustCompile("!`([^`]*)`")

// fileRefRe matches one `@path` reference.
var fileRefRe = regexp.MustCompile("@([^\\s`]+)")

// maxShellSnippets caps how many snippets one command's scan keeps.
const maxShellSnippets = 10

// builtinCommands are opencode's own two commands, always listed: they are
// the implementation's, not any repo's.
var builtinCommands = map[string]bool{"init": true, "review": true}

// probeTimeout bounds the /doc probe and the state-directory listing.
const probeTimeout = 10 * time.Second

// scanTemplate reduces a template to what a person must see: whether it
// expands shell, the snippets (each ≤200 chars, at most 10), and the
// @path references.
func scanTemplate(template string) (shell bool, shellSnippets []string, fileRefs []string) {
	for _, m := range shellSnippetRe.FindAllStringSubmatch(template, maxShellSnippets) {
		if len(m) > 1 {
			snippet := m[1]
			if len(snippet) > 200 {
				snippet = snippet[:200]
			}
			shellSnippets = append(shellSnippets, snippet)
		}
	}
	shell = len(shellSnippets) > 0
	for _, m := range fileRefRe.FindAllStringSubmatch(template, -1) {
		if len(m) > 1 {
			fileRefs = append(fileRefs, m[1])
		}
	}
	return shell, shellSnippets, fileRefs
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

// listRawCommands answers one directory's command list, scanned.
func (b *Backend) listRawCommands(ctx context.Context, directory string) ([]backend.Command, error) {
	var raw []any
	if err := b.doJSON(ctx, http.MethodGet, "/command"+directoryQuery(directory), nil, &raw); err != nil {
		return nil, err
	}
	out := make([]backend.Command, 0, len(raw))
	for _, entry := range asMaps(raw) {
		cmd := commandFromRaw(entry)
		if cmd.Name == "" {
			continue
		}
		out = append(out, cmd)
	}
	return out, nil
}

// stateCommands lists galopin's own state directory once per process: the
// baseline the workspace listing is diffed against. A name present for the
// workspace but absent here comes from the repo (origin "project"); a
// failed listing contributes nothing and every non-builtin command reads
// as "machine" — underlabelling, never a scare someone wasn't owed.
func (b *Backend) stateCommands(ctx context.Context) map[string]bool {
	b.stateCmdMu.Lock()
	defer b.stateCmdMu.Unlock()
	if b.stateCmdNames != nil {
		return b.stateCmdNames
	}
	b.stateCmdNames = map[string]bool{}
	if b.cfg.StateDir == "" {
		return b.stateCmdNames
	}
	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	listed, err := b.listRawCommands(probeCtx, b.cfg.StateDir)
	if err != nil {
		b.cfg.Logf("opencode: listing the state directory's commands: %v", err)
		return b.stateCmdNames
	}
	for _, cmd := range listed {
		b.stateCmdNames[cmd.Name] = true
	}
	return b.stateCmdNames
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
func (b *Backend) ListCommands(ctx context.Context, workspaceDir, _ string) ([]backend.Command, error) {
	listed, err := b.listRawCommands(ctx, workspaceDir)
	if err != nil {
		return nil, err
	}
	state := b.stateCommands(ctx)
	for i := range listed {
		switch {
		case builtinCommands[listed[i].Name]:
			listed[i].Origin = backend.OriginBuiltin
		case listed[i].Source == backend.SourceMCP || listed[i].Source == backend.SourceSkill:
			listed[i].Origin = backend.OriginMachine
		case !state[listed[i].Name]:
			listed[i].Origin = backend.OriginProject
		default:
			listed[i].Origin = backend.OriginMachine
		}
	}
	return listed, nil
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
			b.emitInjected(workspaceDir, sessionID, backend.Event{
				Kind:         backend.EventError,
				ErrorMessage: fmt.Sprintf("The command %q failed: %v", run.Name, err),
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
