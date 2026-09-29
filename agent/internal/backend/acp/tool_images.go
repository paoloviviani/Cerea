package acp

import (
	"context"
	"encoding/base64"
	"strings"

	"galopin/internal/attach"
	"galopin/internal/backend"
)

var _ backend.AttachmentSource = (*Backend)(nil)

// toolImages lifts the image content items of a tool_call / tool_call_update
// ({content:[{type:"content",content:{type:"image",data,mimeType}}]}) into the
// store, returning the by-reference list the wire part carries.
func (b *Backend) toolImages(sessionID string, upd map[string]any) (out []backend.ToolAttachment, omitted int) {
	for _, c := range asMaps(getSlice(upd, "content")) {
		inner := getMap(c, "content")
		if inner == nil {
			inner = c
		}
		if getStr(inner, "type") != "image" {
			continue
		}
		if len(out) >= attach.MaxPerToolCall {
			omitted++
			continue
		}
		mime := strings.ToLower(getStr(inner, "mimeType", "mime"))
		switch mime {
		case "image/png", "image/jpeg", "image/gif", "image/webp":
		default:
			omitted++
			continue
		}
		data, err := base64.StdEncoding.DecodeString(getStr(inner, "data"))
		if err != nil {
			omitted++
			continue
		}
		ref, ok := b.att.Put(sessionID, attach.Ref{Mime: mime}, data)
		if !ok {
			omitted++
			continue
		}
		out = append(out, backend.ToolAttachment{SHA256: ref.SHA256, Mime: ref.Mime, Size: ref.Size})
	}
	return out, omitted
}

// Attachment serves a listed image from memory. ACP cannot be asked for it
// again, so anything not held — evicted, or lost with a galopin restart —
// is gone, and a sha this session never listed is indistinguishable from one.
func (b *Backend) Attachment(_ context.Context, _ string, sessionID, sha string) (string, []byte, error) {
	ref, data, ok := b.att.Get(sessionID, sha)
	if !ok || data == nil {
		return "", nil, backend.ErrAttachmentGone
	}
	return ref.Mime, data, nil
}
