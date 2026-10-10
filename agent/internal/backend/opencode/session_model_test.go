package opencode

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A subagent runs on its parent's model and has no model of its own in
// opencode's session object or galopin's overlay: session.get must say what
// it actually ran on (its newest assistant message's), not leave it empty —
// an empty modelId made the panel name the machine's default model for it.
// A top-level session with no explicit choice still reports none.
func TestGetSessionReportsTheModelASubagentRunsOn(t *testing.T) {
	messages := `[{"info":{"id":"msg_1","role":"user"},"parts":[]},
		{"info":{"id":"msg_2","role":"assistant","providerID":"older","modelID":"older-model"},"parts":[]},
		{"info":{"id":"msg_3","role":"assistant","providerID":"cortecs","modelID":"glm-5.3-flash"},"parts":[]}]`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/session/ses_child":
			_, _ = w.Write([]byte(`{"id":"ses_child","parentID":"ses_root","title":"t (@general subagent)","directory":"/ws"}`))
		case r.URL.Path == "/session/ses_root":
			_, _ = w.Write([]byte(`{"id":"ses_root","title":"root","directory":"/ws"}`))
		case strings.HasSuffix(r.URL.Path, "/message"):
			_, _ = w.Write([]byte(messages))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	b := fakeServerBackend(t, srv)
	ctx := context.Background()

	child, err := b.GetSession(ctx, "/ws", "ses_child")
	if err != nil {
		t.Fatal(err)
	}
	if child.ModelID != "cortecs/glm-5.3-flash" {
		t.Errorf("subagent modelId = %q, want its newest assistant message's model", child.ModelID)
	}

	// The event stream's answer wins once one is seen.
	b.noteSessionModel("ses_child", map[string]any{"providerID": "pystino", "modelID": "glm-5.3"})
	if child, _ = b.GetSession(ctx, "/ws", "ses_child"); child.ModelID != "pystino/glm-5.3" {
		t.Errorf("subagent modelId after a message event = %q, want pystino/glm-5.3", child.ModelID)
	}

	root, err := b.GetSession(ctx, "/ws", "ses_root")
	if err != nil {
		t.Fatal(err)
	}
	if root.ModelID != "" {
		t.Errorf("a top-level session nobody chose a model for reports %q, want none", root.ModelID)
	}
}
