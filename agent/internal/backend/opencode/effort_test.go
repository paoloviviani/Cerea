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
// last model selection written to the session (2.x keeps the variant on the
// session's model, not on the prompt).
func fakeOpencode(t *testing.T) (*Backend, *map[string]any) {
	t.Helper()
	var lastModel map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/model"):
			body, _ := io.ReadAll(r.Body)
			lastModel = nil
			_ = json.Unmarshal(body, &lastModel)
			w.WriteHeader(http.StatusNoContent)
		case strings.HasSuffix(r.URL.Path, "/prompt") && r.Method == http.MethodPost:
			_, _ = io.WriteString(w, `{"data":{}}`)
		case r.URL.Path == "/api/model":
			_, _ = io.WriteString(w, `{"data":[
				{"id":"thinker","modelID":"thinker","providerID":"pystino","name":"Thinker","enabled":true,"capabilities":{"tools":true,"input":["text"],"output":["text"]},
				 "variants":[{"id":"high"},{"id":"low"},{"id":"medium"},{"id":"off","disabled":true}]},
				{"id":"plain","modelID":"plain","providerID":"pystino","name":"Plain","enabled":true,"capabilities":{"tools":true,"input":["text"],"output":["text"]},"variants":[]}]}`)
		case r.URL.Path == "/api/model/default":
			_, _ = io.WriteString(w, `{"data":{"id":"thinker","providerID":"pystino"}}`)
		case strings.HasPrefix(r.URL.Path, "/api/session/"):
			_, _ = io.WriteString(w, `{"data":{"id":"ses_1","title":"t"}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ := strconv.Atoi(portStr)
	return New(Config{Hostname: host, Port: port, Password: "x"}), &lastModel
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
	ref, _ := (*last)["model"].(map[string]any)
	if ref["variant"] != "high" || ref["id"] != "thinker" || ref["providerID"] != "pystino" {
		t.Fatalf("model selection = %v, want the default model with variant high", *last)
	}

	// Cleared: the prompt goes out on the model's default.
	if _, err := b.SetEffort(ctx, "/ws", "ses_1", ""); err != nil {
		t.Fatal(err)
	}
	if err := b.Prompt(ctx, "/ws", "ses_1", backend.Prompt{Text: "go"}); err != nil {
		t.Fatal(err)
	}
	ref, _ = (*last)["model"].(map[string]any)
	if _, ok := ref["variant"]; ok {
		t.Fatalf("model selection = %v, want no variant once cleared", *last)
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
