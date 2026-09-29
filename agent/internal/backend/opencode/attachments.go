package opencode

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"galopin/internal/attach"
	"galopin/internal/backend"
)

// A tool part's completed state carries `attachments`: FilePart objects whose
// url is a data: URL — where an MCP browser tool's screenshot lands (verified
// against 1.18.32's GET /doc, ToolStateCompleted). partFromMap stays pure;
// mapPart is the stateful step that moves the bytes into the store and leaves
// only {sha256, mime, size} on the part.

// rasterMime is what galopin lists at all. Cerea re-checks the bytes itself
// (it never trusts a claimed mime); this only keeps non-images off the list.
func rasterMime(m string) bool {
	switch m {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return true
	}
	return false
}

// mapPart is partFromMap plus the tool-image step, for the sessionID the
// part belongs to.
func (b *Backend) mapPart(sessionID string, m map[string]any) backend.Part {
	p := partFromMap(m)
	if p.Type == backend.PartTool {
		b.absorbToolImages(sessionID, m, &p)
	}
	return p
}

func (b *Backend) absorbToolImages(sessionID string, m map[string]any, p *backend.Part) {
	state := getMap(m, "state")
	if state == nil {
		return
	}
	for i, am := range asMaps(getSlice(state, "attachments")) {
		url := getStr(am, "url")
		if !strings.HasPrefix(getStr(am, "mime"), "image/") && !strings.HasPrefix(url, "data:image/") {
			continue // not an image at all: not counted as a dropped one
		}
		if len(p.Attachments) >= attach.MaxPerToolCall {
			p.AttachmentsOmitted++
			continue
		}
		// A snapshot re-maps every part: an image already held is recognised
		// by where it came from and neither decoded nor hashed again.
		source := fmt.Sprintf("%s/%s/%d/%d/%s", p.MessageID, p.ID, i, len(url), urlEnds(url))
		ref, ok := b.att.BySource(sessionID, source)
		if !ok {
			mime, data, parsed := attach.ParseDataURL(url)
			if !parsed || !rasterMime(mime) {
				p.AttachmentsOmitted++
				continue
			}
			ref, ok = b.att.Put(sessionID, attach.Ref{
				Mime: mime, Filename: getStr(am, "filename"), Source: source,
				MessageID: p.MessageID, PartID: p.ID, CallID: p.CallID,
			}, data)
			if !ok {
				p.AttachmentsOmitted++
				continue
			}
		}
		p.Attachments = append(p.Attachments, backend.ToolAttachment{
			SHA256: ref.SHA256, Mime: ref.Mime, Size: ref.Size, Filename: ref.Filename,
		})
	}
}

// urlEnds is a cheap fingerprint of a long URL's head and tail.
func urlEnds(u string) string {
	if len(u) <= 96 {
		return u
	}
	return u[:48] + "…" + u[len(u)-48:]
}

// Attachment serves a listed image. Held bytes answer at once; an evicted one
// is re-read from opencode's own transcript (the message it came from), which
// re-mapping puts back in the store. Nothing the session never listed is
// served, whatever the store holds for other sessions.
func (b *Backend) Attachment(ctx context.Context, _ string, sessionID, sha string) (string, []byte, error) {
	ref, data, ok := b.att.Get(sessionID, sha)
	if ok {
		return ref.Mime, data, nil
	}
	if _, known := b.att.Ref(sessionID, sha); !known {
		return "", nil, backend.ErrAttachmentUnknown
	}
	ref, _ = b.att.Ref(sessionID, sha)
	if ref.MessageID == "" {
		return "", nil, backend.ErrAttachmentGone
	}
	var msg map[string]any
	path := "/session/" + url.PathEscape(sessionID) + "/message/" + url.PathEscape(ref.MessageID)
	if err := b.doJSONLimit(ctx, http.MethodGet, path, nil, &msg, maxTranscriptBytes); err != nil {
		return "", nil, backend.ErrAttachmentGone
	}
	for _, pm := range asMaps(getSlice(msg, "parts")) {
		if strings.EqualFold(getStr(pm, "type"), "tool") && getStr(pm, "id") == ref.PartID {
			b.mapPart(sessionID, pm)
		}
	}
	ref, data, ok = b.att.Get(sessionID, sha)
	if !ok || data == nil {
		return "", nil, backend.ErrAttachmentGone
	}
	return ref.Mime, data, nil
}

// ForgetAttachments drops a deleted session's image references.
func (b *Backend) ForgetAttachments(sessionID string) { b.att.Forget(sessionID) }
