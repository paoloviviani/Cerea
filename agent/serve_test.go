package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestNeedsRefresh pins the one decision the shim makes before reusing a
// token: fresh tokens are kept, tokens inside the skew (or past expiry) are
// refreshed.
func TestNeedsRefresh(t *testing.T) {
	now := time.Now()
	fresh := &credentials{ExpiresIn: 300, ObtainedAt: now.Unix()}
	if fresh.needsRefresh(now) {
		t.Error("a token 300s from expiry should not need refreshing")
	}
	nearExpiry := &credentials{ExpiresIn: 300, ObtainedAt: now.Add(-280 * time.Second).Unix()}
	if !nearExpiry.needsRefresh(now) {
		t.Error("a token 20s from expiry is inside the skew and should refresh")
	}
	expired := &credentials{ExpiresIn: 300, ObtainedAt: now.Add(-600 * time.Second).Unix()}
	if !expired.needsRefresh(now) {
		t.Error("an expired token must refresh")
	}
}

// TestShimRefreshesAndForwards drives the whole handler: an expired token
// forces a refresh, and the gateway must then see the fresh bearer, the
// recorded x-bill-to, and the /v1-rewritten path, with the body streamed back.
func TestShimRefreshesAndForwards(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("token endpoint: bad form: %v", err)
		}
		if got := r.Form.Get("grant_type"); got != "refresh_token" {
			t.Errorf("token endpoint: grant_type=%q, want refresh_token", got)
		}
		if got := r.Form.Get("refresh_token"); got != "refresh-abc" {
			t.Errorf("token endpoint: refresh_token=%q", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "fresh-access-token",
			"expires_in":   300,
		})
	}))
	defer tokenServer.Close()

	var sawAuth, sawBillTo, sawPath string
	gatewayServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		sawBillTo = r.Header.Get("x-bill-to")
		sawPath = r.URL.Path
		if r.Header.Get("Authorization") != "" && r.Header.Get("Authorization") == "Bearer stale" {
			t.Error("gateway saw the stale token; refresh did not run")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "data: hello\n\n")
	}))
	defer gatewayServer.Close()

	creds := &credentials{
		TokenEndpoint: tokenServer.URL,
		ClientID:      "opencode-enrollment",
		Gateway:       gatewayServer.URL + "/v1",
		Group:         "research",
		RefreshToken:  "refresh-abc",
		AccessToken:   "stale",
		ExpiresIn:     300,
		ObtainedAt:    time.Now().Add(-600 * time.Second).Unix(), // expired
	}
	credsPath := filepath.Join(t.TempDir(), "creds.json")
	if err := saveCredentials(credsPath, creds); err != nil {
		t.Fatal(err)
	}

	s := newShim(creds, credsPath, statusPathFor(credsPath), 41871)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"m"}`))
	rec := httptest.NewRecorder()
	s.handler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if sawAuth != "Bearer fresh-access-token" {
		t.Errorf("gateway Authorization = %q, want the refreshed bearer", sawAuth)
	}
	if sawBillTo != "research" {
		t.Errorf("gateway x-bill-to = %q, want research", sawBillTo)
	}
	if sawPath != "/v1/chat/completions" {
		t.Errorf("gateway path = %q, want /v1/chat/completions", sawPath)
	}
	if got := rec.Body.String(); !strings.Contains(got, "data: hello") {
		t.Errorf("body not streamed back: %q", got)
	}
	// The rotated-in token must be persisted for the next start.
	reloaded, err := loadCredentials(credsPath)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.AccessToken != "fresh-access-token" {
		t.Errorf("refreshed token not persisted: %q", reloaded.AccessToken)
	}
}

// TestRefreshCredentialClassification drives refreshCredential against a
// fake IdP that answers invalid_grant, then one that answers a bare 500,
// pinning the split that decides 401-and-stop versus 502-and-retry.
func TestRefreshCredentialClassification(t *testing.T) {
	t.Run("invalid_grant is permanent", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{
				"error":             "invalid_grant",
				"error_description": "Token is expired",
			})
		}))
		defer server.Close()

		creds := &credentials{TokenEndpoint: server.URL, RefreshToken: "dead", ClientID: "opencode-enrollment"}
		err := refreshCredential(t.TempDir()+"/creds.json", creds)
		var perr *permanentRefreshError
		if !errors.As(err, &perr) {
			t.Fatalf("refreshCredential err = %v (%T), want *permanentRefreshError", err, err)
		}
	})

	t.Run("500 is transient", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "upstream on fire", http.StatusInternalServerError)
		}))
		defer server.Close()

		creds := &credentials{TokenEndpoint: server.URL, RefreshToken: "whatever", ClientID: "opencode-enrollment"}
		err := refreshCredential(t.TempDir()+"/creds.json", creds)
		var perr *permanentRefreshError
		if errors.As(err, &perr) {
			t.Fatalf("a bare 500 must not classify as permanent: %v", err)
		}
		if err == nil {
			t.Fatal("expected an error for a 500 response")
		}
	})

	t.Run("temporarily_unavailable is transient", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "temporarily_unavailable"})
		}))
		defer server.Close()

		creds := &credentials{TokenEndpoint: server.URL, RefreshToken: "whatever", ClientID: "opencode-enrollment"}
		err := refreshCredential(t.TempDir()+"/creds.json", creds)
		var perr *permanentRefreshError
		if errors.As(err, &perr) {
			t.Fatalf("temporarily_unavailable must not classify as permanent: %v", err)
		}
	})
}

// deadTokenServer answers invalid_grant on every call and counts how many
// times it was hit, so a test can assert the shim stops asking once it
// knows the answer.
func deadTokenServer(t *testing.T) (*httptest.Server, *int32) {
	t.Helper()
	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error":             "invalid_grant",
			"error_description": "the refresh token was revoked",
		})
	}))
	return server, &calls
}

func expiredCreds(tokenEndpoint string) *credentials {
	return &credentials{
		TokenEndpoint: tokenEndpoint,
		ClientID:      "opencode-enrollment",
		Gateway:       "http://unused.example/v1",
		Group:         "research",
		RefreshToken:  "refresh-abc",
		AccessToken:   "stale",
		ExpiresIn:     300,
		ObtainedAt:    time.Now().Add(-600 * time.Second).Unix(),
	}
}

// TestHandlerPermanentRefusalRespondsAndCaches drives the handler twice
// against a dead credential: both responses must be the non-retryable
// OpenAI-shaped 401, and the token endpoint must be hit exactly once — the
// second request is answered from the cached dead state.
func TestHandlerPermanentRefusalRespondsAndCaches(t *testing.T) {
	tokenServer, calls := deadTokenServer(t)
	defer tokenServer.Close()

	creds := expiredCreds(tokenServer.URL)
	credsPath := filepath.Join(t.TempDir(), "creds.json")
	if err := saveCredentials(credsPath, creds); err != nil {
		t.Fatal(err)
	}
	statusPath := statusPathFor(credsPath)
	s := newShim(creds, credsPath, statusPath, 41871)

	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		s.handler(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("request %d: status = %d, want 401", i, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
			t.Errorf("request %d: Content-Type = %q, want application/json", i, ct)
		}
		var body struct {
			Error struct {
				Message string `json:"message"`
				Type    string `json:"type"`
				Code    string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("request %d: body not JSON: %v (%s)", i, err, rec.Body.String())
		}
		if body.Error.Code != "enrollment_expired" {
			t.Errorf("request %d: error.code = %q, want enrollment_expired", i, body.Error.Code)
		}
		if !strings.Contains(body.Error.Message, "invalid_grant") {
			t.Errorf("request %d: error.message %q lost the invalid_grant token", i, body.Error.Message)
		}
	}

	if got := atomic.LoadInt32(calls); got != 1 {
		t.Errorf("token endpoint hit %d times across two requests, want exactly 1 (cached dead state)", got)
	}

	status, err := readStatusFile(statusPath)
	if err != nil {
		t.Fatal(err)
	}
	if status.State != stateExpired {
		t.Errorf("status file state = %q, want %q", status.State, stateExpired)
	}
}

// TestHandlerTransientRefusalStays502 pins the other half of the split: a
// refresh failure that is not invalid_grant must still answer the old,
// retryable 502, and must keep re-attempting the IdP on later requests
// rather than latching into the cached-dead path.
func TestHandlerTransientRefusalStays502(t *testing.T) {
	var calls int32
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		http.Error(w, "idp unavailable", http.StatusServiceUnavailable)
	}))
	defer tokenServer.Close()

	creds := expiredCreds(tokenServer.URL)
	credsPath := filepath.Join(t.TempDir(), "creds.json")
	if err := saveCredentials(credsPath, creds); err != nil {
		t.Fatal(err)
	}
	s := newShim(creds, credsPath, statusPathFor(credsPath), 41871)

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	s.handler(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}

	req2 := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{}`))
	rec2 := httptest.NewRecorder()
	s.handler(rec2, req2)
	if rec2.Code != http.StatusBadGateway {
		t.Fatalf("second request status = %d, want 502", rec2.Code)
	}

	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Errorf("token endpoint hit %d times across two requests, want 2 (transient failures keep retrying)", got)
	}
}

// TestHealthHandlerReflectsStatus checks that GET /galopin/health serves
// exactly the status the last refresh recorded.
func TestHealthHandlerReflectsStatus(t *testing.T) {
	tokenServer, _ := deadTokenServer(t)
	defer tokenServer.Close()

	creds := expiredCreds(tokenServer.URL)
	credsPath := filepath.Join(t.TempDir(), "creds.json")
	if err := saveCredentials(credsPath, creds); err != nil {
		t.Fatal(err)
	}
	s := newShim(creds, credsPath, statusPathFor(credsPath), 41871)
	if err := s.refresh(); err == nil {
		t.Fatal("expected the dead credential to fail refresh")
	}

	req := httptest.NewRequest(http.MethodGet, "/galopin/health", nil)
	rec := httptest.NewRecorder()
	s.healthHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("health endpoint status = %d, want 200", rec.Code)
	}
	var status healthStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatalf("health body not JSON: %v (%s)", err, rec.Body.String())
	}
	if status.State != stateExpired {
		t.Errorf("health state = %q, want %q", status.State, stateExpired)
	}
	if status.Message == "" {
		t.Error("health message is empty")
	}
	if status.CheckedAt.IsZero() {
		t.Error("health checkedAt is zero")
	}
}

// TestRequireLocalAuthHostAllowlist pins the DNS-rebinding defence (C3): a
// request whose Host is not the loopback address this shim listens on is
// refused with 403 before the wrapped handler — and so the credential — is
// ever reached.
func TestRequireLocalAuthHostAllowlist(t *testing.T) {
	creds := &credentials{ShimSecret: "the-secret"}
	s := newShim(creds, filepath.Join(t.TempDir(), "creds.json"), filepath.Join(t.TempDir(), "status.json"), 41871)
	called := false
	wrapped := s.requireLocalAuth(func(w http.ResponseWriter, r *http.Request) { called = true })

	for _, tc := range []struct {
		host string
		want int
	}{
		{"127.0.0.1:41871", http.StatusUnauthorized}, // right host, no bearer yet: reaches the secret check
		{"localhost:41871", http.StatusUnauthorized},
		{"attacker.example", http.StatusForbidden},
		{"127.0.0.1:9999", http.StatusForbidden}, // right loopback, wrong port
		{"evil.example:41871", http.StatusForbidden},
	} {
		called = false
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Host = tc.host
		rec := httptest.NewRecorder()
		wrapped(rec, req)
		if rec.Code != tc.want {
			t.Errorf("Host %q: status = %d, want %d", tc.host, rec.Code, tc.want)
		}
		if tc.want == http.StatusForbidden && called {
			t.Errorf("Host %q: wrapped handler ran despite a disallowed Host", tc.host)
		}
	}
}

// TestRequireLocalAuthSecret pins the per-install bearer check (C3): only
// the exact secret enroll wrote into opencode's apiKey passes, a wrong or
// missing one is refused, and a credential file with no secret at all
// (predates C3) refuses everyone rather than running open.
func TestRequireLocalAuthSecret(t *testing.T) {
	creds := &credentials{ShimSecret: "correct-secret"}
	s := newShim(creds, filepath.Join(t.TempDir(), "creds.json"), filepath.Join(t.TempDir(), "status.json"), 41871)
	called := false
	wrapped := s.requireLocalAuth(func(w http.ResponseWriter, r *http.Request) { called = true })

	for _, tc := range []struct {
		name   string
		bearer string
		want   int
	}{
		{"correct secret", "Bearer correct-secret", http.StatusOK},
		{"wrong secret", "Bearer nope", http.StatusUnauthorized},
		{"missing bearer", "", http.StatusUnauthorized},
	} {
		called = false
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Host = "127.0.0.1:41871"
		if tc.bearer != "" {
			req.Header.Set("Authorization", tc.bearer)
		}
		rec := httptest.NewRecorder()
		wrapped(rec, req)
		if rec.Code != tc.want {
			t.Errorf("%s: status = %d, want %d", tc.name, rec.Code, tc.want)
		}
		if (tc.want == http.StatusOK) != called {
			t.Errorf("%s: handler called = %v, want %v", tc.name, called, tc.want == http.StatusOK)
		}
	}

	// A credential file with no ShimSecret (an enroll that predates C3)
	// must refuse every caller, not run unauthenticated.
	blank := &credentials{}
	sBlank := newShim(blank, filepath.Join(t.TempDir(), "creds.json"), filepath.Join(t.TempDir(), "status.json"), 41871)
	wrappedBlank := sBlank.requireLocalAuth(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler must not run when the credential carries no shim secret")
	})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Host = "127.0.0.1:41871"
	req.Header.Set("Authorization", "Bearer anything")
	rec := httptest.NewRecorder()
	wrappedBlank(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("blank-secret shim status = %d, want 401", rec.Code)
	}
}

// TestRefreshCredentialAdoptsConcurrentWinner pins R7: if the on-disk
// credential already carries a different (fresher) refresh token by the
// time refreshCredential takes the lock — as if another process had won the
// race and rotated it — this call must adopt that result instead of
// presenting the caller's now-stale refresh token to the IdP.
func TestRefreshCredentialAdoptsConcurrentWinner(t *testing.T) {
	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		t.Error("the IdP must not be called: the on-disk credential was already fresh")
	}))
	defer server.Close()

	credsPath := filepath.Join(t.TempDir(), "creds.json")
	winner := &credentials{
		TokenEndpoint: server.URL,
		ClientID:      "opencode-enrollment",
		Gateway:       "http://unused.example/v1",
		RefreshToken:  "rotated-by-winner",
		AccessToken:   "winner-access-token",
		ExpiresIn:     300,
		ObtainedAt:    time.Now().Unix(),
	}
	if err := saveCredentials(credsPath, winner); err != nil {
		t.Fatal(err)
	}

	// This caller's in-memory copy is stale: it still holds the refresh
	// token the (simulated) other process already rotated away.
	loser := &credentials{
		TokenEndpoint: server.URL,
		ClientID:      "opencode-enrollment",
		Gateway:       "http://unused.example/v1",
		RefreshToken:  "stale-refresh-token",
		AccessToken:   "stale-access-token",
		ExpiresIn:     300,
		ObtainedAt:    time.Now().Add(-600 * time.Second).Unix(),
	}
	if err := refreshCredential(credsPath, loser); err != nil {
		t.Fatalf("refreshCredential should adopt the winner silently, got err: %v", err)
	}
	if loser.AccessToken != "winner-access-token" {
		t.Errorf("loser.AccessToken = %q, want the winner's token", loser.AccessToken)
	}
	if atomic.LoadInt32(&calls) != 0 {
		t.Errorf("IdP hit %d times, want 0: the on-disk credential was already fresh", calls)
	}
}

// TestShimRecoversNewerCredentialWithoutRestart pins the way out of the
// latched "expired" state that does not involve restarting: 'galopin auth
// login' rewrites the credential file's token fields under the same lock the
// shim refreshes under, so a shim that has judged itself dead — token()
// answering deadErr from cache, the refresh loop exited — must notice the
// newer file the next time a request needs a token, adopt it, clear the dead
// state and serve. Before the recovery existed, a server at a latched denied
// state answered "enrollment expired" until it was restarted, even with a
// perfectly good credential on disk.
func TestShimRecoversNewerCredentialWithoutRestart(t *testing.T) {
	var accept atomic.Bool
	var postmortal int32
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !accept.Load() {
			atomic.AddInt32(&postmortal, 1)
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{
				"error":             "invalid_grant",
				"error_description": "the access token was revoked",
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "revived-access-token", "expires_in": 300,
		})
	}))
	defer tokenServer.Close()

	creds := expiredCreds(tokenServer.URL)
	credsPath := filepath.Join(t.TempDir(), "creds.json")
	if err := saveCredentials(credsPath, creds); err != nil {
		t.Fatal(err)
	}
	statusPath := statusPathFor(credsPath)
	s := newShim(creds, credsPath, statusPath, 41871)

	// The shim is refused once, latches denied — nothing left to check
	// until a human fixes it and restarts this process, the old comment
	// said — and then answers every later token() from that cached verdict.
	if err := s.refresh(); err == nil {
		t.Fatal("expected the dead credential to fail refresh")
	}
	if _, err := s.token(); err == nil {
		t.Fatal("expected token() to answer the cached dead verdict")
	}

	// 'galopin auth login' has just rewritten the file's token fields: a
	// newer refresh token, a fresh access one. Nothing restarted.
	recovery := &credentials{
		TokenEndpoint: tokenServer.URL,
		ClientID:      "opencode-enrollment",
		RefreshToken:  "revived-refresh-token",
		AccessToken:   "revived-access-token",
		ExpiresIn:     300,
		ObtainedAt:    time.Now().Unix(),
	}
	if err := saveCredentials(credsPath, recovery); err != nil {
		t.Fatal(err)
	}
	accept.Store(true)

	got, err := s.token()
	if err != nil {
		t.Fatalf("token() after 'galopin auth login' rewrote the file: %v — the shim did not recover without a restart", err)
	}
	if got != "revived-access-token" {
		t.Errorf("token() = %q, want the revived access token", got)
	}
	if postmortal := atomic.LoadInt32(&postmortal); postmortal != 1 {
		t.Errorf("the dead refresh token was presented to the IdP %d more times, want 0", postmortal)
	}
	status, readErr := readStatusFile(statusPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if status.State != stateOK {
		t.Errorf("status after recovery = %q, want %q", status.State, stateOK)
	}

	// And once recovered, the dead state stays cleared: expired
	// credentials refresh through the ordinary path again.
	staleness := *s.creds
	staleness.ObtainedAt = time.Now().Add(-600 * time.Second).Unix()
	s.creds = &staleness
	got, err = s.token()
	if err != nil {
		t.Fatalf("an ordinary expired token after recovery: %v", err)
	}
	if got != "revived-access-token" {
		t.Errorf("token() after an ordinary expiry = %q", got)
	}
}

// 'galopin auth group' rewrites only the group field of the file, while the
// shim holds its own copy in memory and stamps x-bill-to from it on every
// request. A running 'galopin run' must therefore follow the new group at
// its next request — the alternative is telling every owner to restart for a
// billing change.
func TestShimFollowsTheGroupAuthGroupWrites(t *testing.T) {
	var sawBillTo string
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawBillTo = r.Header.Get("x-bill-to")
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: ok\n\n")
	}))
	defer gateway.Close()

	creds := &credentials{
		TokenEndpoint: "http://unused.example/token", ClientID: "opencode-enrollment",
		Gateway: gateway.URL, Group: "team",
		RefreshToken: "rt", AccessToken: "at", ExpiresIn: 300, ObtainedAt: time.Now().Unix(),
	}
	credsPath := filepath.Join(t.TempDir(), "creds.json")
	if err := saveCredentials(credsPath, creds); err != nil {
		t.Fatal(err)
	}
	s := newShim(creds, credsPath, statusPathFor(credsPath), 41871)

	// 'galopin auth group other-group' rewrote the file under the lock.
	moved := *creds
	moved.Group = "other-group"
	if err := saveCredentials(credsPath, &moved); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	s.handler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if sawBillTo != "other-group" {
		t.Errorf("gateway saw x-bill-to %q, want other-group without a restart", sawBillTo)
	}
}

// The other half of the same race, at the refresh: the shim's in-memory copy
// still carries the old group when it next refreshes, and refreshCredential
// saves what it holds — which would write the old group back over the one
// 'auth group' just filed. The on-disk billing settings must win.
func TestRefreshCredentialKeepsANewerGroup(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fresh-at", "expires_in": 300})
	}))
	defer server.Close()

	credsPath := filepath.Join(t.TempDir(), "creds.json")
	onDisk := &credentials{
		TokenEndpoint: server.URL, ClientID: "opencode-enrollment",
		Group: "other-group", RefreshToken: "same-rt",
		AccessToken: "old-at", ExpiresIn: 300, ObtainedAt: time.Now().Add(-600 * time.Second).Unix(),
	}
	if err := saveCredentials(credsPath, onDisk); err != nil {
		t.Fatal(err)
	}
	// The shim's in-memory copy: same refresh token, the stale group.
	inMemory := *onDisk
	inMemory.Group = "team"

	if err := refreshCredential(credsPath, &inMemory); err != nil {
		t.Fatal(err)
	}
	if inMemory.Group != "other-group" {
		t.Errorf("the refresh adopted the stale group %q over the on-disk one", inMemory.Group)
	}
	reloaded, err := loadCredentials(credsPath)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Group != "other-group" {
		t.Errorf("the refresh clobbered the on-disk group back to %q", reloaded.Group)
	}
}

// In follow-default mode the shim must send NO x-bill-to — the gateway bills
// an unheadered request to the user's default group, an empty value filters
// it to nothing — and a caller must not be able to inject one, because the
// shim, not opencode, owns billing. A legacy file with no group and no mode
// is also headerless: wrong either way, and the gateway's refusal is the
// honest answer.
func TestShimBillsTheDefaultBySendingNoHeader(t *testing.T) {
	var sawHeader bool
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, sawHeader = r.Header["X-Bill-To"], len(r.Header["X-Bill-To"]) > 0
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: ok\n\n")
	}))
	defer gateway.Close()

	newCreds := func() *credentials {
		return &credentials{
			TokenEndpoint: "http://unused.example/token", ClientID: "opencode-enrollment",
			Gateway: gateway.URL, RefreshToken: "rt", AccessToken: "at",
			ExpiresIn: 300, ObtainedAt: time.Now().Unix(),
		}
	}
	for _, tc := range []struct {
		name  string
		group string
		def   bool
	}{
		{"following the default", "", true},
		{"legacy file with no group", "", false},
	} {
		creds := newCreds()
		creds.Group, creds.BillToDefault = tc.group, tc.def
		credsPath := filepath.Join(t.TempDir(), "creds.json")
		if err := saveCredentials(credsPath, creds); err != nil {
			t.Fatal(err)
		}
		s := newShim(creds, credsPath, statusPathFor(credsPath), 41871)

		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{}`))
		req.Header.Set("x-bill-to", "caller-invented")
		rec := httptest.NewRecorder()
		s.handler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d: %s", tc.name, rec.Code, rec.Body.String())
		}
		if sawHeader {
			t.Errorf("%s: the gateway saw an x-bill-to; want the header absent", tc.name)
		}
	}
}

// billingStartupLine is what serve prints about billing at startup: pinned
// names the group, following says so, and a file with neither is named for
// what it is — a credential that cannot bill until someone picks a group.
func TestBillingStartupLineNamesTheMode(t *testing.T) {
	pinned := &credentials{Group: "team"}
	if got := billingStartupLine(pinned); !strings.Contains(got, "team") {
		t.Errorf("pinned line %q lacks the group", got)
	}
	following := &credentials{BillToDefault: true}
	if got := billingStartupLine(following); !strings.Contains(got, "your default (follows your Pystino setting)") {
		t.Errorf("following line %q", got)
	}
	neither := &credentials{}
	if got := billingStartupLine(neither); !strings.Contains(got, "NONE RECORDED") {
		t.Errorf("neither line %q", got)
	}
}
