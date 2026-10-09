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

// compactFake answers the endpoints Compact's model lookup touches,
// recording the last summarize body and how often it was hit. messages and
// config are the JSON bodies answered for GET /session/:id/message and
// GET /config; the config body always answers a distinctive model, so a
// test seeing it knows the earlier sources came up empty.
func compactFake(t *testing.T, messages, config string) (*Backend, *map[string]any, *int) {
	t.Helper()
	var lastSummarize map[string]any
	summarizeHits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/summarize"):
			body, _ := io.ReadAll(r.Body)
			lastSummarize = nil
			_ = json.Unmarshal(body, &lastSummarize)
			summarizeHits++
			w.WriteHeader(http.StatusNoContent)
		case strings.HasSuffix(r.URL.Path, "/message"):
			_, _ = io.WriteString(w, messages)
		case r.URL.Path == "/config":
			_, _ = io.WriteString(w, config)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ := strconv.Atoi(portStr)
	return New(Config{Hostname: host, Port: port, Password: "x"}), &lastSummarize, &summarizeHits
}

// assertSummarizeBody pins the wire shape Compact owes opencode (found live
// on 1.18.34: providerID and modelID are required, and auto:false is what
// marks a person's "Compact now").
func assertSummarizeBody(t *testing.T, last *map[string]any, providerID, modelID string) {
	t.Helper()
	if got, _ := (*last)["providerID"].(string); got != providerID {
		t.Errorf("summarize body providerID = %q, want %q", got, providerID)
	}
	if got, _ := (*last)["modelID"].(string); got != modelID {
		t.Errorf("summarize body modelID = %q, want %q", got, modelID)
	}
	if got, ok := (*last)["auto"]; !ok || got != false {
		t.Errorf("summarize body auto = %v, want the field present as false", got)
	}
}

func TestCompactPicksTheModel(t *testing.T) {
	ctx := context.Background()

	t.Run("the session overlay's model, like prompts use", func(t *testing.T) {
		// No message names a model and no config default answers: only the
		// overlay can explain a pass here.
		b, last, _ := compactFake(t, `[]`, `{}`)
		if err := b.setOverlay("ses_1", sessionOverlay{ModelID: "prov/overlay-model"}); err != nil {
			t.Fatal(err)
		}
		if err := b.Compact(ctx, "/ws", "ses_1"); err != nil {
			t.Fatal(err)
		}
		assertSummarizeBody(t, last, "prov", "overlay-model")
	})

	t.Run("else the most recent assistant message's model", func(t *testing.T) {
		// Two assistant messages: the newest one's model must win. The
		// config default would fail the assertion, so an overlay-less body
		// proves the message source answered.
		messages := `[{"info":{"id":"msg_1","role":"user"},"parts":[]},
			{"info":{"id":"msg_2","role":"assistant","providerID":"older","modelID":"older-model"},"parts":[]},
			{"info":{"id":"msg_3","role":"assistant","providerID":"newer","modelID":"newer-model"},"parts":[]}]`
		b, last, _ := compactFake(t, messages, `{"model":"cfg/cfg-model"}`)
		if err := b.Compact(ctx, "/ws", "ses_1"); err != nil {
			t.Fatal(err)
		}
		assertSummarizeBody(t, last, "newer", "newer-model")
	})

	t.Run("else opencode's configured default model", func(t *testing.T) {
		b, last, _ := compactFake(t, `[]`, `{"model":"cfgprov/cfg-model"}`)
		if err := b.Compact(ctx, "/ws", "ses_1"); err != nil {
			t.Fatal(err)
		}
		assertSummarizeBody(t, last, "cfgprov", "cfg-model")
	})
}

// TestCompactWithoutAnyKnownModelIsRefusedLocally: rather than post a body
// opencode is known to refuse with 400 {"kind":"Payload"}, Compact says what
// a person can do about it and never leaves the process.
func TestCompactWithoutAnyKnownModelIsRefusedLocally(t *testing.T) {
	// A transcript whose assistant messages name no model, and a config with
	// no default: nothing is known.
	messages := `[{"info":{"id":"msg_1","role":"user"},"parts":[]},
		{"info":{"id":"msg_2","role":"assistant"},"parts":[]}]`
	b, _, hits := compactFake(t, messages, `{}`)
	err := b.Compact(context.Background(), "/ws", "ses_1")
	if err == nil {
		t.Fatal("Compact succeeded with no model known, want a clear error")
	}
	if !strings.Contains(err.Error(), "no model known for this session") {
		t.Errorf("error = %v, want the actionable no-model message", err)
	}
	if *hits != 0 {
		t.Errorf("summarize was hit %d times, want none", *hits)
	}
}
