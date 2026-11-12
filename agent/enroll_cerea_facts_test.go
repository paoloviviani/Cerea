package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func factsServer(t *testing.T, body string, status int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/galopin/enroll.json" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

const factsBody = `{"issuer":"https://auth.example.org","gateway":"https://chat.example.org","clientId":"machine-1"}`

func TestFillFromCereaFillsIssuerGatewayAndClientID(t *testing.T) {
	srv := factsServer(t, factsBody, 200)
	opts := &enrollOptions{cerea: srv.URL + "/chat/", clientID: defaultEnrollClientID}
	fillFromCerea(srv.Client(), opts, map[string]bool{"cerea": true})
	if opts.issuer != "https://auth.example.org" || opts.gateway != "https://chat.example.org" || opts.clientID != "machine-1" {
		t.Fatalf("not filled: %+v", opts)
	}
}

func TestFillFromCereaFlagsAndRecordedValuesWin(t *testing.T) {
	srv := factsServer(t, factsBody, 200)
	opts := &enrollOptions{cerea: srv.URL + "/chat", issuer: "https://mine", gateway: "https://gw/v1", clientID: "mine-id"}
	fillFromCerea(srv.Client(), opts, map[string]bool{"client-id": true})
	if opts.issuer != "https://mine" || opts.gateway != "https://gw/v1" || opts.clientID != "mine-id" {
		t.Fatalf("overridden: %+v", opts)
	}
	// An explicit --client-id equal to the default is still the person's.
	opts = &enrollOptions{cerea: srv.URL + "/chat", clientID: defaultEnrollClientID}
	fillFromCerea(srv.Client(), opts, map[string]bool{"client-id": true})
	if opts.clientID != defaultEnrollClientID {
		t.Fatalf("client id overridden: %s", opts.clientID)
	}
}

func TestFillFromCereaConnectorsOnlyTakesNoGateway(t *testing.T) {
	srv := factsServer(t, factsBody, 200)
	opts := &enrollOptions{cerea: srv.URL + "/chat", connectorsOnly: true, clientID: defaultEnrollClientID}
	fillFromCerea(srv.Client(), opts, map[string]bool{})
	if opts.gateway != "" || opts.issuer == "" {
		t.Fatalf("%+v", opts)
	}
}

func TestFillFromCereaFallsBackSilentlyWhenCereaCannotAnswer(t *testing.T) {
	for _, srv := range []*httptest.Server{factsServer(t, "nope", 404), factsServer(t, "not json", 200)} {
		opts := &enrollOptions{cerea: srv.URL + "/chat", clientID: defaultEnrollClientID}
		fillFromCerea(srv.Client(), opts, map[string]bool{})
		if opts.issuer != "" || opts.gateway != "" || opts.clientID != defaultEnrollClientID {
			t.Fatalf("%+v", opts)
		}
	}
	opts := &enrollOptions{cerea: "http://127.0.0.1:1", clientID: defaultEnrollClientID}
	fillFromCerea(&http.Client{}, opts, map[string]bool{})
	if opts.issuer != "" {
		t.Fatal("filled from nowhere")
	}
}
