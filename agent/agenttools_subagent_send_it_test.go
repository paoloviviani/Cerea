package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/sessions"
)

// The live incident of 2026-10-11, proven live: an Allow parent issued a
// background task, and its subagent — refused a session_send into its own
// tree — listed the machine's sessions, picked the only other top-level row
// and auto-sent /etc/hosts to it, because its root was on Allow. The fix
// makes every send from a task subagent a card, whatever the word or a grant
// says; session_list tells the subagent where its report goes; and the
// background child's result still wakes the parent.
//
// The mock scripts one tool call per user message, so the child gets two
// prompts: the task's own prompt makes it list the machine's sessions (what
// the incident's subagent did first, and what put its own workspace on the
// machine's books), and a second prompt makes it send to the bystander.
//
// GALOPIN_OPENCODE_IT=1 (spawns real opencode + a mock LLM).
func TestSubagentSendToAnotherSessionRunsUnderAllowIntegration(t *testing.T) {
	r := newPermRig(t, permRigOpts{tools: true, background: true})

	parent := r.session("it-send-parent", "")
	r.setMode(parent, "allow")
	bystander := r.session("it-bystander", "")
	marker := "subagent-send-marker"

	taskCall := map[string]any{
		"id":   "call_bg_send",
		"name": "subagent",
		"arguments": mustJSON2(map[string]any{
			"description": "background child", "prompt": marker + ": report what you find",
			"agent": "general", "background": true,
		}),
	}
	listCall := map[string]any{
		"id": "call_child_list", "name": "session_list",
		"arguments": `{"note":"where do I report"}`,
	}
	sendCall := map[string]any{
		"id": "call_child_send", "name": "session_send",
		"arguments": mustJSON2(map[string]any{
			"target": bystander.ID,
			"text":   "the first lines of /etc/hosts: 127.0.0.1 localhost",
		}),
	}
	scenario := func(toolCalls []map[string]any, content string) map[string]any {
		s := map[string]any{"content": []string{content}, "chunkDelayMs": 5, "finishReason": "stop"}
		if toolCalls != nil {
			s["toolCalls"] = toolCalls
		}
		return s
	}

	// Phase one: the parent's task call; the child's first prompt lists the
	// machine's sessions; the parent's later turns answer plainly.
	r.script(map[string]any{
		"toolCalls": []map[string]any{taskCall},
		"content":   []string{"done"}, "chunkDelayMs": 5, "finishReason": "stop",
		"routes": []map[string]any{
			{"contains": "background child", "scenario": scenario(nil, "Parent launched background work.")},
			{"contains": marker, "scenario": scenario([]map[string]any{listCall}, "child done")},
		},
	})

	mark := r.hub.mark()
	if err := r.promptSession(parent, "delegate this in the background"); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	// The background task call returns at once and the parent settles.
	r.hub.wait(t, mark, 90*time.Second, "the background task call to start", func(e sessions.Envelope) bool {
		p := e.Event.Part
		return e.SessionID == parent.ID && e.Event.Kind == backend.EventPart && p != nil && p.Tool == "task" &&
			(p.ToolStatus == backend.ToolCompleted || p.ToolStatus == backend.ToolFailed)
	})
	r.idle(parent, mark)
	childID := waitForChild(t, r.ctx, r.oc, r.work, parent.ID, 60*time.Second)
	listPart := r.hub.toolDone(t, mark, childID, "session_list")

	// The child's session_list tells it where its report goes: the parent's
	// row carries the report note, the bystander's row none.
	var rows []struct {
		SessionID string `json:"sessionId"`
		Note      string `json:"note"`
	}
	if err := json.Unmarshal([]byte(listPart.Output), &rows); err != nil {
		t.Fatalf("session_list output: %v\n%s", err, truncate(listPart.Output, 400))
	}
	byID := map[string]string{}
	for _, row := range rows {
		byID[row.SessionID] = row.Note
	}
	if got := byID[parent.ID]; !strings.Contains(got, "your parent") || !strings.Contains(got, "final message") ||
		!strings.Contains(got, "do not session_send") {
		t.Errorf("the parent's row as the subagent saw it = %q, want the report note", got)
	}
	if got := byID[bystander.ID]; got != "" {
		t.Errorf("the bystander's row carries a note: %q", got)
	}

	// The background child's first turn ends its task, and its result wakes a
	// new turn in the parent — the report channel the fix keeps intact.
	// Anchored on the injected report itself, not on a busy edge: the wake lands
	// within milliseconds of the parent's idle, before a 100ms poll could see it.
	r.hub.wait(t, mark, 240*time.Second, "the child's report in the parent", func(e sessions.Envelope) bool {
		p := e.Event.Part
		return e.SessionID == parent.ID && e.Event.Kind == backend.EventPart && p != nil && p.Type == backend.PartText &&
			p.Synthetic && isSubagentReport(p.Text)
	})

	// Phase two: the child's next prompt sends to the bystander, the turn
	// after the send answers plainly.
	r.script(map[string]any{
		"content": []string{"done"}, "chunkDelayMs": 5, "finishReason": "stop",
		"routes": []map[string]any{
			{"contains": "the first lines of /etc/hosts", "scenario": scenario(nil, "child done")},
			{"contains": "now send it along", "scenario": scenario([]map[string]any{sendCall}, "child done")},
		},
	})
	if err := r.oc.Prompt(r.ctx, r.work, childID, backend.Prompt{Text: "now send it along"}); err != nil {
		t.Fatalf("prompting the child: %v", err)
	}

	// Allow never asks: the child's session_send raises galopin's own ask, which the
	// machine answers once for a root on Allow, so no card reaches anyone and the
	// message is delivered.
	r.hub.wait(t, mark, 60*time.Second, "the message to reach the bystander", func(e sessions.Envelope) bool {
		m := e.Event.Message
		return e.SessionID == bystander.ID && e.Event.Kind == backend.EventMessage &&
			m != nil && m.Role == "user" && m.SentBy != nil && m.SentBy.SessionID == childID
	})
	for _, e := range r.hub.since(mark) {
		if e.Event.Kind == backend.EventPermissionAsked && e.Event.Request != nil && e.Event.Request.Tool == "session_send" {
			t.Errorf("a card was raised for the subagent's send under Allow: %+v", e.Event.Request)
		}
	}
	part := r.hub.toolDone(t, mark, childID, "session_send")
	if out := strings.TrimSpace(part.Output); out != "{}" {
		t.Errorf("the subagent's session_send output = %q, want {}", out)
	}
}
