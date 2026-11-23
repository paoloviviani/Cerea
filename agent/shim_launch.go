package main

// Per-launch secrets and the secret-free identity check that 'galopin launch'
// uses (see launch_cmd.go). A launched tool must not hold the install's
// long-lived shim secret: tools hand their environment to Bash-tool children,
// hooks and MCP servers. It gets a random secret the shim accepts only until
// the launch ends (or the shim restarts).

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	shimWhoamiPath       = "/galopin/whoami"
	shimLaunchSecretPath = "/galopin/launch-secret"
)

// clientAuthHeaders are credential-bearing request headers a caller must never
// get through to the gateway: the shim, not the tool, owns the credential. A
// tool (or a settings file it loads) that adds one of its own, an Anthropic
// X-Api-Key from an apiKeyHelper for example, would otherwise ride along.
var clientAuthHeaders = map[string]bool{
	"Authorization": true, "Proxy-Authorization": true, "X-Api-Key": true, "Api-Key": true,
	"Anthropic-Api-Key": true, "X-Goog-Api-Key": true, "Openai-Api-Key": true, "Cookie": true,
}

func newLaunchSecret() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "gl-" + hex.EncodeToString(b), nil
}

// shimProof is the answer to a whoami challenge: only a holder of the install's
// secret can compute it, and it reveals nothing about the secret.
func shimProof(secret, nonce string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte("galopin-whoami:" + nonce))
	return hex.EncodeToString(m.Sum(nil))
}

func (s *shim) addLaunchSecret(sec string) {
	s.mu.Lock()
	if s.launchSecrets == nil {
		s.launchSecrets = map[string]struct{}{}
	}
	s.launchSecrets[sec] = struct{}{}
	s.mu.Unlock()
}

func (s *shim) dropLaunchSecret(sec string) {
	s.mu.Lock()
	delete(s.launchSecrets, sec)
	s.mu.Unlock()
}

// authorized reports whether the request carries the install's secret or, when
// launchOK, a registered per-launch one.
func (s *shim) authorized(r *http.Request, launchOK bool) bool {
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	s.mu.Lock()
	want := s.creds.ShimSecret
	var extra []string
	if launchOK {
		for k := range s.launchSecrets {
			extra = append(extra, k)
		}
	}
	s.mu.Unlock()
	ok := secretMatches(want, got)
	for _, e := range extra {
		if secretMatches(e, got) {
			ok = true
		}
	}
	return ok
}

func (s *shim) whoamiHandler(w http.ResponseWriter, r *http.Request) {
	nonce := r.URL.Query().Get("nonce")
	if len(nonce) < 16 || len(nonce) > 128 {
		http.Error(w, "nonce required", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	secret := s.creds.ShimSecret
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"proof": shimProof(secret, nonce)})
}

// launchSecretHandler registers (POST) or withdraws (DELETE) a per-launch
// secret. It needs the install's own secret, never a per-launch one.
func (s *shim) launchSecretHandler(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Secret string `json:"secret"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil || len(body.Secret) < 16 {
		http.Error(w, "secret required", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodPost:
		s.addLaunchSecret(body.Secret)
	case http.MethodDelete:
		s.dropLaunchSecret(body.Secret)
	default:
		http.Error(w, "POST or DELETE", http.StatusMethodNotAllowed)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// mux is the shim's routes, shared by run, serve and launch.
func (s *shim) mux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/galopin/health", s.requireLocalAuth(s.healthHandler))
	mux.HandleFunc(shimWhoamiPath, s.requireLocalHost(s.whoamiHandler))
	mux.HandleFunc(shimLaunchSecretPath, s.requireMainAuth(s.launchSecretHandler))
	mux.HandleFunc("/", s.requireLocalAuth(s.handler))
	return mux
}

func (s *shim) requireLocalHost(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.allowedHost(r.Host) {
			http.Error(w, "forbidden: unexpected Host", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

func (s *shim) requireMainAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.allowedHost(r.Host) {
			http.Error(w, "forbidden: unexpected Host", http.StatusForbidden)
			return
		}
		if !s.authorized(r, false) {
			writeOpenAIError(w, http.StatusUnauthorized, "missing or invalid shim secret", "invalid_request_error", "invalid_api_key")
			return
		}
		next(w, r)
	}
}

// shimIsOurs challenges the listener at addr without sending it any secret:
// it must return the HMAC of a fresh nonce under this install's secret.
func shimIsOurs(addr, secret string) bool {
	nb := make([]byte, 16)
	if _, err := rand.Read(nb); err != nil {
		return false
	}
	nonce := hex.EncodeToString(nb)
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://" + addr + shimWhoamiPath + "?nonce=" + nonce)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var out struct {
		Proof string `json:"proof"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&out) != nil {
		return false
	}
	return hmac.Equal([]byte(out.Proof), []byte(shimProof(secret, nonce)))
}

// registerLaunchSecret tells a verified, already-running shim to accept sec;
// the returned func withdraws it.
func registerLaunchSecret(addr, mainSecret, sec string) (func(), error) {
	do := func(method string) error {
		b, _ := json.Marshal(map[string]string{"secret": sec})
		req, err := http.NewRequest(method, "http://"+addr+shimLaunchSecretPath, strings.NewReader(string(b)))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+mainSecret)
		resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
		if err != nil {
			return err
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNoContent {
			return fmt.Errorf("the running proxy answered %d", resp.StatusCode)
		}
		return nil
	}
	if err := do(http.MethodPost); err != nil {
		return nil, err
	}
	return func() { _ = do(http.MethodDelete) }, nil
}
