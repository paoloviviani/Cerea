package mcpconn

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// LoginOptions is one `galopin connectors login` (PROTOCOL.md §10.5): MCP
// authorization, the authorization-code flow with PKCE and a loopback
// redirect.
type LoginOptions struct {
	Entry  *Entry
	Store  *TokenStore
	Client *http.Client
	// Out receives the URL and progress lines.
	Out io.Writer
	// OpenBrowser is tried with the authorization URL; its error only means
	// the person must open the printed URL themselves.
	OpenBrowser func(url string) error
	Timeout     time.Duration // how long to wait for the browser (default 5 min)
}

type prMetadata struct {
	Resource             string   `json:"resource"`
	AuthorizationServers []string `json:"authorization_servers"`
	ScopesSupported      []string `json:"scopes_supported"`
}

type asMetadata struct {
	Issuer                string   `json:"issuer"`
	AuthorizationEndpoint string   `json:"authorization_endpoint"`
	TokenEndpoint         string   `json:"token_endpoint"`
	RegistrationEndpoint  string   `json:"registration_endpoint"`
	CodeChallengeMethods  []string `json:"code_challenge_methods_supported"`
	ScopesSupported       []string `json:"scopes_supported"`
}

var challengeParam = regexp.MustCompile(`([a-zA-Z_]+)="([^"]*)"`)

// Pending is a sign-in begun and not yet completed: the PKCE verifier and
// state, kept in memory only.
type Pending struct {
	AuthURL string

	entry        *Entry
	client       *http.Client
	issuer       string
	tokenURL     string
	clientID     string
	clientSecret string
	redirect     string
	verifier     string
	State        string
	Created      time.Time
}

// Begin starts the authorization-code flow for redirect: it reads the
// server's challenge and the metadata, registers a client dynamically (with
// that redirect), and builds the authorization URL. It does not wait.
func Begin(ctx context.Context, client *http.Client, e *Entry, redirect string) (*Pending, error) {
	if e.Transport == TransportStdio {
		return nil, fmt.Errorf("%s is a stdio server: its secrets belong in \"env\" in mcp.json, there is nothing to sign in to", e.Name)
	}
	if e.Invalid != "" {
		return nil, fmt.Errorf("%s is invalid: %s", e.Name, e.Invalid)
	}
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	// 1. What does the server say to a caller with no sign-in?
	challenge, err := challengeOf(ctx, client, e)
	if err != nil {
		return nil, err
	}
	params := map[string]string{}
	for _, m := range challengeParam.FindAllStringSubmatch(challenge, -1) {
		params[strings.ToLower(m[1])] = m[2]
	}

	// 2. Protected resource metadata, then the authorization server's.
	pr := fetchProtectedResource(ctx, client, e.URL, params["resource_metadata"])
	issuer := originOf(e.URL)
	if pr != nil && len(pr.AuthorizationServers) > 0 {
		issuer = pr.AuthorizationServers[0]
	}
	as, err := fetchAuthServer(ctx, client, issuer)
	if err != nil {
		return nil, err
	}
	if len(as.CodeChallengeMethods) > 0 && !contains(as.CodeChallengeMethods, "S256") {
		return nil, errors.New("the authorization server does not support PKCE S256")
	}
	scope := params["scope"]
	if scope == "" && pr != nil {
		scope = strings.Join(pr.ScopesSupported, " ")
	}

	clientID, clientSecret, err := registerClient(ctx, client, as, redirect, scope)
	if err != nil {
		return nil, err
	}
	verifier := randomString(48)
	sum := sha256.Sum256([]byte(verifier))
	state := randomString(24)
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {clientID},
		"redirect_uri":          {redirect},
		"state":                 {state},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(sum[:])},
		"code_challenge_method": {"S256"},
		"resource":              {e.URL},
	}
	if scope != "" {
		q.Set("scope", scope)
	}
	authURL, err := url.Parse(as.AuthorizationEndpoint)
	if err != nil {
		return nil, fmt.Errorf("the authorization endpoint is not a URL: %w", err)
	}
	existing := authURL.Query()
	for k, v := range q {
		existing[k] = v
	}
	authURL.RawQuery = existing.Encode()
	return &Pending{AuthURL: authURL.String(), entry: e, client: client, issuer: issuer, tokenURL: as.TokenEndpoint,
		clientID: clientID, clientSecret: clientSecret, redirect: redirect, verifier: verifier, State: state, Created: time.Now()}, nil
}

// Complete exchanges the code for tokens and stores them (0600). Tokens are
// never part of an error.
func (p *Pending) Complete(ctx context.Context, store *TokenStore, code string) error {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {p.redirect},
		"client_id":     {p.clientID},
		"code_verifier": {p.verifier},
		"resource":      {p.entry.URL},
	}
	if p.clientSecret != "" {
		form.Set("client_secret", p.clientSecret)
	}
	tr, err := postToken(ctx, p.client, p.tokenURL, form)
	if err != nil {
		return err
	}
	st := &StoredToken{Server: p.entry.URL, Issuer: p.issuer, TokenEndpoint: p.tokenURL, ClientID: p.clientID,
		ClientSecret: p.clientSecret, AccessToken: tr.AccessToken, RefreshToken: tr.RefreshToken, Scope: tr.Scope}
	if tr.ExpiresIn > 0 {
		st.ExpiresAt = time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second).Unix()
	}
	if err := store.Save(p.entry.Name, st); err != nil {
		return fmt.Errorf("storing the sign-in: %w", err)
	}
	return nil
}

// Login is the fallback sign-in on the machine itself: Begin with a loopback
// redirect, wait for the browser, Complete. Same module, same token store.
func Login(ctx context.Context, o LoginOptions) error {
	e := o.Entry
	if o.Timeout == 0 {
		o.Timeout = 5 * time.Minute
	}
	say := func(format string, args ...any) {
		if o.Out != nil {
			fmt.Fprintf(o.Out, format+"\n", args...)
		}
	}
	// A loopback listener first: the redirect URI, port included, is what
	// the client registers.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("cannot listen on the loopback interface: %w", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	pending, err := Begin(ctx, o.Client, e, fmt.Sprintf("http://127.0.0.1:%d/callback", port))
	if err != nil {
		return err
	}
	state := pending.State

	type callback struct{ code, err string }
	got := make(chan callback, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		qs := r.URL.Query()
		var cb callback
		switch {
		case qs.Get("state") != state:
			cb.err = "the answer carried the wrong state"
		case qs.Get("error") != "":
			cb.err = qs.Get("error")
			if d := qs.Get("error_description"); d != "" {
				cb.err += ": " + d
			}
		case qs.Get("code") == "":
			cb.err = "the answer carried no code"
		default:
			cb.code = qs.Get("code")
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if cb.err != "" {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "<p>Sign-in failed: %s</p>", html.EscapeString(cb.err))
		} else {
			fmt.Fprint(w, "<p>Signed in. You can close this tab and return to galopin.</p>")
		}
		select {
		case got <- cb:
		default:
		}
	})
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	say("Open this URL to sign in to %s:\n\n  %s\n", e.Name, pending.AuthURL)
	if o.OpenBrowser != nil {
		if err := o.OpenBrowser(pending.AuthURL); err != nil {
			say("(could not open a browser here: open the URL above on any machine that can reach 127.0.0.1:%d, or forward that port)", port)
		}
	}
	var cb callback
	select {
	case cb = <-got:
	case <-time.After(o.Timeout):
		return fmt.Errorf("no answer from the browser within %s", o.Timeout)
	case <-ctx.Done():
		return ctx.Err()
	}
	if cb.err != "" {
		return fmt.Errorf("sign-in failed: %s", cb.err)
	}
	if err := pending.Complete(ctx, o.Store, cb.code); err != nil {
		return err
	}
	say("Signed in to %s.", e.Name)
	return nil
}

// challengeOf asks the server, with no sign-in, and returns its
// WWW-Authenticate challenge.
func challengeOf(ctx context.Context, client *http.Client, e *Entry) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var req *http.Request
	var err error
	if e.Transport == TransportSSE {
		req, err = http.NewRequestWithContext(ctx, http.MethodGet, e.URL, nil)
		if err == nil {
			req.Header.Set("Accept", "text/event-stream")
		}
	} else {
		body := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"galopin","version":"0"}}}`
		req, err = http.NewRequestWithContext(ctx, http.MethodPost, e.URL, strings.NewReader(body))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "application/json, text/event-stream")
		}
	}
	if err != nil {
		return "", err
	}
	for k, v := range e.Headers {
		if !strings.EqualFold(k, "Authorization") {
			req.Header.Set(k, v)
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("cannot reach the server: %w", urlErr(err))
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		return "", fmt.Errorf("the server did not ask for a sign-in (it answered %s)", resp.Status)
	}
	return resp.Header.Get("WWW-Authenticate"), nil
}

func originOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	return u.Scheme + "://" + u.Host
}

func getJSON(ctx context.Context, client *http.Client, u string, v any) bool {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return false
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return err == nil && json.Unmarshal(body, v) == nil
}

// fetchProtectedResource reads the server's protected resource metadata
// (RFC 9728): where the challenge points, else the well-known URLs.
func fetchProtectedResource(ctx context.Context, client *http.Client, serverURL, hint string) *prMetadata {
	var candidates []string
	if hint != "" {
		candidates = append(candidates, hint)
	}
	if u, err := url.Parse(serverURL); err == nil {
		base := u.Scheme + "://" + u.Host + "/.well-known/oauth-protected-resource"
		if p := strings.TrimSuffix(u.Path, "/"); p != "" {
			candidates = append(candidates, base+p)
		}
		candidates = append(candidates, base)
	}
	for _, c := range candidates {
		var m prMetadata
		if getJSON(ctx, client, c, &m) {
			return &m
		}
	}
	return nil
}

// fetchAuthServer reads the authorization server's metadata (RFC 8414, then
// OpenID discovery), falling back to the default endpoints MCP names for a
// server that publishes none.
func fetchAuthServer(ctx context.Context, client *http.Client, issuer string) (*asMetadata, error) {
	u, err := url.Parse(issuer)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("the authorization server %q is not a URL", issuer)
	}
	origin := u.Scheme + "://" + u.Host
	path := strings.TrimSuffix(u.Path, "/")
	var candidates []string
	if path == "" {
		candidates = []string{origin + "/.well-known/oauth-authorization-server", origin + "/.well-known/openid-configuration"}
	} else {
		candidates = []string{origin + "/.well-known/oauth-authorization-server" + path,
			origin + "/.well-known/openid-configuration" + path, issuer + "/.well-known/openid-configuration"}
	}
	for _, c := range candidates {
		var m asMetadata
		if getJSON(ctx, client, c, &m) && m.AuthorizationEndpoint != "" && m.TokenEndpoint != "" {
			return &m, nil
		}
	}
	return &asMetadata{AuthorizationEndpoint: origin + "/authorize", TokenEndpoint: origin + "/token", RegistrationEndpoint: origin + "/register"}, nil
}

// registerClient registers galopin by dynamic client registration (RFC 7591).
func registerClient(ctx context.Context, client *http.Client, as *asMetadata, redirect, scope string) (id, secret string, err error) {
	if as.RegistrationEndpoint == "" {
		return "", "", errors.New("the authorization server offers no dynamic client registration, and galopin has no client id for it")
	}
	reg := map[string]any{
		"client_name":                "galopin",
		"redirect_uris":              []string{redirect},
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": "none",
	}
	if scope != "" {
		reg["scope"] = scope
	}
	body, _ := json.Marshal(reg)
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, as.RegistrationEndpoint, bytes.NewReader(body))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("registering the client failed: %w", urlErr(err))
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var out struct {
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
	}
	if resp.StatusCode/100 != 2 || json.Unmarshal(rb, &out) != nil || out.ClientID == "" {
		return "", "", fmt.Errorf("registering the client failed (%s)", resp.Status)
	}
	return out.ClientID, out.ClientSecret, nil
}

func randomString(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)[:n]
}
