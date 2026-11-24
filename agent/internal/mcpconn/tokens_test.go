package mcpconn

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Two processes (two stores on one state dir) that find a token about to
// expire must refresh it once, not both present the same refresh token.
func TestTokenRefreshIsSerialisedAcrossStores(t *testing.T) {
	var calls atomic.Int32
	idp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		time.Sleep(150 * time.Millisecond) // a slow IdP widens the race
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "new", "refresh_token": "r2", "expires_in": 3600})
	}))
	defer idp.Close()
	dir := t.TempDir()
	a, b := NewTokenStore(dir, nil), NewTokenStore(dir, nil)
	if err := a.Save("srv", &StoredToken{AccessToken: "old", RefreshToken: "r1", ExpiresAt: time.Now().Add(10 * time.Second).Unix(),
		Server: "https://srv", ClientID: "c", TokenEndpoint: idp.URL}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for _, s := range []*TokenStore{a, b} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if h, err := s.Header(context.Background(), "srv", "https://srv"); err != nil || h != "Bearer new" {
				t.Errorf("header %q err %v", h, err)
			}
		}()
	}
	wg.Wait()
	if n := calls.Load(); n != 1 {
		t.Errorf("the IdP saw %d refreshes, want 1", n)
	}
}
