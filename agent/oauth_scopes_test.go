package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

// fakeIdP serves a discovery document built from the fields the test cares
// about, a device endpoint that records the scope it was asked for, and a
// token endpoint that answers with or without a refresh token.
type fakeIdP struct {
	srv         *httptest.Server
	deviceScope string
	scopes      []string // scopes_supported; nil omits the field
	grants      []string // grant_types_supported; nil omits the field
	refresh     bool     // whether the token response carries a refresh token
}

func newFakeIdP(t *testing.T, scopes, grants []string, refresh bool) *fakeIdP {
	t.Helper()
	idp := &fakeIdP{scopes: scopes, grants: grants, refresh: refresh}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		doc := map[string]any{
			"issuer":                        idp.srv.URL,
			"authorization_endpoint":        idp.srv.URL + "/auth",
			"token_endpoint":                idp.srv.URL + "/token",
			"device_authorization_endpoint": idp.srv.URL + "/device",
		}
		if idp.scopes != nil {
			doc["scopes_supported"] = idp.scopes
		}
		if idp.grants != nil {
			doc["grant_types_supported"] = idp.grants
		}
		_ = json.NewEncoder(w).Encode(doc)
	})
	mux.HandleFunc("/device", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		idp.deviceScope = r.PostForm.Get("scope")
		_, _ = w.Write([]byte(`{"device_code":"dc","user_code":"ABCD-EFGH","verification_uri":"https://idp.example.org/device","interval":1,"expires_in":600}`))
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		body := map[string]any{"access_token": "at", "expires_in": 300, "token_type": "Bearer"}
		if idp.refresh {
			body["refresh_token"] = "rt"
		}
		_ = json.NewEncoder(w).Encode(body)
	})
	idp.srv = httptest.NewServer(mux)
	t.Cleanup(idp.srv.Close)
	return idp
}

// enrollThrough is the discovery-then-sign-in stretch of enroll, device flow.
func (idp *fakeIdP) enrollThrough(t *testing.T) (*tokenSet, error) {
	t.Helper()
	doc, err := fetchDiscovery(context.Background(), idp.srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return signIn(context.Background(), doc, "opencode-enrollment", true, noopHooks())
}

var (
	infomaniakScopes = []string{"openid", "profile", "email", "phone"}
	withRefresh      = []string{"authorization_code", "refresh_token"}
	autheliaScopes   = []string{"openid", "offline_access", "profile", "email", "groups"}
)

func TestRequestScopes(t *testing.T) {
	cases := []struct {
		name        string
		supported   []string
		want        string
		wantDropped []string
	}{
		{"no scopes_supported asks for everything", nil, enrollScopes, nil},
		{"authelia-like offers everything", autheliaScopes, enrollScopes, nil},
		{"infomaniak-like has no groups and no offline_access", infomaniakScopes,
			"openid profile email", []string{"groups", "offline_access"}},
		{"offline_access kept when advertised, groups dropped",
			[]string{"openid", "profile", "email", "offline_access"},
			"openid profile email offline_access", []string{"groups"}},
		{"openid survives a list that forgets it", []string{"email"}, "openid email",
			[]string{"profile", "groups", "offline_access"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, dropped := requestScopes(&discovery{ScopesSupported: tc.supported})
			if got != tc.want {
				t.Errorf("scope = %q, want %q", got, tc.want)
			}
			if !reflect.DeepEqual(dropped, tc.wantDropped) {
				t.Errorf("dropped = %v, want %v", dropped, tc.wantDropped)
			}
		})
	}
}

// Infomaniak: a refresh_token grant but no offline_access scope. The request
// goes out without it and the refresh token that comes back is accepted.
func TestEnrollWithoutOfflineAccessAcceptsAnIssuedRefreshToken(t *testing.T) {
	idp := newFakeIdP(t, infomaniakScopes, withRefresh, true)
	tokens, err := idp.enrollThrough(t)
	if err != nil {
		t.Fatal(err)
	}
	if idp.deviceScope != "openid profile email" {
		t.Errorf("device flow asked for %q", idp.deviceScope)
	}
	if tokens.RefreshToken != "rt" {
		t.Errorf("refresh token = %q", tokens.RefreshToken)
	}
}

// The same IdP issuing none: enrollment fails, naming the remedy, rather
// than writing a machine that dies with its first access token.
func TestEnrollFailsWhenNoRefreshTokenCameBack(t *testing.T) {
	idp := newFakeIdP(t, infomaniakScopes, withRefresh, false)
	_, err := idp.enrollThrough(t)
	if err == nil {
		t.Fatal("enrollment succeeded with no refresh token")
	}
	for _, want := range []string{"no refresh token", "stay signed in", "enable refresh tokens", "opencode-enrollment"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q lacks %q", err, want)
		}
	}
	if strings.Contains(err.Error(), "although offline_access was requested") {
		t.Errorf("error claims offline_access was requested: %v", err)
	}
}

func TestEnrollKeepsOfflineAccessWhenAdvertised(t *testing.T) {
	idp := newFakeIdP(t, autheliaScopes, withRefresh, true)
	if _, err := idp.enrollThrough(t); err != nil {
		t.Fatal(err)
	}
	if idp.deviceScope != "openid profile email groups offline_access" {
		t.Errorf("device flow asked for %q", idp.deviceScope)
	}
}

func TestEnrollFailsWhenOfflineAccessWasAskedAndNoRefreshTokenCameBack(t *testing.T) {
	idp := newFakeIdP(t, autheliaScopes, withRefresh, false)
	_, err := idp.enrollThrough(t)
	if err == nil || !strings.Contains(err.Error(), "although offline_access was requested") {
		t.Fatalf("expected the offline_access refusal, got: %v", err)
	}
}

// Without scopes_supported the request is what it always was.
func TestEnrollAsksForEverythingWhenDiscoveryListsNoScopes(t *testing.T) {
	idp := newFakeIdP(t, nil, nil, true)
	if _, err := idp.enrollThrough(t); err != nil {
		t.Fatal(err)
	}
	if idp.deviceScope != enrollScopes {
		t.Errorf("device flow asked for %q", idp.deviceScope)
	}
}
