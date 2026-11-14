package opencode

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// compactFake records the calls Compact makes: the session's model selection
// (POST .../model) and the compaction itself (POST .../compact), in order.
func compactFake(t *testing.T) (*Backend, *[]string, *[]map[string]any) {
	t.Helper()
	var calls []string
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var parsed map[string]any
		_ = json.Unmarshal(body, &parsed)
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/compact"):
			calls = append(calls, "compact")
			bodies = append(bodies, parsed)
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/model"):
			calls = append(calls, "model")
			bodies = append(bodies, parsed)
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ := strconv.Atoi(portStr)
	return New(Config{Hostname: host, Port: port, Password: "x"}), &calls, &bodies
}

// 2.x compacts on the session's own model, and answers 204 to a bare POST:
// there is no body to get wrong (1.x answered 400 without a model).
func TestCompactPostsToTheSessionsCompactRoute(t *testing.T) {
	b, calls, _ := compactFake(t)
	if err := b.Compact(context.Background(), "/ws", "ses_1"); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0] != "compact" {
		t.Errorf("calls = %v, want exactly one compact", *calls)
	}
}

// A session whose overlay picked a model compacts on THAT model: the choice is
// written to the session first, then the compaction runs.
func TestCompactWritesTheOverlayModelFirst(t *testing.T) {
	b, calls, bodies := compactFake(t)
	if err := b.setOverlay("ses_1", sessionOverlay{ModelID: "prov/overlay-model", Effort: "high"}); err != nil {
		t.Fatal(err)
	}
	if err := b.Compact(context.Background(), "/ws", "ses_1"); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 2 || (*calls)[0] != "model" || (*calls)[1] != "compact" {
		t.Fatalf("calls = %v, want model then compact", *calls)
	}
	ref, _ := (*bodies)[0]["model"].(map[string]any)
	if ref["providerID"] != "prov" || ref["id"] != "overlay-model" || ref["variant"] != "high" {
		t.Errorf("model body = %v, want prov/overlay-model#high", ref)
	}
	// compacting again re-writes nothing: the selection is already applied
	if err := b.Compact(context.Background(), "/ws", "ses_1"); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 3 || (*calls)[2] != "compact" {
		t.Errorf("calls = %v, want only a second compact", *calls)
	}
}
