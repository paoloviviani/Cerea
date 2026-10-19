package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// The gateway filters /v1/models by the x-bill-to group (A): a pinned group
// must be sent so enroll and 'models refresh' list the models that group can
// actually reach — not the default group's — and in follow-default mode the
// header must be absent, so the list follows the default exactly as billing
// does. An empty header value would filter to nothing, which is why absent
// is the only way to say "the default".
func TestFetchModelsSendsTheBillingGroup(t *testing.T) {
	var mu sync.Mutex
	var saw []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		saw = append(saw, r.Header.Get("x-bill-to"))
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []gatewayModel{{ID: "m1", DisplayName: "Model One"}},
		})
	}))
	defer server.Close()

	models := fetchModels(context.Background(), server.URL, "at", "team")
	if len(models) != 1 || models[0].ID != "m1" {
		t.Fatalf("fetchModels with a group = %+v", models)
	}
	mu.Lock()
	if len(saw) != 1 || saw[0] != "team" {
		t.Fatalf("x-bill-to seen = %q, want exactly one request carrying team", saw)
	}
	saw = nil
	mu.Unlock()

	fetchModels(context.Background(), server.URL, "at", "")
	mu.Lock()
	defer mu.Unlock()
	if len(saw) != 1 || saw[0] != "" {
		t.Fatalf("x-bill-to without a group = %q, want the header absent (an empty value would filter to nothing)", saw)
	}
}
