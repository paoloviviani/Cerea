package opencode

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"galopin/internal/backend"
)

// fakeOpencode answers the few endpoints these tests touch, recording the
// last prompt_async body.
func fakeOpencode(t *testing.T) (*Backend, *map[string]any) {
	t.Helper()
	var lastPrompt map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/prompt_async"):
			body, _ := io.ReadAll(r.Body)
			lastPrompt = nil
			_ = json.Unmarshal(body, &lastPrompt)
			w.WriteHeader(http.StatusNoContent)
		case r.URL.Path == "/config/providers":
			_, _ = io.WriteString(w, `{"default":{"pystino":"thinker"},"providers":[{"id":"pystino","models":{
				"thinker":{"name":"Thinker","variants":{"high":{"reasoningEffort":"high"},"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"off":{"disabled":true}}},
				"plain":{"name":"Plain"}}}]}`)
		case strings.HasPrefix(r.URL.Path, "/session/"):
			_, _ = io.WriteString(w, `{"id":"ses_1","title":"t"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ := strconv.Atoi(portStr)
	return New(Config{Hostname: host, Port: port, Password: "x"}), &lastPrompt
}

func TestSetEffortIsSentAsTheVariant(t *testing.T) {
	b, last := fakeOpencode(t)
	ctx := context.Background()
	s, err := b.SetEffort(ctx, "/ws", "ses_1", "high")
	if err != nil {
		t.Fatal(err)
	}
	if s.Effort != "high" {
		t.Errorf("session effort = %q, want high", s.Effort)
	}
	if err := b.Prompt(ctx, "/ws", "ses_1", backend.Prompt{Text: "go"}); err != nil {
		t.Fatal(err)
	}
	if (*last)["variant"] != "high" {
		t.Fatalf("prompt body = %v, want variant high", *last)
	}

	// Cleared: the prompt goes out on the model's default.
	if _, err := b.SetEffort(ctx, "/ws", "ses_1", ""); err != nil {
		t.Fatal(err)
	}
	if err := b.Prompt(ctx, "/ws", "ses_1", backend.Prompt{Text: "go"}); err != nil {
		t.Fatal(err)
	}
	if _, ok := (*last)["variant"]; ok {
		t.Fatalf("prompt body = %v, want no variant once cleared", *last)
	}
}

func TestModelsListTheirEffortsLowToHigh(t *testing.T) {
	b, _ := fakeOpencode(t)
	models, err := b.Models(context.Background(), "/ws")
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]backend.Model{}
	for _, m := range models {
		byID[m.ID] = m
	}
	if got := byID["pystino/thinker"].Efforts; !reflect.DeepEqual(got, []string{"low", "medium", "high"}) {
		t.Errorf("thinker efforts = %v, want low, medium, high (the disabled one dropped)", got)
	}
	if got := byID["pystino/plain"].Efforts; len(got) != 0 {
		t.Errorf("plain efforts = %v, want none", got)
	}
}
