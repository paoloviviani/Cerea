package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestPKCEChallengeVector pins the S256 transform to the RFC 7636
// Appendix B vector, so a verifier the CLI mints is one the IdP accepts.
func TestPKCEChallengeVector(t *testing.T) {
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	if got := pkceChallenge(verifier); got != "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" {
		t.Fatalf("wrong S256 challenge: %s", got)
	}
	verifier, err := pkceVerifier()
	if err != nil {
		t.Fatal(err)
	}
	if len(verifier) < 43 || len(verifier) > 128 {
		t.Fatalf("verifier length %d outside RFC 7636 range", len(verifier))
	}
}

// TestFetchDiscovery parses a stubbed discovery document and rejects one
// with no token endpoint: without it no flow can proceed, and failing here
// names the cause instead of failing later inside an exchange.
func TestFetchDiscovery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/openid-configuration" {
			t.Errorf("unexpected discovery path %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"authorization_endpoint":        "https://idp.example.org/auth",
			"token_endpoint":                "https://idp.example.org/token",
			"device_authorization_endpoint": "https://idp.example.org/device",
		})
	}))
	defer server.Close()

	doc, err := fetchDiscovery(context.Background(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if doc.AuthorizationEndpoint != "https://idp.example.org/auth" ||
		doc.TokenEndpoint != "https://idp.example.org/token" ||
		doc.DeviceAuthorizationEndpoint != "https://idp.example.org/device" {
		t.Fatalf("misparsed discovery: %+v", doc)
	}
}

// TestFetchDiscoveryMissingTokenEndpoint rejects metadata no flow can use.
func TestFetchDiscoveryMissingTokenEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"authorization_endpoint": "https://idp.example.org/auth",
		})
	}))
	defer server.Close()

	if _, err := fetchDiscovery(context.Background(), server.URL); err == nil {
		t.Fatal("expected an error for metadata without a token endpoint")
	}
}

// TestSelectFlow covers the override and auto-detect matrix: explicit flags
// win, a display means loopback, headless means device, and a missing
// endpoint for the chosen path is an error naming what to do instead.
func TestSelectFlow(t *testing.T) {
	full := &discovery{AuthorizationEndpoint: "a", DeviceAuthorizationEndpoint: "d"}
	authOnly := &discovery{AuthorizationEndpoint: "a"}
	deviceOnly := &discovery{DeviceAuthorizationEndpoint: "d", TokenEndpoint: "t"}
	neither := &discovery{TokenEndpoint: "t"}

	cases := []struct {
		name       string
		doc        *discovery
		dev, loop  bool
		wantDevice bool
		wantErr    bool
	}{
		{"forced device", full, true, false, true, false},
		{"forced loopback", full, false, true, false, false},
		{"forced device without endpoint", authOnly, true, false, false, true},
		{"forced loopback without endpoint", deviceOnly, false, true, false, true},
		{"neither endpoint", neither, false, false, false, true},
	}
	// Display-dependent auto-detect branches run against the real hasDisplay;
	// forced and impossible paths are display-independent, so they are stable
	// on headless CI and on laptops alike.
	for _, tc := range cases {
		got, err := selectFlow(tc.doc, tc.dev, tc.loop)
		if tc.wantErr != (err != nil) {
			t.Errorf("%s: err=%v, wantErr=%v", tc.name, err, tc.wantErr)
		}
		if err == nil && got != tc.wantDevice {
			t.Errorf("%s: device=%v, want %v", tc.name, got, tc.wantDevice)
		}
	}
}

// TestOAuth2ErrorPermanent pins the one classification that decides whether
// the shim gives up (401, actionable) or keeps retrying (502): invalid_grant
// is the RFC 6749 code for "this grant is invalid, expired, or revoked" and
// nothing else is treated as final.
func TestOAuth2ErrorPermanent(t *testing.T) {
	cases := []struct {
		code string
		want bool
	}{
		{"invalid_grant", true},
		{"server_error", false},
		{"temporarily_unavailable", false},
		{"invalid_client", false},
		{"", false},
	}
	for _, tc := range cases {
		err := &oauth2Error{Code: tc.code}
		if got := err.permanent(); got != tc.want {
			t.Errorf("oauth2Error{Code: %q}.permanent() = %v, want %v", tc.code, got, tc.want)
		}
	}
}

// TestPermanentRefreshErrorMessage pins the two things Cerea's classifier
// and the human both need out of the message: the literal invalid_grant
// token (regex: /invalid_grant|enrollment (?:has )?expired|enrollment
// (?:was )?revoked/i) and a plain instruction naming the fix.
func TestPermanentRefreshErrorMessage(t *testing.T) {
	err := &permanentRefreshError{code: "invalid_grant"}
	msg := err.Error()
	if !strings.Contains(msg, "invalid_grant") {
		t.Errorf("message %q does not carry the invalid_grant token Cerea matches on", msg)
	}
	if !strings.Contains(msg, "re-enroll") && !strings.Contains(msg, "Re-enroll") {
		t.Errorf("message %q does not tell the human what to do", msg)
	}
	if !strings.Contains(msg, "galopin enroll") {
		t.Errorf("message %q does not name the concrete remedy command", msg)
	}
}

// TestAccessExpiryDecidesRefresh pins the instant serve compares against:
// lifetime from the token response, defaulting conservative when absent.
func TestAccessExpiryDecidesRefresh(t *testing.T) {
	now := time.Now()
	c := &credentials{ExpiresIn: 300, ObtainedAt: now.Unix()}
	if got := c.accessExpiry(); got.Sub(now) < 299*time.Second || got.Sub(now) > 301*time.Second {
		t.Fatalf("expiry %v is not ~300s out", got.Sub(now))
	}
	zero := &credentials{ObtainedAt: now.Unix()}
	if got := zero.accessExpiry(); got.Sub(now) < 299*time.Second {
		t.Fatalf("zero lifetime did not default conservative: %v", got.Sub(now))
	}
}

// TestFetchDiscoveryDerivesGitLabDeviceEndpoint pins the GitLab case: its
// discovery lists the device_code grant but no device_authorization_endpoint,
// while Doorkeeper serves the endpoint at /oauth/authorize_device beside
// /oauth/authorize (checked against gitlab.linksfoundation.com on 2026-10-12:
// POST there answers 401 for an unknown client, not 404). Without the
// derivation a headless enroll stopped at "no device endpoint advertised".
func TestFetchDiscoveryDerivesGitLabDeviceEndpoint(t *testing.T) {
	cases := []struct {
		name   string
		doc    map[string]any
		wanted string
	}{
		{"gitlab: grant listed, endpoint missing", map[string]any{
			"authorization_endpoint": "https://gitlab.example.org/oauth/authorize",
			"token_endpoint":         "https://gitlab.example.org/oauth/token",
			"grant_types_supported":  []string{"authorization_code", "device_code", "refresh_token"},
		}, "https://gitlab.example.org/oauth/authorize_device"},
		{"rfc grant name", map[string]any{
			"authorization_endpoint": "https://idp.example.org/sub/oauth/authorize",
			"token_endpoint":         "https://idp.example.org/sub/oauth/token",
			"grant_types_supported":  []string{"urn:ietf:params:oauth:grant-type:device_code"},
		}, "https://idp.example.org/sub/oauth/authorize_device"},
		{"advertised endpoint wins", map[string]any{
			"authorization_endpoint":        "https://gitlab.example.org/oauth/authorize",
			"token_endpoint":                "https://gitlab.example.org/oauth/token",
			"device_authorization_endpoint": "https://gitlab.example.org/custom/device",
			"grant_types_supported":         []string{"device_code"},
		}, "https://gitlab.example.org/custom/device"},
		{"no device grant: nothing guessed", map[string]any{
			"authorization_endpoint": "https://gitlab.example.org/oauth/authorize",
			"token_endpoint":         "https://gitlab.example.org/oauth/token",
			"grant_types_supported":  []string{"authorization_code"},
		}, ""},
		{"not doorkeeper-shaped: nothing guessed", map[string]any{
			"authorization_endpoint": "https://idp.example.org/protocol/openid-connect/auth",
			"token_endpoint":         "https://idp.example.org/protocol/openid-connect/token",
			"grant_types_supported":  []string{"device_code"},
		}, ""},
	}
	for _, tc := range cases {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(tc.doc)
		}))
		doc, err := fetchDiscovery(context.Background(), server.URL)
		server.Close()
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if doc.DeviceAuthorizationEndpoint != tc.wanted {
			t.Errorf("%s: device endpoint = %q, want %q", tc.name, doc.DeviceAuthorizationEndpoint, tc.wanted)
		}
		if derived := tc.wanted != "" && tc.doc["device_authorization_endpoint"] == nil; doc.DeviceEndpointDerived != derived {
			t.Errorf("%s: derived = %v, want %v", tc.name, doc.DeviceEndpointDerived, derived)
		}
	}
}

// TestApplyDeviceEndpointOverride: --device-endpoint replaces whatever
// discovery said (or did not say), and must be https unless it is loopback.
func TestApplyDeviceEndpointOverride(t *testing.T) {
	doc := &discovery{AuthorizationEndpoint: "https://idp/oauth/authorize"}
	if err := applyDeviceEndpointOverride(doc, "https://idp.example.org/oauth/authorize_device"); err != nil {
		t.Fatal(err)
	}
	if doc.DeviceAuthorizationEndpoint != "https://idp.example.org/oauth/authorize_device" || doc.DeviceEndpointDerived {
		t.Fatalf("override not applied: %+v", doc)
	}
	if err := applyDeviceEndpointOverride(&discovery{}, "http://idp.example.org/device"); err == nil {
		t.Error("plain http to a remote host was accepted")
	}
	if err := applyDeviceEndpointOverride(&discovery{}, "http://127.0.0.1:9000/device"); err != nil {
		t.Errorf("loopback http refused: %v", err)
	}
	if err := applyDeviceEndpointOverride(&discovery{}, "not a url"); err == nil {
		t.Error("garbage accepted")
	}
	unchanged := &discovery{DeviceAuthorizationEndpoint: "https://keep"}
	if err := applyDeviceEndpointOverride(unchanged, ""); err != nil || unchanged.DeviceAuthorizationEndpoint != "https://keep" {
		t.Errorf("an empty override changed the document: %+v, %v", unchanged, err)
	}
}
