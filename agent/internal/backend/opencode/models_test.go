package opencode

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The unit half of the capability mapping: what Models() reads out of the
// shapes /config/providers serves. The resolved entry is galopin's own
// capture of the pinned opencode's answer for a gateway model the catalogue
// claims takes images (trimmed to the fields the mapping reads); the others
// cover the negative and the legacy shape.
func TestModelsMapsTheImageClaimOffTheResolvedEntry(t *testing.T) {
	const resolved = `{
	  "providers": [
	    {
	      "id": "pystino",
	      "models": {
	        "vision-model": {
	          "name": "Vision Model",
	          "capabilities": {
	            "attachment": true,
	            "input": {"text": true, "image": true},
	            "reasoning": false
	          },
	          "limit": {"context": 1048576, "output": 16384}
	        },
	        "input-only-model": {
	          "name": "Input Only",
	          "capabilities": {"input": {"text": true, "image": true}}
	        },
	        "text-model": {
	          "name": "Text Model",
	          "capabilities": {"attachment": false, "input": {"text": true, "image": false}}
	        },
	        "silent-model": {
	          "name": "Silent Model",
	          "capabilities": {}
	        },
	        "legacy-model": {
	          "name": "Legacy Model",
	          "attachment": {"image": true}
	        }
	      }
	    }
	  ]
	}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/config/providers" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(resolved))
	}))
	t.Cleanup(srv.Close)

	models, err := fakeServerBackend(t, srv).Models(context.Background(), "")
	if err != nil {
		t.Fatalf("Models: %v", err)
	}
	byID := map[string]bool{}
	for _, m := range models {
		byID[m.ID] = m.Images
	}
	for id, want := range map[string]bool{
		"pystino/vision-model":     true,
		"pystino/input-only-model": true,
		"pystino/text-model":       false,
		"pystino/silent-model":     false,
		"pystino/legacy-model":     true,
	} {
		if byID[id] != want {
			t.Errorf("%s images = %v, want %v", id, byID[id], want)
		}
	}
}
