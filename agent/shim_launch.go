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
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"syscall"
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
	// keyed by a derivation of the secret, never the secret itself
	d := hmac.New(sha256.New, []byte(secret))
	d.Write([]byte("galopin-whoami-v1"))
	m := hmac.New(sha256.New, d.Sum(nil))
	m.Write([]byte(nonce))
	return hex.EncodeToString(m.Sum(nil))
}

const (
	maxLaunchSecrets   = 256
	maxLaunchSecretLen = 128
	minLaunchSecretLen = 16
)

// pidAliveOwned reports whether pid is a live process this user may signal
// (so it is this user's). A process that is gone, or another user's, is false.
func pidAliveOwned(pid int) bool {
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = p.Signal(syscall.Signal(0))
	switch {
	case err == nil:
		return true
	case errors.Is(err, os.ErrProcessDone), errors.Is(err, syscall.EPERM):
		return false
	default:
		return true // cannot tell on this platform: do not expire
	}
}

func (s *shim) launcherAlive(pid int) bool {
	if s.pidAlive != nil {
		return s.pidAlive(pid)
	}
	return pidAliveOwned(pid)
}

// addLaunchSecret registers sec for as long as the launcher process pid lives.
func (s *shim) addLaunchSecret(sec string, pid int) error {
	if len(sec) < minLaunchSecretLen || len(sec) > maxLaunchSecretLen {
		return fmt.Errorf("the secret must be %d to %d characters", minLaunchSecretLen, maxLaunchSecretLen)
	}
	if !s.launcherAlive(pid) {
		return fmt.Errorf("process %d is not a live process of this user", pid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLaunchSecretsLocked()
	if _, have := s.launchSecrets[sec]; !have && len(s.launchSecrets) >= maxLaunchSecrets {
		return fmt.Errorf("too many launches registered with this proxy (%d)", maxLaunchSecrets)
	}
	if s.launchSecrets == nil {
		s.launchSecrets = map[string]int{}
	}
	s.launchSecrets[sec] = pid
	return nil
}

func (s *shim) dropLaunchSecret(sec string) {
	s.mu.Lock()
	delete(s.launchSecrets, sec)
	s.mu.Unlock()
}

// sweepLaunchSecretsLocked forgets the secrets of launchers that are gone
// (killed without withdrawing them). Caller holds s.mu.
func (s *shim) sweepLaunchSecretsLocked() {
	for sec, pid := range s.launchSecrets {
		if !s.launcherAlive(pid) {
			delete(s.launchSecrets, sec)
		}
	}
}

// authorized reports whether the request carries the install's secret or, when
// launchOK, a registered per-launch one whose launcher is still alive.
func (s *shim) authorized(r *http.Request, launchOK bool) bool {
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	s.mu.Lock()
	defer s.mu.Unlock()
	if secretMatches(s.creds.ShimSecret, got) {
		return true
	}
	if !launchOK {
		return false
	}
	ok := false
	for sec, pid := range s.launchSecrets {
		if !secretMatches(sec, got) {
			continue
		}
		if s.launcherAlive(pid) {
			ok = true
		} else {
			delete(s.launchSecrets, sec)
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
		PID    int    `json:"pid"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil || body.Secret == "" {
		http.Error(w, "secret required", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodPost:
		if err := s.addLaunchSecret(body.Secret, body.PID); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
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

type shimProbe int

const (
	probeForeign shimProbe = iota // not a galopin proxy of this install
	probeOurs                     // answered the challenge
	probeOlder                    // a galopin proxy too old to answer it
)

// probeShim challenges the listener at addr without sending it any secret: a
// current proxy returns the HMAC of a fresh nonce under this install's secret.
// An older galopin has no such route and answers 401 "invalid shim secret",
// which is how it is told apart from some other server (it is never probed with
// the secret).
func probeShim(addr, secret string) shimProbe {
	nb := make([]byte, 16)
	if _, err := rand.Read(nb); err != nil {
		return probeForeign
	}
	nonce := hex.EncodeToString(nb)
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://" + addr + shimWhoamiPath + "?nonce=" + nonce)
	if err != nil {
		return probeForeign
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode == http.StatusUnauthorized && strings.Contains(string(body), "invalid shim secret") {
		return probeOlder
	}
	if resp.StatusCode != http.StatusOK {
		return probeForeign
	}
	var out struct {
		Proof string `json:"proof"`
	}
	if json.Unmarshal(body, &out) != nil || !hmac.Equal([]byte(out.Proof), []byte(shimProof(secret, nonce))) {
		return probeForeign
	}
	return probeOurs
}

func shimIsOurs(addr, secret string) bool { return probeShim(addr, secret) == probeOurs }

// registerLaunchSecret tells a verified, already-running shim to accept sec;
// the returned func withdraws it.
func registerLaunchSecret(addr, mainSecret, sec string) (func(), error) {
	do := func(method string) error {
		b, _ := json.Marshal(map[string]any{"secret": sec, "pid": os.Getpid()})
		req, err := http.NewRequest(method, "http://"+addr+shimLaunchSecretPath, strings.NewReader(string(b)))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+mainSecret)
		resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusNoContent {
			msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
			return fmt.Errorf("the running proxy answered %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
		}
		return nil
	}
	if err := do(http.MethodPost); err != nil {
		return nil, err
	}
	return func() { _ = do(http.MethodDelete) }, nil
}
