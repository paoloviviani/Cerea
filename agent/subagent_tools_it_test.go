package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/sessions"
)

// A task subagent of a session that was once on Deny keeps its tools on its
// FIRST step (anomalyco/opencode#45078): opencode seeds the child with the
// parent's deny rules only, so the Deny block's `* * deny` reached every
// future child without the allows that superseded it, and opencode then sent
// the child's first request with no tools at all — the model could only
// answer in text, and a background child ended there. The mock sees each
// request's tool list, which is the fact under test.
func TestSubagentKeepsItsToolsAfterTheParentWasOnDeny(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	s := r.session("sv", "")
	r.setMode(s, "deny")
	r.setMode(s, "allow")

	marker := fmt.Sprintf("sv-child-marker-%d", time.Now().UnixNano())
	r.script(map[string]any{
		"toolCalls": []map[string]any{{
			"id":        fmt.Sprintf("call_sv%d", r.next()),
			"name":      "task",
			"arguments": mustJSON2(map[string]any{"description": "child", "prompt": marker + ": say done", "subagent_type": "general"}),
		}},
		// The child's own requests carry the marker: answer them with text,
		// so the child finishes after its first step either way.
		"routes": []map[string]any{{
			"contains": marker,
			"scenario": map[string]any{"content": []string{"child done"}, "chunkDelayMs": 5, "finishReason": "stop"},
		}},
	})
	mark := r.hub.mark()
	if err := r.promptSession(s, "delegate it"); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	r.hub.wait(t, mark, 90*time.Second, "the task call to finish", func(e sessions.Envelope) bool {
		p := e.Event.Part
		return e.SessionID == s.ID && e.Event.Kind == backend.EventPart && p != nil && p.Tool == "task" &&
			(p.ToolStatus == backend.ToolCompleted || p.ToolStatus == backend.ToolFailed)
	})

	resp, err := http.Get(r.mock + "/__control/request-log")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var log struct {
		Requests []struct {
			Prompts []string `json:"prompts"`
			Tools   []string `json:"tools"`
		} `json:"requests"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&log); err != nil {
		t.Fatal(err)
	}
	var first []string
	found := false
	for _, req := range log.Requests {
		if strings.Contains(strings.Join(req.Prompts, "\n"), marker) {
			first, found = req.Tools, true
			break
		}
	}
	if !found {
		t.Fatalf("the subagent's request never reached the model (%d requests seen)", len(log.Requests))
	}
	has := map[string]bool{}
	for _, name := range first {
		has[name] = true
	}
	for _, want := range []string{"bash", "read", "glob", "grep"} {
		if !has[want] {
			t.Errorf("the subagent's first request offered no %q (tools: %v)", want, first)
		}
	}
}
