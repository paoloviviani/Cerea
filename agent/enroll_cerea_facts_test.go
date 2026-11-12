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

var yes = func(string) bool { return true }

const factsBody = `{"issuer":"https://auth.example.org","gateway":"https://chat.example.org","clientId":"machine-1"}`

func TestFillFromCereaFillsIssuerGatewayAndClientID(t *testing.T) {
	srv := factsServer(t, factsBody, 200)
	opts := &enrollOptions{cerea: srv.URL + "/chat/", clientID: defaultEnrollClientID}
	_ = fillFromCerea(srv.Client(), opts, map[string]bool{"cerea": true}, yes)
	if opts.issuer != "https://auth.example.org" || opts.gateway != "https://chat.example.org" || opts.clientID != "machine-1" {
		t.Fatalf("not filled: %+v", opts)
	}
}

func TestFillFromCereaFlagsAndRecordedValuesWin(t *testing.T) {
	srv := factsServer(t, factsBody, 200)
	opts := &enrollOptions{cerea: srv.URL + "/chat", issuer: "https://mine", gateway: "https://gw/v1", clientID: "mine-id"}
	_ = fillFromCerea(srv.Client(), opts, map[string]bool{"client-id": true}, yes)
	if opts.issuer != "https://mine" || opts.gateway != "https://gw/v1" || opts.clientID != "mine-id" {
		t.Fatalf("overridden: %+v", opts)
	}
	// An explicit --client-id equal to the default is still the person's.
	opts = &enrollOptions{cerea: srv.URL + "/chat", clientID: defaultEnrollClientID}
	_ = fillFromCerea(srv.Client(), opts, map[string]bool{"client-id": true}, yes)
	if opts.clientID != defaultEnrollClientID {
		t.Fatalf("client id overridden: %s", opts.clientID)
	}
}

func TestFillFromCereaConnectorsOnlyTakesNoGateway(t *testing.T) {
	srv := factsServer(t, factsBody, 200)
	opts := &enrollOptions{cerea: srv.URL + "/chat", connectorsOnly: true, clientID: defaultEnrollClientID}
	_ = fillFromCerea(srv.Client(), opts, map[string]bool{}, yes)
	if opts.gateway != "" || opts.issuer == "" {
		t.Fatalf("%+v", opts)
	}
}

func TestFillFromCereaFallsBackSilentlyWhenCereaCannotAnswer(t *testing.T) {
	for _, srv := range []*httptest.Server{factsServer(t, "nope", 404), factsServer(t, "not json", 200)} {
		opts := &enrollOptions{cerea: srv.URL + "/chat", clientID: defaultEnrollClientID}
		_ = fillFromCerea(srv.Client(), opts, map[string]bool{}, yes)
		if opts.issuer != "" || opts.gateway != "" || opts.clientID != defaultEnrollClientID {
			t.Fatalf("%+v", opts)
		}
	}
	opts := &enrollOptions{cerea: "http://127.0.0.1:1", clientID: defaultEnrollClientID}
	_ = fillFromCerea(&http.Client{}, opts, map[string]bool{}, yes)
	if opts.issuer != "" {
		t.Fatal("filled from nowhere")
	}
}

func TestFillFromCereaNeedsHTTPSExceptLoopback(t *testing.T) {
	hit := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		_, _ = w.Write([]byte(factsBody))
	}))
	defer srv.Close()
	// A plain-http address that is not loopback is never asked.
	opts := &enrollOptions{cerea: "http://cerea.example.org", clientID: defaultEnrollClientID}
	if err := fillFromCerea(srv.Client(), opts, map[string]bool{}, yes); err != nil || opts.issuer != "" {
		t.Fatalf("filled from http: %v %+v", err, opts)
	}
	// Loopback http is a development stack: allowed.
	opts = &enrollOptions{cerea: srv.URL, clientID: defaultEnrollClientID}
	_ = fillFromCerea(srv.Client(), opts, map[string]bool{}, yes)
	if !hit {
		t.Fatal("loopback http was not asked")
	}
}

func TestFillFromCereaRefusesACrossOriginRedirect(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(factsBody))
	}))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/galopin/enroll.json", http.StatusFound)
	}))
	defer srv.Close()
	opts := &enrollOptions{cerea: srv.URL, clientID: defaultEnrollClientID}
	_ = fillFromCerea(srv.Client(), opts, map[string]bool{}, yes)
	if opts.issuer != "" || opts.clientID != defaultEnrollClientID {
		t.Fatalf("followed a cross-origin redirect: %+v", opts)
	}
}

func TestFillFromCereaIgnoresNonHTTPSIssuerAndGateway(t *testing.T) {
	srv := factsServer(t, `{"issuer":"http://auth.example.org","gateway":"ftp://gw.example.org","clientId":"machine-1"}`, 200)
	opts := &enrollOptions{cerea: srv.URL + "/chat", clientID: defaultEnrollClientID}
	if err := fillFromCerea(srv.Client(), opts, map[string]bool{}, yes); err != nil {
		t.Fatal(err)
	}
	if opts.issuer != "" || opts.gateway != "" {
		t.Fatalf("used an insecure address: %+v", opts)
	}
	if opts.clientID != "machine-1" {
		t.Fatalf("client id not filled: %+v", opts)
	}
}

func TestFillFromCereaAsksBeforeUsingAnotherDomain(t *testing.T) {
	// Loopback http for the issuer keeps the test off the network; the registrable-domain check is
	// exercised directly below with real names.
	srv := factsServer(t, `{"issuer":"https://login.attacker.test","gateway":"https://llm.attacker.test"}`, 200)
	for name, answer := range map[string]bool{"declined": false, "accepted": true} {
		var asked string
		opts := &enrollOptions{cerea: srv.URL + "/chat", clientID: defaultEnrollClientID}
		err := fillFromCerea(srv.Client(), opts, map[string]bool{}, func(p string) bool {
			asked = p
			return answer
		})
		if asked == "" {
			t.Fatalf("%s: no question asked", name)
		}
		if answer && (err != nil || opts.issuer == "") {
			t.Fatalf("accepted but not used: %v %+v", err, opts)
		}
		if !answer && (err == nil || opts.issuer != "" || opts.gateway != "") {
			t.Fatalf("declined but used: %v %+v", err, opts)
		}
	}
	// On its own domain it does not ask.
	own := factsServer(t, `{"issuer":"https://127.0.0.1/auth"}`, 200)
	opts := &enrollOptions{cerea: own.URL + "/chat", clientID: defaultEnrollClientID}
	err := fillFromCerea(own.Client(), opts, map[string]bool{}, func(string) bool {
		t.Fatal("asked about the base's own domain")
		return false
	})
	if err != nil || opts.issuer != "https://127.0.0.1/auth" {
		t.Fatalf("%v %+v", err, opts)
	}
}

func TestRegistrableDomain(t *testing.T) {
	cases := map[string]string{
		"idp.example.org":     "example.org",
		"example.org":         "example.org",
		"a.b.example.co.uk":   "example.co.uk",
		"someone.github.io":   "someone.github.io",
		"x.someone.github.io": "someone.github.io",
		"127.0.0.1":           "127.0.0.1",
		"localhost":           "localhost",
		"CHAT.Example.ORG.":   "example.org",
	}
	for host, want := range cases {
		if got := registrableDomain(host); got != want {
			t.Errorf("%s: got %s, want %s", host, got, want)
		}
	}
	if registrableDomain("auth.example.org") != registrableDomain("chat.example.org") {
		t.Error("siblings differ")
	}
	if registrableDomain("auth.example.org") == registrableDomain("auth.example.com") {
		t.Error("different domains match")
	}
}

func TestFillFromCereaTakesTheDeploymentsSignInFlow(t *testing.T) {
	srv := factsServer(t, `{"issuer":"https://127.0.0.1/a","flow":"device"}`, 200)
	opts := &enrollOptions{cerea: srv.URL + "/chat", clientID: defaultEnrollClientID}
	if err := fillFromCerea(srv.Client(), opts, map[string]bool{}, yes); err != nil {
		t.Fatal(err)
	}
	if !opts.device || opts.loopback {
		t.Fatalf("flow not applied: %+v", opts)
	}
	// An explicit flag wins over the deployment's.
	opts = &enrollOptions{cerea: srv.URL + "/chat", clientID: defaultEnrollClientID, loopback: true}
	_ = fillFromCerea(srv.Client(), opts, map[string]bool{"loopback": true}, yes)
	if opts.device {
		t.Fatalf("the deployment overrode --loopback: %+v", opts)
	}
	// Absent or unknown (auto) changes nothing.
	for _, body := range []string{`{"issuer":"https://127.0.0.1/a"}`, `{"issuer":"https://127.0.0.1/a","flow":"weird"}`} {
		s2 := factsServer(t, body, 200)
		o := &enrollOptions{cerea: s2.URL + "/chat", clientID: defaultEnrollClientID}
		_ = fillFromCerea(s2.Client(), o, map[string]bool{}, yes)
		if o.device || o.loopback {
			t.Fatalf("%s: %+v", body, o)
		}
	}
}
