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

// jsSpace is JavaScript's \s spelled out for RE2 char classes — Go's \s
// is [\t\n\f\r ] only, so a class that says \s stops where JS wouldn't:
// "@.env<NBSP>x" must end the reference at ".env" the way opencode's own
// FILE_REGEX does, or the scan captures one token and misses the
// deny-listed file inside it. \v has no RE2 escape, hence \x{0b}.
const jsSpace = `\t\n\x{0b}\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// fileRefRe is opencode's FILE_REGEX (/(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g)
// minus the lookbehind Go cannot express: the caller drops matches whose
// preceding character is a word character or a backtick (see
// fileRefsIn), and \s is spelled out as JS's set (see jsSpace). Trailing
// punctuation never survives the capture groups, so "@.env." resolves to
// ".env" the way opencode reads it — and an email address never matches
// at all.
var fileRefRe = regexp.MustCompile("@(\\.?[^" + jsSpace + "`,.]*(?:\\.[^" + jsSpace + "`,.]+)*)")

// placeholderRe is opencode's placeholderRegex (/\$(\d+)/g), verbatim —
// $0 included, which is where JavaScript's slice(-1)/"undefined" behaviour
// lives.
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
// character or a backtick is rejected — and the scan RESUMES one character
// after the rejected match's START (JavaScript's engine retries at the
// next position, so a later @ inside the rejected span is still a
// reference: "a@:@.env" resolves ".env" for opencode and must for the
// gate, or a repo template hides a deny-listed file behind a decoy).
func fileRefsIn(text string) []string {
	var refs []string
	pos := 0
	for pos <= len(text) {
		loc := fileRefRe.FindStringSubmatchIndex(text[pos:])
		if loc == nil {
			break
		}
		start := pos + loc[0]
		refStart := pos + loc[2]
		refEnd := pos + loc[3]
		rejected := start > 0
		if rejected {
			switch text[start-1] {
			case '_', '`':
			default:
				if !isASCIILetterOrDigit(text[start-1]) {
					rejected = false
				}
			}
		}
		if rejected {
			pos = start + 1
			continue
		}
		if refEnd > refStart {
			refs = append(refs, text[refStart:refEnd])
		}
		pos = refEnd
	}
	return refs
}

func isASCIILetterOrDigit(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
}

// jsIsSpace reports whether r is in JavaScript's \s set — exactly, both
// ways: unicode.IsSpace adds U+0085 (NEL) and misses U+FEFF (BOM), and
// either drift desynchronizes the tokenizer from opencode's argsRegex —
// a quoted token the engine would split stays glued (or vice versa), and
// an argument boundary lands somewhere else than the run's expansion
// does. The set matches jsSpace's class rune for rune.
func jsIsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// splitArgs mirrors opencode's argsRegex split of the arguments string:
// [Image N] counts as one token (case-insensitive, \s is JavaScript's
// set there — see jsIsSpace), quoted strings keep their spaces,
// everything else splits on whitespace. An unterminated quote is skipped
// the way the engine skips an unmatched alternation branch.
func splitArgs(arguments string) []string {
	runes := []rune(arguments)
	n := len(runes)
	out := make([]string, 0, 4)
	i := 0
	for i < n {
		if jsIsSpace(runes[i]) {
			i++
			continue
		}
		if runes[i] == '[' {
			if l := imageTokenLen(runes, i); l > 0 {
				out = append(out, trimOneQuote(string(runes[i:i+l])))
				i += l
				continue
			}
		}
		if q := runes[i]; q == '"' || q == '\'' {
			if j := closingQuote(runes, i); j > i {
				out = append(out, trimOneQuote(string(runes[i:j+1])))
				i = j + 1
				continue
			}
			// No closing quote: no alternation branch matches at this
			// position, so the engine advances past it.
			i++
			continue
		}
		j := i
		for j < n && !jsIsSpace(runes[j]) && runes[j] != '"' && runes[j] != '\'' {
			j++
		}
		out = append(out, trimOneQuote(string(runes[i:j])))
		i = j
	}
	return out
}

// imageTokenLen matches opencode's [Image\s+\d+] token (case-insensitive,
// Unicode whitespace) at i, returning its length or 0.
func imageTokenLen(runes []rune, i int) int {
	const prefix = "[Image"
	if i+len(prefix) >= len(runes) {
		return 0
	}
	for k := 0; k < len(prefix); k++ {
		if !strings.EqualFold(string(runes[i+k]), string(prefix[k])) {
			return 0
		}
	}
	j := i + len(prefix)
	sawSpace := false
	for j < len(runes) && jsIsSpace(runes[j]) {
		j++
		sawSpace = true
	}
	if !sawSpace {
		return 0
	}
	sawDigit := false
	for j < len(runes) && runes[j] >= '0' && runes[j] <= '9' {
		j++
		sawDigit = true
	}
	if !sawDigit || j >= len(runes) || runes[j] != ']' {
		return 0
	}
	return j - i + 1
}

// closingQuote finds the matching quote for the opener at i, or -1.
func closingQuote(runes []rune, i int) int {
	for j := i + 1; j < len(runes); j++ {
		if runes[j] == runes[i] {
			return j
		}
	}
	return -1
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
// machine-side, faithful to JavaScript's semantics — because opencode
// detects shell and resolves @files on the RESULT, and the two halves of
// the substitution are where a template's clean scan goes wrong:
//
//   - $N placeholders: the highest-numbered one swallows the remaining
//     arguments (args.slice(N-1)); $0 — matched by /\$(\d+)/ — takes the
//     LAST argument when it is the highest (args.slice(-1)), and becomes
//     the literal text "undefined" otherwise (JS args[-1]);
//   - $ARGUMENTS is replaced with STRING-replacement semantics: the
//     arguments' own $$, $&, $` and $' sequences expand against the
//     template — $$ is a literal dollar, $& the placeholder itself, and
//     $`/`$' the template text before/after the placeholder. A repo
//     template chooses that surrounding text, which is exactly how
//     "!$'" pulls the closing half of a code span into a shell construct
//     the template's own scan never saw.
func ExpandArguments(template, arguments string) string {
	args := splitArgs(arguments)
	matches := placeholderRe.FindAllStringSubmatch(template, -1)
	last := 0
	for _, m := range matches {
		if position := placeholderPosition(m[1]); position > last {
			last = position
		}
	}
	withArgs := placeholderRe.ReplaceAllStringFunc(template, func(match string) string {
		position := placeholderPosition(match[1:])
		argIndex := position - 1
		if argIndex >= len(args) {
			return ""
		}
		if position == last {
			return strings.Join(jsSlice(args, argIndex), " ")
		}
		if argIndex < 0 {
			// JS args[-1] is undefined; String(undefined) is the text that
			// lands in the template.
			return "undefined"
		}
		return args[argIndex]
	})
	return replaceArgumentsPlaceholder(withArgs, arguments,
		len(matches) > 0 || strings.Contains(template, "$ARGUMENTS"))
}

// replaceArgumentsPlaceholder applies $ARGUMENTS with JavaScript's
// string-replacement semantics (see the ExpandArguments note). hadPlaceholders
// carries whether the template named any $N: with none AND no $ARGUMENTS, a
// non-blank argument string is appended (opencode's own rule).

// placeholderPosition parses one of placeholderRe's captured digit runs.
func placeholderPosition(digits string) int {
	var position int
	// A $N with more digits than an int holds overflows Sscanf, which
	// leaves position at its zero value: the index reads as $0 (the last
	// argument) where JavaScript would read the full digit string as an
	// enormous index and answer undefined. Over-refusal only — the gate
	// may scan text the real substitution would not have produced — and
	// recorded here rather than fixed: matching JS's float-index
	// semantics for a 500-digit placeholder is not worth the gate's
	// while.
	fmt.Sscanf(digits, "%d", &position)
	return position
}

// jsSlice mirrors JavaScript's Array.slice for the indices the command
// substitution produces (including -1, which reads from the end).
func jsSlice(args []string, index int) []string {
	if index < 0 {
		if len(args) == 0 {
			return nil
		}
		return args[len(args)-1:]
	}
	if index >= len(args) {
		return nil
	}
	return args[index:]
}

// replaceArgumentsPlaceholder applies $ARGUMENTS with JavaScript's
// string-replacement semantics: the replacement string's own $$, $&,
// $` and $' sequences expand against the template ($$ a literal dollar,
// $& the placeholder itself, $`/`$' the template text before/after the
// match). $1..$9 stay literal: the pattern carries no capture groups.
// The substitution is done by hand rather than with strings.ReplaceAll —
// Go's is literal, and the difference is the whole exploit.
func replaceArgumentsPlaceholder(template, arguments string, hadPlaceholders bool) string {
	const placeholder = "$ARGUMENTS"
	// original and abs carry the un-consumed string and the absolute
	// offset of template's start within it: JS's $` inserts the ORIGINAL
	// string up to the match, and template is re-sliced after every
	// match — from the second $ARGUMENTS on, template[:i] would be only
	// the text since the previous match, rebuilding a template that
	// hides what JS's substitution would expose.
	original := template
	abs := 0
	var out strings.Builder
	for {
		i := strings.Index(template, placeholder)
		if i < 0 {
			break
		}
		out.WriteString(template[:i])
		runes := []rune(arguments)
		for j := 0; j < len(runes); j++ {
			if runes[j] != '$' {
				out.WriteRune(runes[j])
				continue
			}
			// A dollar in the replacement is JS's substitution pattern: the
			// next rune decides, and a trailing dollar stays literal.
			if j+1 >= len(runes) {
				out.WriteRune('$')
				break
			}
			switch runes[j+1] {
			case '$':
				out.WriteRune('$')
				j++
			case '&':
				out.WriteString(placeholder)
				j++
			case '`':
				// $` is the original string up to the match — absolute,
				// never the re-sliced template's prefix.
				out.WriteString(original[:abs+i])
				j++
			case '\'':
				// $' is the original's suffix after the match; the
				// re-sliced template's remainder IS that suffix, because
				// slicing only ever removed the consumed prefix.
				out.WriteString(template[i+len(placeholder):])
				j++
			default:
				out.WriteRune('$')
			}
		}
		abs += i + len(placeholder)
		template = template[i+len(placeholder):]
	}
	out.WriteString(template)
	// opencode's own rule: with no $N placeholder and no $ARGUMENTS in the
	// original template, a non-blank argument string is appended.
	if !hadPlaceholders && strings.TrimSpace(arguments) != "" {
		return out.String() + "\n\n" + arguments
	}
	return out.String()
}

// hashOf is the template hash the wire shape and the origin proofs share.
func hashOf(template string) string {
	sum := sha256.Sum256([]byte(template))
	return hex.EncodeToString(sum[:])
}

// listedCommand is one GET /command entry with its template alongside: the
// scan's display facts ride the Command, but the origin proofs and the run
// path's expansion need the template text itself.
type listedCommand struct {
	cmd      backend.Command
	template string
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
	cmd.TemplateHash = hashOf(template)
	return cmd
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
// baseline the workspace listing's origins are proven against. Full
// entries, so builtin metadata and machine-scope hashes both compare
// against the same baseline.
func (b *Backend) stateCommands(ctx context.Context) map[string]listedCommand {
	b.stateCmdMu.Lock()
	defer b.stateCmdMu.Unlock()
	if b.stateCmdBaseline != nil {
		return b.stateCmdBaseline
	}
	b.stateCmdBaseline = map[string]listedCommand{}
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
		b.stateCmdBaseline[entry.cmd.Name] = entry
	}
	return b.stateCmdBaseline
}

// builtinMetadataEqual says whether a workspace entry is opencode's own
// builtin rather than a repo file borrowing the name: description, agent,
// model, subtask, source and hints must all match the state baseline's.
// The template hash is deliberately excluded — init's template interpolates
// the worktree path, so byte-identical builtins hash differently per
// directory.
func builtinMetadataEqual(state, workspace backend.Command) bool {
	return state.Description == workspace.Description &&
		state.Agent == workspace.Agent &&
		state.Model == workspace.Model &&
		state.Subtask == workspace.Subtask &&
		state.Source == workspace.Source &&
		strings.Join(state.Hints, "\x00") == strings.Join(workspace.Hints, "\x00")
}

// builtinTemplateMatches says whether a workspace entry's template is the
// builtin's: review's is static (exact hash); init's interpolates the
// instance directory, so the hashes compare only after the state
// directory's path is substituted with the workspace's.
func builtinTemplateMatches(name, baseTemplate, workspaceTemplate, stateDir, workspaceDir string) bool {
	if baseTemplate == "" || workspaceTemplate == "" {
		return false
	}
	switch name {
	case "init":
		adapted := strings.Replace(baseTemplate, stateDir, workspaceDir, 1)
		return hashOf(adapted) == hashOf(workspaceTemplate)
	default:
		return hashOf(baseTemplate) == hashOf(workspaceTemplate)
	}
}

// assignOrigin proves a listed entry's origin against the state baseline
// (L8): machine scope and the builtin label need CONTENT proof, not a
// name match — a repo file borrowing a machine command's name, or a
// builtin's, reads as the repo's (project), which is what routes it
// through the confirmation sheet. Skills diff by hash the same way; MCP
// commands stay machine (their definitions come from connected servers,
// not files).
func assignOrigin(cmd *backend.Command, workspaceTemplate string, baseline map[string]listedCommand, stateDir, workspaceDir string) {
	base, ok := baseline[cmd.Name]
	switch {
	case builtinCommands[cmd.Name]:
		if ok && builtinMetadataEqual(base.cmd, *cmd) &&
			builtinTemplateMatches(cmd.Name, base.template, workspaceTemplate, stateDir, workspaceDir) {
			cmd.Origin = backend.OriginBuiltin
		} else {
			cmd.Origin = backend.OriginProject
		}
	case cmd.Source == backend.SourceSkill:
		if ok && base.cmd.TemplateHash != "" && base.cmd.TemplateHash == cmd.TemplateHash {
			cmd.Origin = backend.OriginMachine
		} else {
			cmd.Origin = backend.OriginProject
		}
	case cmd.Source == backend.SourceMCP:
		cmd.Origin = backend.OriginMachine
	default:
		if ok && base.cmd.TemplateHash != "" && base.cmd.TemplateHash == cmd.TemplateHash {
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
		assignOrigin(&cmd, entry.template, state, b.cfg.StateDir, workspaceDir)
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
		assignOrigin(&cmd, entry.template, state, b.cfg.StateDir, workspaceDir)
		return backend.ResolvedCommand{Command: cmd, Expanded: ExpandArguments(entry.template, arguments)}, nil
	}
	return backend.ResolvedCommand{}, backend.ErrCommandNotFound
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

// RunCommand implements backend.Commander's run half: the exact
// client-message mapping and the transcript marker are recorded BEFORE the
// POST, which then runs in a goroutine on the long-lived client — the call
// blocks for the whole turn, and the fast CRUD client's deadline would cut
// it off. This method returns once the run is accepted; a late failure
// becomes an error event on the session.
func (b *Backend) RunCommand(ctx context.Context, workspaceDir, sessionID string, run backend.CommandRun) error {
	agent := run.Agent
	if agent == "" {
		agent = b.agentFor(sessionID)
	}
	if err := b.ensureRules(ctx, workspaceDir, sessionID, agent); err != nil {
		return err
	}
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
