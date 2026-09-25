package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// fakeRevocationIdP serves discovery and an RFC 7009 endpoint, recording
// the form each revocation carried.
func fakeRevocationIdP(t *testing.T, status int) (*httptest.Server, *[]map[string]string) {
	t.Helper()
	var got []map[string]string
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(map[string]string{
				"token_endpoint":      srv.URL + "/token",
				"revocation_endpoint": srv.URL + "/revoke",
			})
		case "/revoke":
			_ = r.ParseForm()
			got = append(got, map[string]string{
				"token": r.PostForm.Get("token"), "token_type_hint": r.PostForm.Get("token_type_hint"),
				"client_id": r.PostForm.Get("client_id"),
			})
			w.WriteHeader(status)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &got
}

func writeCreds(t *testing.T, path string, c *credentials) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := saveCredentials(path, c); err != nil {
		t.Fatal(err)
	}
}

func readCreds(t *testing.T, path string) credentials {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var c credentials
	if err := json.Unmarshal(body, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

// A revoked machine revokes its refresh token at the IdP and forgets its
// tokens, from the credential file wherever it lives: the galopin state dir,
// or a pre-galopin install's opencode dir passed as --creds. A credential
// written before enroll recorded the endpoint finds it through discovery.
func TestRevokeRefreshTokenFromEitherLocation(t *testing.T) {
	srv, got := fakeRevocationIdP(t, http.StatusOK)
	config := withConfigDir(t)
	for _, tc := range []struct {
		name, path, endpoint string
	}{
		{"galopin dir, endpoint recorded", filepath.Join(config, "galopin", credentialsFileName), srv.URL + "/revoke"},
		{"legacy opencode dir, via discovery", filepath.Join(config, "opencode", "pystino-credentials.json"), ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			*got = nil
			writeCreds(t, tc.path, &credentials{
				Issuer: srv.URL, TokenEndpoint: srv.URL + "/token", RevocationEndpoint: tc.endpoint,
				ClientID: "opencode-enrollment", RefreshToken: "rt-1", AccessToken: "at-1", ShimSecret: "s",
			})
			if err := revokeRefreshToken(context.Background(), tc.path); err != nil {
				t.Fatal(err)
			}
			if len(*got) != 1 || (*got)[0]["token"] != "rt-1" || (*got)[0]["token_type_hint"] != "refresh_token" ||
				(*got)[0]["client_id"] != "opencode-enrollment" {
				t.Fatalf("revocations = %v, want one for rt-1 by opencode-enrollment", *got)
			}
			if c := readCreds(t, tc.path); c.RefreshToken != "" || c.AccessToken != "" || c.Issuer != srv.URL {
				t.Fatalf("after revoke the file holds %+v: tokens must be gone, the rest kept", c)
			}
		})
	}
}

// An IdP that refuses (or is unreachable) is reported, and the tokens are
// still forgotten: the machine is revoked either way.
func TestRevokeRefreshTokenForgetsTokensEvenWhenTheIdPRefuses(t *testing.T) {
	srv, _ := fakeRevocationIdP(t, http.StatusServiceUnavailable)
	path := filepath.Join(t.TempDir(), credentialsFileName)
	writeCreds(t, path, &credentials{
		Issuer: srv.URL, TokenEndpoint: srv.URL + "/token", RevocationEndpoint: srv.URL + "/revoke",
		ClientID: "c", RefreshToken: "rt", AccessToken: "at",
	})
	if err := revokeRefreshToken(context.Background(), path); err == nil {
		t.Fatal("a refused revocation must be reported")
	}
	if c := readCreds(t, path); c.RefreshToken != "" || c.AccessToken != "" {
		t.Fatalf("tokens kept after a refused revocation: %+v", c)
	}
}

// enroll and run agree on one default: the galopin state dir, with a
// pre-galopin install's credential moved there first rather than shadowed.
func TestDefaultCredsPathIsTheGalopinDirAfterMigrating(t *testing.T) {
	config := withConfigDir(t)
	want := filepath.Join(config, "galopin", credentialsFileName)
	got, err := resolveDefaultCredsPath()
	if err != nil || got != want {
		t.Fatalf("fresh machine: path = %q, %v; want %q", got, err, want)
	}

	writeLegacyFile(t, filepath.Join(config, "opencode"), "pystino-credentials.json", `{"refresh_token":"legacy"}`)
	got, err = resolveDefaultCredsPath()
	if err != nil || got != want {
		t.Fatalf("legacy install: path = %q, %v; want %q", got, err, want)
	}
	if body, err := os.ReadFile(want); err != nil || string(body) != `{"refresh_token":"legacy"}` {
		t.Fatalf("the legacy credential must now be at %s: %q, %v", want, body, err)
	}
}

// After a revoke cleared the tokens, the next run says "revoked" rather than
// failing to load the credential; it never mints an id to find out.
func TestRevokedAtReadsTheMarkerWithoutMinting(t *testing.T) {
	dir := t.TempDir()
	creds := filepath.Join(dir, credentialsFileName)
	if revokedAt("", creds) {
		t.Fatal("no machine id: not revoked")
	}
	if _, err := os.Stat(filepath.Join(dir, machineIDFileName)); !os.IsNotExist(err) {
		t.Fatal("revokedAt must not mint a machine id")
	}
	id, err := loadOrMintMachineID(filepath.Join(dir, machineIDFileName))
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRevokedMarker(dir, id); err != nil {
		t.Fatal(err)
	}
	if !revokedAt("", creds) {
		t.Fatal("the marker for the current id must read as revoked")
	}
}
