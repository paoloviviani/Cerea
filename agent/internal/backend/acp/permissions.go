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
	meta := map[string]any{"kind": getStr(toolCall, "kind")}
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
