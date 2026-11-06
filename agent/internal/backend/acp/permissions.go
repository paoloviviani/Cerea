package acp

// The ACP adapter's half of ADR 0097: the same decision function as opencode's
// answers session/request_permission. ACP agents ask for tool calls according
// to their own policy, so "every effectful call asks" holds exactly as far as
// the agent asks: an ACP agent that auto-approves a tool never reaches galopin,
// and the ceiling cannot refuse what it does not see (the docs say so).
//
// The selector, exceptions and coordination grant are galopin's own state, kept
// here in memory per session: a restart of galopin starts every session on Ask,
// the safe side.

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"sync"

	"galopin/internal/backend"
	"galopin/internal/permrules"
)

type selectors struct {
	mu  sync.Mutex
	sel map[string]permrules.Selector
	fn  func()
}

func (s *selectors) get(id string) permrules.Selector {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sel[id]
}

func (s *selectors) update(id string, f func(permrules.Selector) permrules.Selector) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sel == nil {
		s.sel = map[string]permrules.Selector{}
	}
	s.sel[id] = f(s.sel[id])
}

// AskKey maps ACP's tool-call kind onto the permission key the decision
// function knows. An unknown kind is "other", which the function treats as an
// effectful MCP-style tool.
func AskKey(kind string) string {
	switch kind {
	case "read":
		return "read"
	case "search":
		return "grep"
	case "edit", "delete", "move":
		return "edit"
	case "execute":
		return "bash"
	case "fetch":
		return "webfetch"
	case "think":
		return "todowrite"
	}
	return "acp_" + kind
}

// NormalizeAsk implements backend.AskNormalizer: the permission key and the
// patterns (paths, or the command) the decision function reads.
func (b *Backend) NormalizeAsk(req backend.PermissionRequest) (string, []string) {
	m, _ := req.Metadata["acp"].(map[string]any)
	kind, _ := m["kind"].(string)
	var patterns []string
	if cmd, _ := m["command"].(string); cmd != "" {
		patterns = append(patterns, cmd)
	}
	if paths, ok := m["paths"].([]string); ok {
		patterns = append(patterns, paths...)
	}
	if kind == "" {
		return req.Tool, req.Patterns
	}
	return AskKey(kind), patterns
}

func (b *Backend) AgentRules(_ context.Context, _, sessionID string) (backend.RuleLayers, error) {
	return backend.RuleLayers{Mode: string(b.sels.get(sessionID).Effective())}, nil
}
func (b *Backend) PermissionMode(sessionID string) permrules.Action {
	return b.sels.get(sessionID).Effective()
}
func (b *Backend) SetPermissionMode(_ context.Context, _, sessionID string, mode permrules.Action) error {
	b.sels.update(sessionID, func(s permrules.Selector) permrules.Selector { s.Mode = mode; return s })
	return nil
}
func (b *Backend) Exceptions(sessionID string) []permrules.Exception {
	return append([]permrules.Exception(nil), b.sels.get(sessionID).Exceptions...)
}
func (b *Backend) AddException(_ context.Context, _, sessionID string, e permrules.Exception) (permrules.Exception, error) {
	var kept permrules.Exception
	b.sels.update(sessionID, func(s permrules.Selector) permrules.Selector {
		next, k := s.With(e)
		kept = k
		return next
	})
	return kept, nil
}
func (b *Backend) RemoveException(_ context.Context, _, sessionID, id string) (bool, error) {
	found := false
	b.sels.update(sessionID, func(s permrules.Selector) permrules.Selector {
		next, ok := s.Without(id)
		found = ok
		return next
	})
	return found, nil
}
func (b *Backend) Coordination(sessionID string) []string {
	return append([]string(nil), b.sels.get(sessionID).Coordination...)
}
func (b *Backend) SetCoordination(_ context.Context, _, sessionID string, keys []string) error {
	keys = append([]string(nil), keys...)
	sort.Strings(keys)
	b.sels.update(sessionID, func(s permrules.Selector) permrules.Selector { s.Coordination = keys; return s })
	return nil
}

// PendingAsks: an ACP agent's pending request dies with its connection, and
// there is no listing to answer from.
func (b *Backend) PendingAsks(context.Context) ([]backend.PermissionRequest, error) { return nil, nil }
func (b *Backend) PlanDirs() []string                                               { return nil }
func (b *Backend) OnProcessStart(fn func()) {
	b.sels.mu.Lock()
	b.sels.fn = fn
	b.sels.mu.Unlock()
}
func (b *Backend) StaleDeny(string) bool   { return false }
func (b *Backend) StalePolicy(string) bool { return false }

func (b *Backend) processStarted() {
	b.sels.mu.Lock()
	fn := b.sels.fn
	b.sels.mu.Unlock()
	if fn != nil {
		fn()
	}
}

var _ backend.RuleHost = (*Backend)(nil)

// paths of a tool call's locations and its raw input, for the patterns.
func askMetadata(toolCall map[string]any) map[string]any {
	toolCall = unwrapPiGate(toolCall)
	meta := map[string]any{"kind": inferKind(toolCall)}
	var paths []string
	if locs, ok := toolCall["locations"].([]any); ok {
		for _, l := range locs {
			if lm, ok := l.(map[string]any); ok {
				if p := strings.TrimSpace(getStr(lm, "path")); p != "" {
					paths = append(paths, p)
				}
			}
		}
	}
	if raw, ok := toolCall["rawInput"].(map[string]any); ok {
		if c := getStr(raw, "command"); c != "" {
			meta["command"] = c
		}
		if p := getStr(raw, "path", "file_path", "filePath"); p != "" {
			paths = append(paths, p)
		}
	}
	if len(paths) > 0 {
		meta["paths"] = paths
	}
	return map[string]any{"acp": meta}
}

// inferKind is the tool call's ACP kind, or, when the agent sends none or the
// catch-all "other" (goose puts "other" on every ask, whatever the tool), the
// kind its title and raw input give away. Without it a shell command would be
// decided as an unknown "tools" ask: no command limit, no read-only rule.
// Unrecognised shapes stay "other", which is the cautious class.
func inferKind(toolCall map[string]any) string {
	kind := getStr(toolCall, "kind")
	if kind != "" && kind != "other" {
		return kind
	}
	if raw, ok := toolCall["rawInput"].(map[string]any); ok && getStr(raw, "command") != "" {
		return "execute"
	}
	// goose titles an ask "<tool> · <argument>".
	name, _, found := strings.Cut(getStr(toolCall, "title"), " \u00b7 ")
	if found {
		switch strings.TrimSpace(name) {
		case "write", "edit", "str_replace", "multi_edit":
			return "edit"
		case "tree":
			return "read"
		}
	}
	return kind
}

// unwrapPiGate reads the ask of the pi permission-gate extension (the recipe in
// docs ships it): pi-acp has no tool permissions of its own, only the ACP
// forwarding of an extension's ctx.ui.confirm(title, message), kind "other".
// The gate titles that confirm "pi <tool>" and puts {"tool","input"} JSON in
// the message; this turns it back into an ordinary tool call (kind, rawInput)
// so the same decision function applies. Anything else is returned unchanged.
func unwrapPiGate(toolCall map[string]any) map[string]any {
	title := getStr(toolCall, "title")
	if !strings.HasPrefix(title, "pi ") {
		return toolCall
	}
	raw, _ := toolCall["rawInput"].(map[string]any)
	var msg struct {
		Tool  string         `json:"tool"`
		Input map[string]any `json:"input"`
	}
	if raw == nil || getStr(raw, "method") != "confirm" || json.Unmarshal([]byte(getStr(raw, "message")), &msg) != nil || msg.Tool != strings.TrimPrefix(title, "pi ") {
		return toolCall
	}
	kind := ""
	switch msg.Tool {
	case "bash":
		kind = "execute"
	case "write", "edit":
		kind = "edit"
	case "read":
		kind = "read"
	case "grep", "find", "ls":
		kind = "search"
	}
	if kind == "" {
		return toolCall
	}
	out := map[string]any{}
	for k, v := range toolCall {
		out[k] = v
	}
	out["kind"] = kind
	out["rawInput"] = msg.Input
	return out
}
