package main

// Usage read off the shim (ADR 0110): goose reports no usage over ACP, but every
// model call it makes goes through this proxy, so the `usage` object of each
// chat-completion response is what the session's context meter is fed from.
//
// For a streamed call the shim asks for `stream_options.include_usage` when the
// client did not, and removes the extra final chunk that produces (the one with
// no choices) so the client sees exactly the stream it asked for.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// usageSample is one model call's token counts.
type usageSample struct {
	Model            string
	PromptTokens     int
	CompletionTokens int
	CachedTokens     int
	ReasoningTokens  int
}

// maxUsageRequestBody bounds the request body the shim buffers to inspect; a
// larger one is forwarded untouched and unmetered.
const maxUsageRequestBody = 64 << 20

// maxUsageResponseBody bounds how much of a non-streamed response is kept to find its usage.
const maxUsageResponseBody = 32 << 20

// setUsageSink installs the receiver of per-call usage: given the top-level
// session the call belongs to (as the session tag resolves it) and its tokens.
func (s *shim) setUsageSink(fn func(sessionID string, u usageSample)) {
	s.mu.Lock()
	s.usageSink = fn
	s.mu.Unlock()
}

func (s *shim) usageSinkFn() func(string, usageSample) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.usageSink
}

// usageRequest is what the shim learned from, and did to, one request body.
type usageRequest struct {
	body     []byte
	model    string
	stream   bool
	injected bool // stream_options.include_usage was added by the shim
}

// prepareUsageRequest reads a chat-completion request body. For a streamed call
// without include_usage it sets it and notes that the extra chunk must be
// dropped. A body it cannot parse is returned as it was.
func prepareUsageRequest(body []byte) usageRequest {
	out := usageRequest{body: body}
	var m map[string]json.RawMessage
	if json.Unmarshal(body, &m) != nil {
		return out
	}
	_ = json.Unmarshal(m["model"], &out.model)
	_ = json.Unmarshal(m["stream"], &out.stream)
	if !out.stream {
		return out
	}
	opts := map[string]json.RawMessage{}
	if raw, ok := m["stream_options"]; ok {
		if json.Unmarshal(raw, &opts) != nil {
			return out
		}
	}
	var on bool
	_ = json.Unmarshal(opts["include_usage"], &on)
	if on {
		return out
	}
	opts["include_usage"] = json.RawMessage("true")
	rawOpts, err := json.Marshal(opts)
	if err != nil {
		return out
	}
	m["stream_options"] = rawOpts
	nb, err := json.Marshal(m)
	if err != nil {
		return out
	}
	out.body = nb
	out.injected = true
	return out
}

// parseUsage reads the `usage` of a response (or a stream chunk). ok is false
// when it carries none or an all-zero one.
func parseUsage(raw json.RawMessage) (usageSample, bool) {
	var u struct {
		Prompt  int `json:"prompt_tokens"`
		Compl   int `json:"completion_tokens"`
		Total   int `json:"total_tokens"`
		Details struct {
			Cached int `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
		CDetails struct {
			Reasoning int `json:"reasoning_tokens"`
		} `json:"completion_tokens_details"`
		CacheRead int `json:"cache_read_input_tokens"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &u) != nil {
		return usageSample{}, false
	}
	cached := u.Details.Cached
	if cached == 0 {
		cached = u.CacheRead
	}
	s := usageSample{PromptTokens: u.Prompt, CompletionTokens: u.Compl, CachedTokens: cached, ReasoningTokens: u.CDetails.Reasoning}
	if s.PromptTokens == 0 && s.CompletionTokens == 0 && u.Total > 0 {
		s.PromptTokens = u.Total
	}
	if s.PromptTokens == 0 && s.CompletionTokens == 0 {
		return usageSample{}, false
	}
	return s, true
}

// usageFromBody finds the usage of a non-streamed chat-completion response.
func usageFromBody(body []byte) (usageSample, string, bool) {
	var m struct {
		Model string          `json:"model"`
		Usage json.RawMessage `json:"usage"`
	}
	if json.Unmarshal(body, &m) != nil {
		return usageSample{}, "", false
	}
	u, ok := parseUsage(m.Usage)
	return u, m.Model, ok
}

// copyUsageStream relays an SSE stream line by line, reporting the usage it
// carries and, when `drop` is set, withholding the usage-only chunk (no
// choices) the shim asked for on the client's behalf.
func copyUsageStream(w http.ResponseWriter, body io.Reader, drop bool, report func(usageSample, string)) {
	flusher, _ := w.(http.Flusher)
	r := bufio.NewReaderSize(body, 64*1024)
	skipBlank := false
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			trim := bytes.TrimRight(line, "\r\n")
			if skipBlank && len(trim) == 0 {
				skipBlank = false
			} else {
				skipBlank = false
				withhold := false
				if payload, ok := bytes.CutPrefix(trim, []byte("data:")); ok && bytes.Contains(payload, []byte(`"usage"`)) {
					var chunk struct {
						Model   string            `json:"model"`
						Choices []json.RawMessage `json:"choices"`
						Usage   json.RawMessage   `json:"usage"`
					}
					if json.Unmarshal(bytes.TrimSpace(payload), &chunk) == nil {
						if u, ok := parseUsage(chunk.Usage); ok {
							report(u, chunk.Model)
							if drop && len(chunk.Choices) == 0 {
								withhold = true
							}
						}
					}
				}
				if withhold {
					skipBlank = true
				} else {
					if _, werr := w.Write(line); werr != nil {
						return
					}
					if flusher != nil && len(trim) == 0 {
						flusher.Flush()
					}
				}
			}
		}
		if err != nil {
			if flusher != nil {
				flusher.Flush()
			}
			return
		}
	}
}

// isChatCompletions reports whether the path is a chat-completion call.
func isChatCompletions(path string) bool {
	return strings.HasSuffix(strings.TrimRight(path, "/"), "/chat/completions")
}

// cappedBuffer keeps what is written to it up to a limit, then notes it went over.
type cappedBuffer struct {
	buf   bytes.Buffer
	limit int
	over  bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if c.buf.Len()+len(p) > c.limit {
		c.over = true
		return len(p), nil
	}
	return c.buf.Write(p)
}
