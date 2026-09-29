// Package mockllm is a minimal OpenAI-compatible upstream for the agent's
// integration tests: GET /v1/models and streaming POST /v1/chat/completions,
// scripted through the same /__control plane as the chat app's mock
// (POST /__control/scenario {"scenario": {...}}).
//
// It lives here, in Go and in-process, so the real-opencode tests need no
// Node and no second repository: they run the same on a laptop, on this box
// and in a scheduled CI job against opencode's latest release.
package mockllm

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ToolCall is one call the upstream asks the client to make.
type ToolCall struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// Scenario scripts every following completion until the next one is set.
// Routes lets one scenario serve a whole subagent tree: when the request's
// messages contain Contains, that route's Scenario answers instead of the
// top level (e.g. the parent's prompt gets a task tool call, while the
// child's own prompt — which echoes the task text — gets a bash call).
type Scenario struct {
	Content      []string   `json:"content"`
	ChunkDelayMs int        `json:"chunkDelayMs"`
	ToolCalls    []ToolCall `json:"toolCalls"`
	FinishReason string     `json:"finishReason"`
	Routes       []Route    `json:"routes"`
}

// Route is one content-based override inside a Scenario.
type Route struct {
	Contains string   `json:"contains"`
	Scenario Scenario `json:"scenario"`
}

var defaultScenario = Scenario{Content: []string{"Hello", " from", " the", " mock", " server", "."}, ChunkDelayMs: 10, FinishReason: "stop"}

// namedScenarios mirrors the chat app's SCENARIOS names the tests use.
var namedScenarios = map[string]Scenario{"plainText": defaultScenario}

// Server is an http.Handler; its zero value is not usable, use New.
type Server struct {
	mu       sync.Mutex
	scenario Scenario
	// requests records every chat-completion request's prompt texts, most
	// recent last, for the integration tests to assert on: "the command's
	// expanded text reached the mock" is exactly the fact only the mock can
	// see. Capped so a long IT run cannot grow it without bound.
	requests [][]string
}

func New() *Server { return &Server{scenario: defaultScenario} }

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/__control/requests":
		s.mu.Lock()
		out := s.requests
		s.mu.Unlock()
		if out == nil {
			out = [][]string{}
		}
		writeJSON(w, map[string]any{"requests": out})
	case r.URL.Path == "/__control/reset-requests" && r.Method == http.MethodPost:
		s.mu.Lock()
		s.requests = nil
		s.mu.Unlock()
		writeJSON(w, map[string]bool{"ok": true})
	case r.URL.Path == "/__control/health":
		writeJSON(w, map[string]bool{"ok": true})
	case r.URL.Path == "/__control/scenario" && r.Method == http.MethodPost:
		var body struct {
			Scenario json.RawMessage `json:"scenario"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// A scenario is either an inline script or a name, as in the chat app's mock.
		var sc Scenario
		var name string
		if json.Unmarshal(body.Scenario, &name) == nil {
			named, ok := namedScenarios[name]
			if !ok {
				http.Error(w, "unknown scenario "+name, http.StatusBadRequest)
				return
			}
			sc = named
		} else if err := json.Unmarshal(body.Scenario, &sc); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		s.mu.Lock()
		s.scenario = sc
		s.mu.Unlock()
		writeJSON(w, map[string]bool{"ok": true})
	case r.URL.Path == "/v1/models":
		writeJSON(w, map[string]any{"object": "list", "data": []map[string]any{{"id": "mock-model", "object": "model"}}})
	case r.URL.Path == "/v1/chat/completions" && r.Method == http.MethodPost:
		s.complete(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) complete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Model    string           `json:"model"`
		Stream   bool             `json:"stream"`
		Messages []map[string]any `json:"messages"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	sc := s.scenario
	s.mu.Unlock()
	// Content-based routing first: a subagent's own prompt echoes the task
	// text that spawned it, which is what distinguishes its requests from
	// its parent's when both hit the same mock.
	if routed, ok := sc.route(req.Messages); ok {
		sc = routed
	}
	// Once a tool result is in the history the call has happened: answer with
	// text, or the client loops forever.
	// Only results after the latest user message count: an earlier turn's
	// tool call must not stop a later prompt from making its own.
	lastUser := -1
	for i, m := range req.Messages {
		if m["role"] == "user" {
			lastUser = i
		}
	}
	toolResultSeen := false
	for i, m := range req.Messages {
		if m["role"] == "tool" && i > lastUser {
			toolResultSeen = true
		}
	}
	var prompts []string
	for _, m := range req.Messages {
		if m["role"] == "user" || m["role"] == "system" {
			if text := contentText(m["content"]); text != "" {
				prompts = append(prompts, text)
			}
		}
	}
	s.mu.Lock()
	s.requests = append(s.requests, prompts)
	s.mu.Unlock()

	calls := sc.ToolCalls
	if toolResultSeen {
		calls = nil
	}
	finish := sc.FinishReason
	if len(calls) > 0 {
		finish = "tool_calls"
	} else if finish == "" {
		finish = "stop"
	}

	if !req.Stream {
		msg := map[string]any{"role": "assistant", "content": join(sc.Content)}
		if len(calls) > 0 {
			msg["tool_calls"] = wireCalls(calls)
		}
		writeJSON(w, map[string]any{"id": "chatcmpl-mock", "object": "chat.completion", "model": req.Model,
			"choices": []map[string]any{{"index": 0, "message": msg, "finish_reason": finish}}})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	flusher, _ := w.(http.Flusher)
	send := func(delta map[string]any, finishReason any) {
		chunk := map[string]any{"id": "chatcmpl-mock", "object": "chat.completion.chunk", "created": 0, "model": req.Model,
			"choices": []map[string]any{{"index": 0, "delta": delta, "finish_reason": finishReason}}}
		body, _ := json.Marshal(chunk)
		fmt.Fprintf(w, "data: %s\n\n", body)
		if flusher != nil {
			flusher.Flush()
		}
	}
	send(map[string]any{"role": "assistant"}, nil)
	if len(calls) > 0 {
		send(map[string]any{"tool_calls": wireCalls(calls)}, nil)
	} else {
		for _, token := range sc.Content {
			select {
			case <-r.Context().Done():
				return // the client cancelled (a Stop): end the stream like a real upstream
			case <-time.After(time.Duration(sc.ChunkDelayMs) * time.Millisecond):
			}
			send(map[string]any{"content": token}, nil)
		}
	}
	send(map[string]any{}, finish)
	fmt.Fprint(w, "data: [DONE]\n\n")
	if flusher != nil {
		flusher.Flush()
	}
}

// route returns the first route whose Contains marker appears anywhere in
// the request's messages (matched against their JSON, so text, tool names
// and tool arguments all count).
func (sc Scenario) route(messages []map[string]any) (Scenario, bool) {
	if len(sc.Routes) == 0 {
		return Scenario{}, false
	}
	raw, err := json.Marshal(messages)
	if err != nil {
		return Scenario{}, false
	}
	for _, r := range sc.Routes {
		if r.Contains != "" && strings.Contains(string(raw), r.Contains) {
			return r.Scenario, true
		}
	}
	return Scenario{}, false
}

// contentText reads an OpenAI-shaped message's content field, which is
// either a plain string or an array of parts (opencode sends the latter,
// e.g. [{"type":"text","text":"…"}], whenever a message carries more than
// one text segment — a plan-mode system-reminder appended to the user's
// own prompt is one such case). Non-text parts (images, etc.) are skipped.
func contentText(content any) string {
	switch v := content.(type) {
	case string:
		return v
	case []any:
		var parts []string
		for _, p := range v {
			part, ok := p.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := part["text"].(string); ok {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}

func wireCalls(calls []ToolCall) []map[string]any {
	out := make([]map[string]any, len(calls))
	for i, c := range calls {
		out[i] = map[string]any{"index": i, "id": c.ID, "type": "function",
			"function": map[string]any{"name": c.Name, "arguments": c.Arguments}}
	}
	return out
}

func join(parts []string) string {
	s := ""
	for _, p := range parts {
		s += p
	}
	return s
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
