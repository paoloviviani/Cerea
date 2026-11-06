package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/policy"
	"galopin/internal/sessions"
)

// tagShim is a shim in front of a gateway that records the headers it saw.
func tagShim(t *testing.T) (*shim, *http.Header) {
	t.Helper()
	var seen http.Header
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(gw.Close)
	creds := &credentials{
		Gateway: gw.URL + "/v1", AccessToken: "tok", RefreshToken: "r",
		ExpiresIn: 3600, ObtainedAt: time.Now().Unix(),
	}
	path := filepath.Join(t.TempDir(), "creds.json")
	if err := saveCredentials(path, creds); err != nil {
		t.Fatal(err)
	}
	return newShim(creds, path, statusPathFor(path), 41871), &seen
}

func TestShimTagsForwardedRequestsWithTheSession(t *testing.T) {
	s, seen := tagShim(t)
	s.setSessionTag(func(id string) string { return "root-of-" + id })
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{}`))
	req.Header.Set("x-session-id", "ses_child")
	req.Header.Set("x-pystino-tag", "forged") // an engine cannot label its own usage
	s.handler(httptest.NewRecorder(), req)
	if got := seen.Get("x-pystino-tag"); got != "root-of-ses_child" {
		t.Errorf("x-pystino-tag = %q, want root-of-ses_child", got)
	}
}

func TestShimSendsNoTagWithoutAResolverOrAnAnswer(t *testing.T) {
	s, seen := tagShim(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{}`))
	req.Header.Set("x-pystino-tag", "forged")
	s.handler(httptest.NewRecorder(), req)
	if got := seen.Get("x-pystino-tag"); got != "" {
		t.Errorf("no resolver: x-pystino-tag = %q, want none (and never the engine's own)", got)
	}
	s.setSessionTag(func(string) string { return "" })
	s.handler(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{}`)))
	if got := seen.Get("x-pystino-tag"); got != "" {
		t.Errorf("empty answer: x-pystino-tag = %q, want none", got)
	}
}

func TestSessionTagFunc(t *testing.T) {
	mat := sessions.New(nil, policy.Default())
	mat.Track("/w", backend.Session{ID: "root", Status: backend.StatusIdle})
	mat.Track("/w", backend.Session{ID: "child", ParentID: "root", Status: backend.StatusBusy})
	mat.Track("/w", backend.Session{ID: "other", Status: backend.StatusIdle})
	tag := sessionTagFunc(mat)

	if got := tag("child"); got != "root" {
		t.Errorf("a named subagent session = %q, want its root", got)
	}
	if got := tag("unknown"); got != "unknown" {
		t.Errorf("a session galopin has not seen = %q, want itself", got)
	}
	// No id on the request (an ACP agent): the one running turn's root.
	if got := tag(""); got != "root" {
		t.Errorf("unnamed request, one busy session tree = %q, want root", got)
	}
	// Two running sessions: guessing would put one's cost on the other.
	mat.Track("/w", backend.Session{ID: "second", Status: backend.StatusBusy})
	if got := tag(""); got != "" {
		t.Errorf("unnamed request, two busy sessions = %q, want none", got)
	}
}
