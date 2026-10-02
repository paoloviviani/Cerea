package opencode

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"galopin/internal/backend"
	"galopin/internal/fsutil"
)

// galopin's agent-coordination tools (PROTOCOL.md §6 "Agent tools"). opencode
// custom tools are files in a config directory's tools/ folder; galopin owns
// one such directory (Config.ToolsDir, exported as OPENCODE_CONFIG_DIR) and
// writes the tool files itself at every start. A tool's execute(args, ctx)
// receives ctx.sessionID and relays the call to a loopback server this
// package runs, guarded by a per-process random bearer token that only the
// opencode child's environment holds. A local MCP server is the wrong route:
// its tools/call carries no session (verified against 1.18.32).
//
// opencode runs a custom tool without asking anything, so the approval is
// galopin's own (Ask): a permission.asked with a galopin-minted id, held here
// and resolved through the ordinary permission.reply op, never through
// opencode's permission system.

const (
	// galopinAskPrefix marks a permission request id galopin minted.
	galopinAskPrefix = "gp_"
	// toolKeepalive is how often a held call writes a heartbeat line, so a
	// long approval wait never trips a client-side fetch timeout.
	toolKeepalive = 15 * time.Second
	// maxToolBody bounds a relayed call's body.
	maxToolBody = 1 << 20
)

// toolDef is one installed tool: its name, what the model is told, and its
// arguments as raw JSON-schema fragments (opencode treats any argument that
// is not a zod schema as one; every key is then required).
type toolDef struct {
	name, description string
	args              string
}

var galopinTools = []toolDef{
	{
		name:        "session_list",
		description: "List the other coding sessions on this machine (id, title, workspace, mode, status) so you can address one with session_send. Read-only.",
		args:        `{ note: { type: "string", description: "Anything, e.g. why you are listing. Ignored." } }`,
	},
	{
		name: "session_spawn",
		description: "Start a NEW top-level session in this same workspace and give it a first prompt; it runs on its own, and its transcript is the person's to read. " +
			"The person is asked to approve every spawn (they see the title, mode and prompt) unless this machine's rules allow spawning, and a rule can refuse it outright. The new session can never be less restricted than you: " +
			"mode may be your own or \"plan\" (read-only), it has no auto-accept, and it uses your model. You get its id, not its result; " +
			"it has the same tools, so it can session_send you a message when its work is done (each send asks the person). Limits apply (chain depth, live sessions, rate).",
		args: `{ title: { type: "string", description: "Short title for the new session." },` +
			` prompt: { type: "string", description: "The first prompt: everything the new session needs, it cannot see this conversation." },` +
			` mode: { type: "string", description: "The new session's mode: \"plan\", \"build\", or \"inherit\" for your own." } }`,
	},
	{
		name: "session_send",
		description: "Send a message to ANOTHER session on this machine (by id from session_list); it arrives as a prompt marked as coming from you, folded into its running turn if it is busy. " +
			"The person is asked to approve every send unless this machine's rules allow it (a rule can also refuse it). The target has the same tools and can send a message back the same way — but do not assume it will. " +
			"Not for your own subagents (use task) or yourself. Limits apply (hops, rate).",
		args: `{ target: { type: "string", description: "The target session id, from session_list." },` +
			` text: { type: "string", description: "The message." } }`,
	},
}

const toolJSTemplate = `// Written by galopin at every start; do not edit. Relays this call to galopin.
export default {
  description: %s,
  args: %s,
  async execute(args, ctx) {
    const url = process.env.GALOPIN_TOOL_URL;
    const token = process.env.GALOPIN_TOOL_TOKEN;
    if (!url || !token) throw new Error("galopin's tool relay is not available");
    const res = await fetch(url, {
      method: "POST",
      signal: ctx.abort,
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ tool: %s, sessionID: ctx.sessionID, callID: ctx.callID, messageID: ctx.messageID, args }),
    });
    const lines = (await res.text()).split("\n").map((l) => l.trim()).filter(Boolean);
    let last;
    try { last = JSON.parse(lines[lines.length - 1]); } catch { throw new Error("galopin's tool relay answered nothing usable (status " + res.status + ")"); }
    if (!last.ok) throw new Error(last.error || "refused");
    return last.output || "";
  },
};
`

// toolPlan is the tool subsystem's per-process state.
type toolPlan struct {
	token string
	srv   *http.Server
	url   string
	mu    sync.Mutex
	asks  map[string]*pendingAsk
}

// pendingAsk is one galopin approval a tool call is blocked on.
type pendingAsk struct {
	sessionID string
	dir       string
	answer    chan askAnswer
}

type askAnswer struct {
	decision backend.Decision
	message  string
}

// toolsEnabled reports whether this Backend installs galopin's tools.
func (b *Backend) toolsEnabled() bool { return b.cfg.ToolsDir != "" }

// startTools writes the tool files and starts the loopback relay. Called by
// Start before the first opencode launch; the environment additions it wants
// are returned by toolEnv.
func (b *Backend) startTools() error {
	if !b.toolsEnabled() {
		return nil
	}
	for _, kv := range b.cfg.Env {
		if strings.HasPrefix(kv, "OPENCODE_CONFIG_DIR=") {
			return fmt.Errorf("opencode: OPENCODE_CONFIG_DIR is already set in the environment; galopin's tools need their own directory (unset it, or leave Config.ToolsDir empty)")
		}
	}
	token, err := randomHex(32)
	if err != nil {
		return fmt.Errorf("opencode: minting the tool relay token: %w", err)
	}
	dir := filepath.Join(b.cfg.ToolsDir, "tools")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("opencode: creating the tools directory: %w", err)
	}
	for _, t := range galopinTools {
		desc, _ := json.Marshal(t.description)
		name, _ := json.Marshal(t.name)
		src := fmt.Sprintf(toolJSTemplate, desc, t.args, name)
		if err := fsutil.WriteFileAtomic(filepath.Join(dir, t.name+".js"), []byte(src), 0o600); err != nil {
			return fmt.Errorf("opencode: writing tool %s: %w", t.name, err)
		}
	}
	if err := b.installSkill(); err != nil {
		return err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("opencode: tool relay listen: %w", err)
	}
	tp := &toolPlan{
		token: token,
		url:   "http://" + ln.Addr().String() + "/tool",
		asks:  map[string]*pendingAsk{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/tool", b.serveTool)
	tp.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	b.toolsMu.Lock()
	b.tools = tp
	b.toolsMu.Unlock()
	go func() { _ = tp.srv.Serve(ln) }()
	return nil
}

// stopTools closes the relay; every held ask is withdrawn by its own
// request context ending.
func (b *Backend) stopTools() {
	b.toolsMu.Lock()
	tp := b.tools
	b.toolsMu.Unlock()
	if tp != nil {
		_ = tp.srv.Close()
	}
}

// toolEnv is what the opencode child needs to find galopin's tools.
func (b *Backend) toolEnv() []string {
	b.toolsMu.Lock()
	tp := b.tools
	b.toolsMu.Unlock()
	if tp == nil {
		return nil
	}
	return []string{
		"OPENCODE_CONFIG_DIR=" + b.cfg.ToolsDir,
		"GALOPIN_TOOL_URL=" + tp.url,
		"GALOPIN_TOOL_TOKEN=" + tp.token,
	}
}

// SetToolHandler implements backend.ToolHost.
func (b *Backend) SetToolHandler(h backend.ToolHandler) {
	b.toolsMu.Lock()
	b.toolHandlerFn = h
	b.toolsMu.Unlock()
}

func (b *Backend) toolHandler() backend.ToolHandler {
	b.toolsMu.Lock()
	defer b.toolsMu.Unlock()
	return b.toolHandlerFn
}

// serveTool is the relay endpoint. The response streams newline-delimited
// JSON: {"keepalive":true} while the call is held, then exactly one final
// {"ok":true,"output":…} or {"ok":false,"error":…}.
func (b *Backend) serveTool(w http.ResponseWriter, r *http.Request) {
	b.toolsMu.Lock()
	tp := b.tools
	b.toolsMu.Unlock()
	if tp == nil || r.Method != http.MethodPost {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	auth := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(auth), []byte(tp.token)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxToolBody+1))
	if err != nil || len(body) > maxToolBody {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	var in struct {
		Tool      string          `json:"tool"`
		SessionID string          `json:"sessionID"`
		CallID    string          `json:"callID"`
		MessageID string          `json:"messageID"`
		Args      json.RawMessage `json:"args"`
	}
	if err := json.Unmarshal(body, &in); err != nil || in.Tool == "" || in.SessionID == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	known := false
	for _, t := range galopinTools {
		known = known || t.name == in.Tool
	}
	handler := b.toolHandler()

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	writeLine := func(v any) {
		line, _ := json.Marshal(v)
		_, _ = w.Write(append(line, '\n'))
		if flusher != nil {
			flusher.Flush()
		}
	}
	writeLine(map[string]any{"keepalive": true})

	type result struct {
		out string
		err error
	}
	done := make(chan result, 1)
	if !known || handler == nil {
		done <- result{err: &backend.ToolRefusal{Message: "galopin's agent tools are not available right now"}}
	} else {
		go func() {
			out, err := handler(r.Context(), backend.ToolCall{
				Tool: in.Tool, SessionID: in.SessionID, CallID: in.CallID, MessageID: in.MessageID, Args: in.Args,
			})
			done <- result{out, err}
		}()
	}
	tick := time.NewTicker(toolKeepalive)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
			writeLine(map[string]any{"keepalive": true})
		case res := <-done:
			var refusal *backend.ToolRefusal
			switch {
			case res.err == nil:
				writeLine(map[string]any{"ok": true, "output": res.out})
			case errors.As(res.err, &refusal):
				writeLine(map[string]any{"ok": false, "error": refusedText(refusal.Message)})
			default:
				b.cfg.Logf("opencode: tool %s failed: %v", in.Tool, res.err)
				writeLine(map[string]any{"ok": false, "error": refusedText("galopin could not complete this tool call")})
			}
			return
		}
	}
}

// refusedText is the stable shape of every tool refusal (PROTOCOL.md §6): the
// tool part's error text is exactly this JSON object, so a client parses one
// shape whatever gate said no.
func refusedText(reason string) string {
	body, _ := json.Marshal(map[string]string{"refused": reason})
	return string(body)
}

// Ask implements backend.ToolHost: galopin's own approval, held here.
func (b *Backend) Ask(ctx context.Context, workspaceDir, sessionID string, req backend.PermissionRequest) (backend.Decision, string, error) {
	b.toolsMu.Lock()
	tp := b.tools
	b.toolsMu.Unlock()
	if tp == nil {
		return "", "", errors.New("the tool relay is not running")
	}
	suffix, err := randomHex(8)
	if err != nil {
		return "", "", err
	}
	req.ID = galopinAskPrefix + suffix
	req.SessionID = sessionID
	if req.Metadata == nil {
		req.Metadata = map[string]any{}
	}
	req.Metadata["galopin"] = true
	req.Always = nil
	pa := &pendingAsk{sessionID: sessionID, dir: workspaceDir, answer: make(chan askAnswer, 1)}
	tp.mu.Lock()
	tp.asks[req.ID] = pa
	tp.mu.Unlock()
	drop := func() {
		tp.mu.Lock()
		delete(tp.asks, req.ID)
		tp.mu.Unlock()
	}
	if err := b.injectBlocking(ctx, workspaceDir, sessionID, backend.Event{Kind: backend.EventPermissionAsked, Request: &req}); err != nil {
		drop()
		return "", "", err
	}
	select {
	case a := <-pa.answer:
		return a.decision, a.message, nil
	case <-ctx.Done():
		// The call was aborted (the turn was cancelled, opencode went away):
		// withdraw the ask so no card is left for a call that is gone.
		if _, held := b.claimAsk(req.ID); held {
			_ = b.injectBlocking(context.Background(), workspaceDir, sessionID, backend.Event{
				Kind: backend.EventPermissionReplied, RequestID: req.ID, Decision: backend.DecisionReject, By: "user",
			})
		}
		return "", "", ctx.Err()
	}
}

// claimAsk removes and returns a held ask, once: whichever of a reply or a
// withdrawal gets it first wins.
func (b *Backend) claimAsk(id string) (*pendingAsk, bool) {
	b.toolsMu.Lock()
	tp := b.tools
	b.toolsMu.Unlock()
	if tp == nil {
		return nil, false
	}
	tp.mu.Lock()
	defer tp.mu.Unlock()
	pa, ok := tp.asks[id]
	delete(tp.asks, id)
	return pa, ok
}

// replyGalopinAsk resolves a held ask from permission.reply. A galopin id
// never reaches opencode; an unknown one (already answered, withdrawn, or a
// restart's) is refused, not forwarded.
func (b *Backend) replyGalopinAsk(ctx context.Context, sessionID, requestID string, decision backend.Decision, message string) error {
	pa, ok := b.claimAsk(requestID)
	if !ok {
		return fmt.Errorf("permission request %s is not pending (already answered, or its call is gone)", requestID)
	}
	if pa.sessionID != sessionID {
		// Not this session's ask: put it back rather than let a wrong id
		// consume it.
		b.toolsMu.Lock()
		tp := b.tools
		b.toolsMu.Unlock()
		if tp != nil {
			tp.mu.Lock()
			tp.asks[requestID] = pa
			tp.mu.Unlock()
		}
		return fmt.Errorf("permission request %s is not pending for this session", requestID)
	}
	// "always" is never remembered: it is one approval, like once.
	if decision == backend.DecisionAlways {
		decision = backend.DecisionOnce
	}
	if decision != backend.DecisionOnce {
		decision = backend.DecisionReject
	}
	if err := b.injectBlocking(ctx, pa.dir, pa.sessionID, backend.Event{
		Kind: backend.EventPermissionReplied, RequestID: requestID, Decision: decision, By: "user",
	}); err != nil {
		// The ask was consumed; still release the call.
		pa.answer <- askAnswer{decision: decision, message: message}
		return nil
	}
	pa.answer <- askAnswer{decision: decision, message: message}
	return nil
}

// injectBlocking puts an event into the Subscribe stream, waiting for room
// (an approval event must not be dropped the way a late-failure notice may).
func (b *Backend) injectBlocking(ctx context.Context, workspaceDir, sessionID string, ev backend.Event) error {
	b.injectMu.Lock()
	ch := b.injectCh
	b.injectMu.Unlock()
	if ch == nil {
		return errors.New("nothing is subscribed to this backend's events")
	}
	select {
	case ch <- backend.BackendEvent{WorkspaceDir: workspaceDir, SessionID: sessionID, Event: ev}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(10 * time.Second):
		return errors.New("the event stream is not draining")
	}
}

// SpawnMarks implements backend.ToolHost: the persisted spawnedBy markers.
func (b *Backend) SpawnMarks() map[string]backend.SpawnedBy {
	b.overlayMu.Lock()
	defer b.overlayMu.Unlock()
	out := map[string]backend.SpawnedBy{}
	for id, ov := range b.overlay {
		if ov.SpawnedBy != nil {
			out[id] = *ov.SpawnedBy
		}
	}
	return out
}

// spawnedByFor is one session's marker, nil when it was not spawned.
func (b *Backend) spawnedByFor(sessionID string) *backend.SpawnedBy {
	b.overlayMu.Lock()
	defer b.overlayMu.Unlock()
	if sb := b.overlay[sessionID].SpawnedBy; sb != nil {
		cp := *sb
		return &cp
	}
	return nil
}

// recordSentMarker remembers, durably, that the message a session_send
// minted is another session's.
func (b *Backend) recordSentMarker(messageID string, sender backend.MessageSender) {
	b.markerMu.Lock()
	if b.sentMarkers == nil {
		b.sentMarkers = map[string]backend.MessageSender{}
	}
	b.sentMarkers[messageID] = sender
	b.markerMu.Unlock()
	_ = b.saveOverlay()
}

func (b *Backend) sentMarkerFor(messageID string) *backend.MessageSender {
	b.markerMu.Lock()
	defer b.markerMu.Unlock()
	if m, ok := b.sentMarkers[messageID]; ok {
		m := m
		return &m
	}
	return nil
}
