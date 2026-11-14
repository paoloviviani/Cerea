package opencode

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The unit half of the capability mapping: what Models() reads out of GET
// /api/model. 2.x lists every model flat, with its own `capabilities.input`
// modalities; a model whose entry claims nothing about images stays false (the
// wire's fail-closed answer).
func TestModelsMapsTheImageClaimOffTheModelEntry(t *testing.T) {
	const listed = `{"data":[
	  {"id":"vision-model","modelID":"vision-model","providerID":"pystino","name":"Vision Model","enabled":true,
	   "capabilities":{"tools":true,"input":["text","image"],"output":["text"]},"limit":{"context":1048576,"output":16384},"variants":[]},
	  {"id":"text-model","modelID":"text-model","providerID":"pystino","name":"Text Model","enabled":true,
	   "capabilities":{"tools":true,"input":["text"],"output":["text"]},"variants":[]},
	  {"id":"silent-model","modelID":"silent-model","providerID":"pystino","name":"Silent Model","enabled":true,
	   "capabilities":{"tools":true,"input":[],"output":["text"]},"variants":[]},
	  {"id":"off-model","modelID":"off-model","providerID":"pystino","name":"Off","enabled":false,
	   "capabilities":{"tools":true,"input":["text","image"],"output":["text"]},"variants":[]}
	]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/model":
			_, _ = w.Write([]byte(listed))
		case "/api/model/default":
			_, _ = w.Write([]byte(`{"data":{"id":"vision-model","providerID":"pystino"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	models, err := fakeServerBackend(t, srv).Models(context.Background(), "")
	if err != nil {
		t.Fatalf("Models: %v", err)
	}
	byID := map[string]bool{}
	def := ""
	for _, m := range models {
		byID[m.ID] = m.Images
		if m.IsDefault {
			def = m.ID
		}
	}
	for id, want := range map[string]bool{
		"pystino/vision-model": true,
		"pystino/text-model":   false,
		"pystino/silent-model": false,
	} {
		if got, listed := byID[id]; !listed || got != want {
			t.Errorf("%s images = %v (listed %v), want %v", id, got, listed, want)
		}
	}
	if _, listed := byID["pystino/off-model"]; listed {
		t.Error("a disabled model must not be offered")
	}
	if def != "pystino/vision-model" {
		t.Errorf("default = %q, want pystino/vision-model (GET /api/model/default)", def)
	}
}
