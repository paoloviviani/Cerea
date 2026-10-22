package mcpconn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// StoredToken is one server's OAuth sign-in (PROTOCOL.md §10.5), kept 0600
// in galopin's state directory and never sent anywhere but that server.
type StoredToken struct {
	Server        string `json:"server"` // the url it was issued for
	Issuer        string `json:"issuer"`
	TokenEndpoint string `json:"tokenEndpoint"`
	ClientID      string `json:"clientId"`
	ClientSecret  string `json:"clientSecret,omitempty"`
	AccessToken   string `json:"accessToken"`
	RefreshToken  string `json:"refreshToken,omitempty"`
	ExpiresAt     int64  `json:"expiresAt,omitempty"` // unix seconds; 0 = unknown
	Scope         string `json:"scope,omitempty"`
}

// TokenStore keeps the sign-ins of the machine's servers, one file each.
type TokenStore struct {
	dir    string
	client *http.Client

	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

// NewTokenStore keeps tokens under <stateDir>/connectors.
func NewTokenStore(stateDir string, client *http.Client) *TokenStore {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &TokenStore{dir: filepath.Join(stateDir, "connectors"), client: client, locks: map[string]*sync.Mutex{}}
}

func (s *TokenStore) path(name string) string { return filepath.Join(s.dir, name+".json") }

func (s *TokenStore) lock(name string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.locks[name] == nil {
		s.locks[name] = &sync.Mutex{}
	}
	return s.locks[name]
}

// Load returns the stored sign-in for name if it was issued for serverURL.
func (s *TokenStore) Load(name, serverURL string) *StoredToken {
	body, err := os.ReadFile(s.path(name))
	if err != nil {
		return nil
	}
	var t StoredToken
	if json.Unmarshal(body, &t) != nil || t.AccessToken == "" || t.Server != serverURL {
		return nil
	}
	return &t
}

// Save writes the sign-in atomically at 0600.
func (s *TokenStore) Save(name string, t *StoredToken) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	body, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, ".tok-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(body, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path(name))
}

// Delete forgets the sign-in.
func (s *TokenStore) Delete(name string) { _ = os.Remove(s.path(name)) }

// errNoToken means there is nothing to send: no sign-in stored.
var errNoToken = errors.New("no stored sign-in")

// Header is the Authorization value for the server, refreshing the token
// first when it is within a minute of expiry. "" with no error: no sign-in.
func (s *TokenStore) Header(ctx context.Context, name, serverURL string) (string, error) {
	l := s.lock(name)
	l.Lock()
	defer l.Unlock()
	t := s.Load(name, serverURL)
	if t == nil {
		return "", nil
	}
	if t.ExpiresAt != 0 && time.Until(time.Unix(t.ExpiresAt, 0)) < time.Minute && t.RefreshToken != "" {
		if nt, err := s.refreshLocked(ctx, name, t); err == nil {
			t = nt
		}
		// A failed refresh sends the old token: the server's 401 decides.
	}
	return "Bearer " + t.AccessToken, nil
}

// Refresh forces a refresh (after a 401). It fails when there is no refresh
// token or the authorization server refuses it.
func (s *TokenStore) Refresh(ctx context.Context, name, serverURL string) error {
	l := s.lock(name)
	l.Lock()
	defer l.Unlock()
	t := s.Load(name, serverURL)
	if t == nil || t.RefreshToken == "" {
		return errNoToken
	}
	_, err := s.refreshLocked(ctx, name, t)
	return err
}

func (s *TokenStore) refreshLocked(ctx context.Context, name string, t *StoredToken) (*StoredToken, error) {
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {t.RefreshToken},
		"client_id":     {t.ClientID},
		"resource":      {t.Server},
	}
	if t.ClientSecret != "" {
		form.Set("client_secret", t.ClientSecret)
	}
	tr, err := postToken(ctx, s.client, t.TokenEndpoint, form)
	if err != nil {
		return nil, err
	}
	nt := *t
	nt.AccessToken = tr.AccessToken
	if tr.RefreshToken != "" {
		nt.RefreshToken = tr.RefreshToken
	}
	nt.ExpiresAt = 0
	if tr.ExpiresIn > 0 {
		nt.ExpiresAt = time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second).Unix()
	}
	if tr.Scope != "" {
		nt.Scope = tr.Scope
	}
	if err := s.Save(name, &nt); err != nil {
		return nil, err
	}
	return &nt, nil
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope"`
	TokenType    string `json:"token_type"`
	Error        string `json:"error"`
	ErrorDesc    string `json:"error_description"`
}

// postToken posts a token request. It never echoes tokens in an error.
func postToken(ctx context.Context, client *http.Client, endpoint string, form url.Values) (*tokenResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var tr tokenResponse
	_ = json.Unmarshal(body, &tr)
	if resp.StatusCode/100 != 2 || tr.Error != "" {
		msg := tr.Error
		if tr.ErrorDesc != "" {
			msg += ": " + tr.ErrorDesc
		}
		if msg == "" {
			msg = resp.Status
		}
		return nil, fmt.Errorf("the authorization server refused the token request: %s", msg)
	}
	if tr.AccessToken == "" {
		return nil, errors.New("the authorization server's answer has no access_token")
	}
	return &tr, nil
}

// ModTime is when the sign-in file was last written (zero if none).
func (s *TokenStore) ModTime(name string) time.Time {
	st, err := os.Stat(s.path(name))
	if err != nil {
		return time.Time{}
	}
	return st.ModTime()
}
