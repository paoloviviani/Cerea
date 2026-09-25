package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// revokeRefreshToken is what a machine does once Cerea has revoked it (the
// link's 4403): it tells the IdP to revoke its own refresh token (RFC 7009)
// and forgets the tokens, so a revoked machine can no longer mint gateway
// access tokens for the rest of the refresh token's lifetime (90 days on the
// bundled Authelia). It reads the credential file the running process
// loaded, wherever that lives (the galopin state dir, the pre-galopin
// opencode dir, or a --creds path), since that is the file the shim kept
// the latest rotated token in.
//
// The tokens are cleared from the file even when the IdP could not be
// reached: the machine is revoked either way, and a token nobody holds can
// no longer be used. The returned error says whether the IdP confirmed it.
func revokeRefreshToken(ctx context.Context, credsPath string) error {
	creds, err := loadCredentials(credsPath)
	if err != nil {
		return err
	}
	revokeErr := revokeAtIdP(ctx, creds)
	creds.RefreshToken = ""
	creds.AccessToken = ""
	creds.ExpiresIn = 0
	if err := saveCredentials(credsPath, creds); err != nil {
		return fmt.Errorf("clearing the revoked machine's tokens: %w", err)
	}
	return revokeErr
}

func revokeAtIdP(ctx context.Context, creds *credentials) error {
	endpoint := creds.RevocationEndpoint
	if endpoint == "" {
		// A credential written before enroll recorded the endpoint.
		doc, err := fetchDiscovery(ctx, creds.Issuer)
		if err != nil {
			return err
		}
		endpoint = doc.RevocationEndpoint
	}
	if endpoint == "" {
		return fmt.Errorf("the IdP at %s advertises no revocation endpoint", creds.Issuer)
	}
	form := url.Values{
		"token":           {creds.RefreshToken},
		"token_type_hint": {"refresh_token"},
		"client_id":       {creds.ClientID},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("revocation request: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	// RFC 7009 §2.2: 200 whether or not the token was still valid.
	if resp.StatusCode != http.StatusOK {
		return oauthErrorFromBody("revocation endpoint", body, resp.StatusCode)
	}
	return nil
}
