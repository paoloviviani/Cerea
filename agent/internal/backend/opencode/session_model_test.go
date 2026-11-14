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
	// newest first, as the server answers order=desc
	messages := `{"data":[{"id":"msg_3","type":"assistant","model":{"providerID":"cortecs","id":"glm-5.3-flash"},"content":[],"time":{"created":3}},
		{"id":"msg_2","type":"assistant","model":{"providerID":"older","id":"older-model"},"content":[],"time":{"created":2}},
		{"id":"msg_1","type":"user","text":"x","time":{"created":1}}],"cursor":{}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/session/ses_child":
			_, _ = w.Write([]byte(`{"data":{"id":"ses_child","parentID":"ses_root","title":"t","agent":"general","location":{"directory":"/ws"}}}`))
		case r.URL.Path == "/api/session/ses_root":
			_, _ = w.Write([]byte(`{"data":{"id":"ses_root","title":"root","location":{"directory":"/ws"}}}`))
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
