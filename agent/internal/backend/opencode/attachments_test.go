package opencode

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"galopin/internal/attach"
	"galopin/internal/backend"
)

var tinyPNG = []byte("\x89PNG\r\n\x1a\nrest-of-a-png")

func dataURL(mime string, b []byte) string {
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(b)
}

func toolPartWith(atts ...any) map[string]any {
	return map[string]any{
		"id": "prt1", "messageID": "msg1", "sessionID": "ses1", "type": "tool",
		"callID": "call1", "tool": "playwright_screenshot",
		"state": map[string]any{"status": "completed", "output": "ok", "attachments": atts},
	}
}

func TestMapPartListsImagesByReferenceOnly(t *testing.T) {
	b := New(Config{})
	p := b.mapPart("ses1", toolPartWith(map[string]any{"mime": "image/png", "filename": "shot.png", "url": dataURL("image/png", tinyPNG)}))
	if len(p.Attachments) != 1 {
		t.Fatalf("attachments = %+v", p.Attachments)
	}
	a := p.Attachments[0]
	if a.SHA256 != attach.Sum(tinyPNG) || a.Mime != "image/png" || a.Size != len(tinyPNG) || a.Filename != "shot.png" {
		t.Fatalf("attachment = %+v", a)
	}
	// Bytes stay off the wire: the encoded part carries no data.
	raw, _ := json.Marshal(p)
	if strings.Contains(string(raw), base64.StdEncoding.EncodeToString(tinyPNG)) || strings.Contains(string(raw), "data:") {
		t.Fatalf("part JSON carries image bytes: %s", raw)
	}
}

func TestMapPartRefusesNonRasterAndBadURLs(t *testing.T) {
	b := New(Config{})
	p := b.mapPart("ses1", toolPartWith(
		map[string]any{"mime": "image/svg+xml", "url": dataURL("image/svg+xml", []byte("<svg onload=x/>"))},
		map[string]any{"mime": "image/png", "url": "https://example.com/x.png"},
		map[string]any{"mime": "image/png", "url": "data:image/png,rawnotbase64"},
		map[string]any{"mime": "text/plain", "url": dataURL("text/plain", []byte("hi"))},
		map[string]any{"mime": "image/png", "url": dataURL("image/png", make([]byte, attach.MaxImageBytes+1))},
	))
	if len(p.Attachments) != 0 {
		t.Fatalf("listed %+v", p.Attachments)
	}
}

func TestMapPartCapsPerToolCall(t *testing.T) {
	b := New(Config{})
	var atts []any
	for i := 0; i < attach.MaxPerToolCall+5; i++ {
		atts = append(atts, map[string]any{"mime": "image/png", "url": dataURL("image/png", append([]byte("\x89PNG"), byte(i)))})
	}
	if got := len(b.mapPart("ses1", toolPartWith(atts...)).Attachments); got != attach.MaxPerToolCall {
		t.Fatalf("listed %d, want %d", got, attach.MaxPerToolCall)
	}
}

func TestAttachmentServesOnlyTheOwningSession(t *testing.T) {
	b := New(Config{})
	p := b.mapPart("ses1", toolPartWith(map[string]any{"mime": "image/png", "url": dataURL("image/png", tinyPNG)}))
	sha := p.Attachments[0].SHA256
	mime, data, err := b.Attachment(context.Background(), "", "ses1", sha)
	if err != nil || mime != "image/png" || string(data) != string(tinyPNG) {
		t.Fatalf("owner: %q %v", mime, err)
	}
	if _, _, err := b.Attachment(context.Background(), "", "ses2", sha); !errors.Is(err, backend.ErrAttachmentUnknown) {
		t.Fatalf("another session must not read it: %v", err)
	}
	if _, _, err := b.Attachment(context.Background(), "", "ses1", strings.Repeat("0", 64)); !errors.Is(err, backend.ErrAttachmentUnknown) {
		t.Fatalf("unlisted sha: %v", err)
	}
}

// An evicted image is re-read from opencode's own message, by the message and
// part the reference remembers.
func TestAttachmentRereadsAfterEviction(t *testing.T) {
	msgHits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/session/ses1/message/msg1" {
			http.NotFound(w, r)
			return
		}
		msgHits++
		_ = json.NewEncoder(w).Encode(map[string]any{
			"info": map[string]any{"id": "msg1"},
			"parts": []any{
				map[string]any{"id": "other", "type": "text"},
				toolPartWith(map[string]any{"mime": "image/png", "url": dataURL("image/png", tinyPNG)}),
			},
		})
	}))
	defer srv.Close()
	b := fakeServerBackend(t, srv)
	b.att = attach.New(int64(len(tinyPNG)) + 1) // room for exactly one image
	p := b.mapPart("ses1", toolPartWith(map[string]any{"mime": "image/png", "url": dataURL("image/png", tinyPNG)}))
	sha := p.Attachments[0].SHA256
	// A second image evicts the first.
	b.mapPart("ses1", map[string]any{"id": "prt2", "messageID": "msg2", "type": "tool", "callID": "c2",
		"state": map[string]any{"status": "completed", "attachments": []any{map[string]any{"mime": "image/png", "url": dataURL("image/png", append([]byte("\x89PNG"), 9))}}}})
	if _, data, ok := b.att.Get("ses1", sha); ok || data != nil {
		t.Fatal("first image should be evicted")
	}
	_, data, err := b.Attachment(context.Background(), "", "ses1", sha)
	if err != nil || string(data) != string(tinyPNG) || msgHits != 1 {
		t.Fatalf("re-read: %v hits=%d", err, msgHits)
	}
}

func TestAttachmentGoneWhenOpencodeNoLongerHasIt(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) }))
	defer srv.Close()
	b := fakeServerBackend(t, srv)
	b.att = attach.New(int64(len(tinyPNG)) + 1)
	p := b.mapPart("ses1", toolPartWith(map[string]any{"mime": "image/png", "url": dataURL("image/png", tinyPNG)}))
	b.mapPart("ses1", map[string]any{"id": "prt2", "messageID": "msg2", "type": "tool", "callID": "c2",
		"state": map[string]any{"status": "completed", "attachments": []any{map[string]any{"mime": "image/png", "url": dataURL("image/png", append([]byte("\x89PNG"), 9))}}}})
	if _, _, err := b.Attachment(context.Background(), "", "ses1", p.Attachments[0].SHA256); !errors.Is(err, backend.ErrAttachmentGone) {
		t.Fatalf("err = %v", err)
	}
}

func TestToolImagesCapabilityAdvertised(t *testing.T) {
	if !New(Config{}).Capabilities().ToolImages {
		t.Fatal("opencode must advertise toolImages")
	}
}

func fakeServerBackend(t *testing.T, srv *httptest.Server) *Backend {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ := strconv.Atoi(portStr)
	return New(Config{Hostname: host, Port: port, Password: "x"})
}
