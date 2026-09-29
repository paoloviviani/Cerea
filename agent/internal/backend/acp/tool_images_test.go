package acp

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"galopin/internal/attach"
	"galopin/internal/backend"
)

// An image content item on a tool_call_update becomes a by-reference
// attachment on the tool part, and a later update repeating the call without
// content does not erase it.
func TestToolCallImageBecomesAttachment(t *testing.T) {
	b, fa := newTestBackend(t)
	ctx := context.Background()
	dir := "/work"
	sess, err := b.CreateSession(ctx, dir, backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	events, _ := b.Subscribe(ctx)
	if err := b.Prompt(ctx, dir, sess.ID, backend.Prompt{Text: "shoot"}); err != nil {
		t.Fatal(err)
	}
	pr := <-fa.promptReqs

	png := []byte("\x89PNG\r\n\x1a\nxx")
	fa.update(pr.sessionID, map[string]any{
		"sessionUpdate": "tool_call_update", "toolCallId": "c1", "kind": "other", "status": "completed",
		"content": []any{
			map[string]any{"type": "content", "content": map[string]any{"type": "text", "text": "done"}},
			map[string]any{"type": "content", "content": map[string]any{"type": "image", "mimeType": "image/png", "data": base64.StdEncoding.EncodeToString(png)}},
			map[string]any{"type": "content", "content": map[string]any{"type": "image", "mimeType": "image/svg+xml", "data": base64.StdEncoding.EncodeToString([]byte("<svg/>"))}},
		},
	})
	got := drainEvents(t, events, sess.ID, 5*time.Second, func(ev backend.Event) bool {
		return ev.Kind == backend.EventPart && ev.Part != nil && len(ev.Part.Attachments) > 0
	})
	part := got[len(got)-1].Part
	if len(part.Attachments) != 1 || part.Attachments[0].SHA256 != attach.Sum(png) || part.Attachments[0].Mime != "image/png" {
		t.Fatalf("attachments = %+v", part.Attachments)
	}

	mime, data, err := b.Attachment(ctx, dir, sess.ID, part.Attachments[0].SHA256)
	if err != nil || mime != "image/png" || string(data) != string(png) {
		t.Fatalf("Attachment: %q %v", mime, err)
	}
	if _, _, err := b.Attachment(ctx, dir, "another-session", part.Attachments[0].SHA256); !errors.Is(err, backend.ErrAttachmentGone) {
		t.Fatalf("another session: %v", err)
	}

	// A bare repeat of the call keeps the images.
	fa.update(pr.sessionID, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed"})
	fa.respond(pr.id, map[string]any{"stopReason": "end_turn"})
	drainEvents(t, events, sess.ID, 5*time.Second, isIdle)
	tr, err := b.Transcript(ctx, dir, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range tr.Messages {
		for _, p := range e.Parts {
			if p.CallID == "c1" && len(p.Attachments) == 1 {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("attachments lost from the transcript after a bare update")
	}
}

func TestACPAttachmentGoneWhenNotHeld(t *testing.T) {
	b := New(Config{})
	if _, _, err := b.Attachment(context.Background(), "", "s", attach.Sum([]byte("x"))); !errors.Is(err, backend.ErrAttachmentGone) {
		t.Fatalf("err = %v", err)
	}
	if !b.Capabilities().ToolImages {
		t.Fatal("ACP must advertise toolImages")
	}
}
