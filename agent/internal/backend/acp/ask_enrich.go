package acp

// An ACP agent's session/request_permission carries a toolCall that the spec
// lets be sparse: Mistral Vibe sends one with no title and no kind, naming only
// the toolCallId, while the tool_call notification just before it (or an update)
// carried the kind, title, rawInput and locations. Without them the decision
// function sees an unclassified tool (no Auto row, no card). The backend keeps
// the latest non-empty value of those fields per toolCallId and fills an ask's
// gaps from them. It is generic: any agent whose ask omits what its own
// tool_call said benefits, and an ask that is complete is left exactly as it was.

const maxTrackedCalls = 512

// callMemoFields are the tool-call fields an ask may be missing.
var callMemoFields = []string{"kind", "name", "title", "rawInput", "locations", "content"}

// rememberCall merges a tool_call / tool_call_update's descriptive fields into
// the session's memo for its toolCallId. st.mu must be held.
func (s *sessionState) rememberCall(callID string, upd map[string]any) {
	if callID == "" {
		return
	}
	if s.calls == nil {
		s.calls = map[string]map[string]any{}
	}
	memo, ok := s.calls[callID]
	if !ok {
		if len(s.calls) >= maxTrackedCalls {
			// A long session: forget the memo wholesale rather than grow without
			// bound; an ask for a forgotten call is simply not enriched.
			s.calls = map[string]map[string]any{}
		}
		memo = map[string]any{}
		s.calls[callID] = memo
	}
	for _, f := range callMemoFields {
		v, present := upd[f]
		if !present || isEmptyField(v) {
			continue
		}
		// An update's "other" must not overwrite a concrete kind learned earlier.
		if f == "kind" && v == "other" && memo[f] != nil {
			continue
		}
		memo[f] = v
	}
}

func isEmptyField(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case string:
		return t == ""
	case map[string]any:
		return len(t) == 0
	case []any:
		return len(t) == 0
	}
	return false
}

// enrichAsk returns the ask's toolCall with the fields it lacks filled from
// what the session's tool_call notifications said about the same toolCallId.
// "kind" counts as lacking when empty or the catch-all "other". The input map
// is not modified.
func (b *Backend) enrichAsk(st *sessionState, toolCall map[string]any) map[string]any {
	callID := getStr(toolCall, "toolCallId")
	if callID == "" {
		return toolCall
	}
	st.mu.Lock()
	memo := st.calls[callID]
	st.mu.Unlock()
	if len(memo) == 0 {
		return toolCall
	}
	out := make(map[string]any, len(toolCall)+len(memo))
	for k, v := range toolCall {
		out[k] = v
	}
	for _, f := range callMemoFields {
		mv, ok := memo[f]
		if !ok {
			continue
		}
		cur := out[f]
		if isEmptyField(cur) || (f == "kind" && cur == "other" && mv != "other") {
			out[f] = mv
		}
	}
	return out
}
