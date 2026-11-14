package opencode

import (
	"testing"
)

// A subagent's report is a synthetic message opencode injects into its parent;
// it must reach the transcript as an automatic message, never as the user's
// prompt, and a galopin preface must fold into the next user message instead.
func TestAdaptSubagentReportIsASyntheticMessage(t *testing.T) {
	st := newAsmState()
	st.isPreface = func(id string) bool { return id == "msg_pref" }
	st.adapt("session.inbox.enqueued", 1, map[string]any{"sessionID": "ses_p", "inboxID": "msg_rep",
		"item": map[string]any{"type": "synthetic", "payload": map[string]any{"text": `<subagent sessionID="ses_c" state="completed">done</subagent>`}}})
	frames := st.adapt("session.inbox.delivered", 2, map[string]any{"sessionID": "ses_p", "inboxID": "msg_rep"})
	if len(frames) != 2 || frames[0].typ != "message.updated" || frames[1].typ != "message.part.updated" {
		t.Fatalf("frames = %+v, want the message and one part", frames)
	}
	part := frames[1].props["part"].(map[string]any)
	if part["synthetic"] != true || part["text"] == "" {
		t.Errorf("part = %v, want a synthetic text part", part)
	}

	st.adapt("session.inbox.enqueued", 3, map[string]any{"sessionID": "ses_p", "inboxID": "msg_pref",
		"item": map[string]any{"type": "synthetic", "payload": map[string]any{"text": "[preface]"}}})
	if f := st.adapt("session.inbox.delivered", 4, map[string]any{"sessionID": "ses_p", "inboxID": "msg_pref"}); len(f) != 0 {
		t.Errorf("a preface announced %d frames on its own, want none", len(f))
	}
	st.adapt("session.inbox.enqueued", 5, map[string]any{"sessionID": "ses_p", "inboxID": "msg_u",
		"item": map[string]any{"type": "user", "payload": map[string]any{"text": "hello"}}})
	frames = st.adapt("session.inbox.delivered", 6, map[string]any{"sessionID": "ses_p", "inboxID": "msg_u"})
	if len(frames) != 3 {
		t.Fatalf("user frames = %d, want message + synthetic preface + text", len(frames))
	}
	if frames[1].props["part"].(map[string]any)["synthetic"] != true || frames[2].props["part"].(map[string]any)["text"] != "hello" {
		t.Errorf("preface not folded ahead of the text: %+v", frames)
	}
}

// The tool call that starts a child names it in its metadata, which links the
// panel's row to the child session.
func TestAdaptSubagentToolLinksTheChild(t *testing.T) {
	st := newAsmState()
	st.adapt("session.tool.input.started", 1, map[string]any{"sessionID": "ses_p", "assistantMessageID": "m1", "id": "c1", "name": "subagent"})
	f := st.adapt("session.tool.success", 2, map[string]any{"sessionID": "ses_p", "assistantMessageID": "m1", "id": "c1",
		"content":  []any{map[string]any{"type": "text", "text": "working in the background"}},
		"metadata": map[string]any{"sessionID": "ses_c", "status": "running"}})
	p := partFromMap(f[0].props["part"].(map[string]any))
	if p.Tool != "task" || p.SubtaskSessionID != "ses_c" {
		t.Errorf("part = tool %q child %q, want task linked to ses_c", p.Tool, p.SubtaskSessionID)
	}
}
