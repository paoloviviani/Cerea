package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// recordingGateway records the headers of every request it gets.
type recordingGateway struct {
	srv   *httptest.Server
	mu    sync.Mutex
	reqs  []http.Header
	paths []string
	got   chan struct{}
}

func newRecordingGateway(t *testing.T) *recordingGateway {
	t.Helper()
	g := &recordingGateway{got: make(chan struct{}, 16)}
	g.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		g.reqs = append(g.reqs, r.Header.Clone())
		g.paths = append(g.paths, r.URL.Path)
		g.mu.Unlock()
		select {
		case g.got <- struct{}{}:
		default:
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"type":"error","error":{"type":"api_error","message":"recorded"}}`))
	}))
	t.Cleanup(g.srv.Close)
	return g
}

func (g *recordingGateway) first(t *testing.T) (http.Header, string) {
	t.Helper()
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.reqs) == 0 {
		t.Fatal("the gateway got no request")
	}
	return g.reqs[0], g.paths[0]
}

func post(t *testing.T, url, bearer string, hdr map[string]string) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader("{}"))
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func TestShimDropsClientAuthHeadersAndAcceptsLaunchSecrets(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	g := newRecordingGateway(t)
	creds := *r.creds_
	creds.Gateway = g.srv.URL + "/v1"
	stop, sh, err := ensureProxyShim(&creds, r.creds, r.port, func(string, ...any) {})
	if err != nil || sh == nil {
		t.Fatalf("proxy: %v %v", sh, err)
	}
	defer stop()
	url := "http://127.0.0.1:" + itPortStr(r.port) + "/v1/messages"
	sec, _ := newLaunchSecret()
	if err := sh.addLaunchSecret(sec, os.Getpid()); err != nil {
		t.Fatal(err)
	}

	st := post(t, url, sec, map[string]string{
		"X-Api-Key": "sk-helper", "Anthropic-Api-Key": "sk-2", "Api-Key": "k3", "Proxy-Authorization": "Basic x", "Cookie": "c=1",
	})
	if st != http.StatusInternalServerError {
		t.Fatalf("status %d, want the gateway's 500 (the request must reach it)", st)
	}
	h, path := g.first(t)
	if path != "/v1/messages" {
		t.Errorf("path %q", path)
	}
	if got := h.Get("Authorization"); got == "" || strings.Contains(got, sec) || strings.Contains(got, creds.ShimSecret) {
		t.Errorf("Authorization = %q, want the gateway credential only", got)
	}
	for _, name := range []string{"X-Api-Key", "Anthropic-Api-Key", "Api-Key", "Proxy-Authorization", "Cookie"} {
		if h.Get(name) != "" {
			t.Errorf("%s reached the gateway: %q", name, h.Get(name))
		}
	}
	// both secrets work; a made-up one and a withdrawn one do not
	if st := post(t, url, creds.ShimSecret, nil); st != http.StatusInternalServerError {
		t.Errorf("install secret: %d", st)
	}
	if st := post(t, url, "gl-nope-nope-nope-nope", nil); st != http.StatusUnauthorized {
		t.Errorf("unknown secret: %d", st)
	}
	// a per-launch secret cannot register another
	if st := post(t, "http://127.0.0.1:"+itPortStr(r.port)+shimLaunchSecretPath, sec, nil); st != http.StatusUnauthorized {
		t.Errorf("launch secret reached the registration endpoint: %d", st)
	}
	sh.dropLaunchSecret(sec)
	if st := post(t, url, sec, nil); st != http.StatusUnauthorized {
		t.Errorf("withdrawn secret: %d", st)
	}
}

func TestReusedProxyIsChallengedWithoutSendingTheSecret(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	stop, _, err := ensureProxyShim(r.creds_, r.creds, r.port, func(string, ...any) {})
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	addr := "127.0.0.1:" + itPortStr(r.port)
	if !shimIsOurs(addr, r.creds_.ShimSecret) {
		t.Fatal("our own proxy was not recognised")
	}
	if shimIsOurs(addr, "some-other-install-secret") {
		t.Error("a proxy answered a challenge for a secret it does not hold")
	}
	// a listener that records what it is sent never sees the secret
	var seen strings.Builder
	var mu sync.Mutex
	foreign := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		seen.WriteString(req.URL.String() + req.Header.Get("Authorization"))
		mu.Unlock()
		w.WriteHeader(404)
	}))
	foreign.Start()
	defer foreign.Close()
	if shimIsOurs(strings.TrimPrefix(foreign.URL, "http://"), r.creds_.ShimSecret) {
		t.Error("a foreign listener was accepted")
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Contains(seen.String(), r.creds_.ShimSecret) {
		t.Errorf("the secret was sent to a foreign listener: %s", seen.String())
	}
}

func TestLaunchRegistersItsSecretWithARunningProxy(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	g := newRecordingGateway(t)
	creds := *r.creds_
	creds.Gateway = g.srv.URL + "/v1"
	stop, _, err := ensureProxyShim(&creds, r.creds, r.port, func(string, ...any) {})
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	ls := &launchSession{creds: &creds, credsPath: r.creds, logf: func(string, ...any) {}}
	if err := ls.startProxy(launchOptions{port: r.port}); err != nil {
		t.Fatal(err)
	}
	if ls.toolSecret == creds.ShimSecret || !strings.HasPrefix(ls.toolSecret, "gl-") {
		t.Fatalf("toolSecret = %q, want a per-launch secret", ls.toolSecret)
	}
	url := "http://127.0.0.1:" + itPortStr(r.port) + "/v1/chat/completions"
	if st := post(t, url, ls.toolSecret, nil); st != http.StatusInternalServerError {
		t.Errorf("the registered secret was refused: %d", st)
	}
	ls.close()
	if st := post(t, url, ls.toolSecret, nil); st != http.StatusUnauthorized {
		t.Errorf("the secret still works after the launch ended: %d", st)
	}
}

// The real Claude Code, with a user settings file that tries to bring back an
// API key, an apiKeyHelper, extra headers and a Bedrock route: the gateway must
// see the proxy's request, with only the gateway credential.
func TestLaunchClaudeIsNotRedirectedByUserSettings(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	real, err := exec.LookPath("claude")
	if err != nil {
		t.Skip("claude is not installed")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	r := newLaunchRig(t, 0, "x")
	g := newRecordingGateway(t)
	creds := *r.creds_
	creds.Gateway = g.srv.URL + "/v1"
	if err := saveCredentials(r.creds, &creds); err != nil {
		t.Fatal(err)
	}
	helper := filepath.Join(home, "helper.sh")
	if err := os.WriteFile(helper, []byte("#!/bin/sh\necho sk-from-helper\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	userSettings := `{"apiKeyHelper":"` + helper + `","env":{"ANTHROPIC_API_KEY":"sk-user-env","ANTHROPIC_CUSTOM_HEADERS":"X-Evil: 1","CLAUDE_CODE_USE_BEDROCK":"1","ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}`
	if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"), []byte(userSettings), 0o600); err != nil {
		t.Fatal(err)
	}
	o := r.opts("-p", "hi")
	o.claudeBin, o.model = real, "gw-model"
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	go func() {
		select {
		case <-g.got:
			time.Sleep(300 * time.Millisecond)
		case <-ctx.Done():
		}
		cancel()
	}()
	_ = launchClaude(ctx, o)
	h, path := g.first(t)
	if !strings.HasPrefix(path, "/v1/messages") {
		t.Errorf("path = %q, want /v1/messages", path)
	}
	if h.Get("X-Api-Key") != "" || h.Get("X-Evil") != "" {
		t.Errorf("a user-settings credential or header reached the gateway: %v", h)
	}
	if a := h.Get("Authorization"); a == "" || strings.Contains(a, "gl-") {
		t.Errorf("Authorization = %q, want the gateway credential", a)
	}
	if s := leakedKey(h); s != "" {
		t.Error(s)
	}
}

func leakedKey(h http.Header) string {
	for k, v := range h {
		for _, x := range v {
			if strings.Contains(x, "sk-from-helper") || strings.Contains(x, "sk-user-env") {
				return "key leaked in header " + k
			}
		}
	}
	return ""
}

func TestLaunchAgainstAnOlderProxySaysToRestartIt(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	ln, err := net.Listen("tcp", "127.0.0.1:"+itPortStr(r.port))
	if err != nil {
		t.Fatal(err)
	}
	var sawSecret atomic.Bool
	old := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "" {
			sawSecret.Store(true)
		}
		// what a galopin before whoami answers to everything without the secret
		writeOpenAIError(w, http.StatusUnauthorized, "missing or invalid shim secret", "invalid_request_error", "invalid_api_key")
	}))
	old.Listener.Close()
	old.Listener = ln
	old.Start()
	defer old.Close()
	for name, run := range map[string]func() error{
		"opencode": func() error { return launchOpencode(context.Background(), r.opts()) },
		"claude": func() error {
			o := r.opts()
			o.claudeBin, o.model = "/bin/true", "m"
			return launchClaude(context.Background(), o)
		},
	} {
		err := run()
		if err == nil || !strings.Contains(err.Error(), "older galopin") || !strings.Contains(err.Error(), "systemctl --user restart galopin") || !strings.Contains(err.Error(), "galopin run") {
			t.Errorf("%s: err = %v, want the restart-the-older-galopin message", name, err)
		}
	}
	if sawSecret.Load() {
		t.Error("a credential was sent to the older proxy")
	}
}

func TestLaunchSecretExpiresWhenItsLauncherIsGone(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	g := newRecordingGateway(t)
	creds := *r.creds_
	creds.Gateway = g.srv.URL + "/v1"
	stop, sh, err := ensureProxyShim(&creds, r.creds, r.port, func(string, ...any) {})
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	base := "http://127.0.0.1:" + itPortStr(r.port)
	// a launcher that is a real process of ours, registered over HTTP
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	sec, _ := newLaunchSecret()
	if err := sh.addLaunchSecret(sec, cmd.Process.Pid); err != nil {
		t.Fatal(err)
	}
	if st := post(t, base+"/v1/messages", sec, nil); st != http.StatusInternalServerError {
		t.Fatalf("live launcher's secret: %d", st)
	}
	_ = cmd.Process.Kill()
	_, _ = cmd.Process.Wait()
	if st := post(t, base+"/v1/messages", sec, nil); st != http.StatusUnauthorized {
		t.Errorf("secret of a dead launcher still works: %d", st)
	}
	sh.mu.Lock()
	n := len(sh.launchSecrets)
	sh.mu.Unlock()
	if n != 0 {
		t.Errorf("%d secrets kept for a dead launcher", n)
	}
	// registering for a pid that is not alive is refused; so is one it does not own (pid 1)
	dead := exec.Command("true")
	_ = dead.Run()
	if err := sh.addLaunchSecret("gl-0123456789abcdef0123", dead.Process.Pid); err == nil {
		t.Error("registered a secret for an exited pid")
	}
	if os.Geteuid() != 0 {
		if err := sh.addLaunchSecret("gl-0123456789abcdef0124", 1); err == nil {
			t.Error("registered a secret for another user's process")
		}
	}
	// the periodic sweep also forgets one nobody uses
	cmd2 := exec.Command("sleep", "30")
	_ = cmd2.Start()
	if err := sh.addLaunchSecret("gl-0123456789abcdef0125", cmd2.Process.Pid); err != nil {
		t.Fatal(err)
	}
	_ = cmd2.Process.Kill()
	_, _ = cmd2.Process.Wait()
	sh.mu.Lock()
	sh.sweepLaunchSecretsLocked()
	n = len(sh.launchSecrets)
	sh.mu.Unlock()
	if n != 0 {
		t.Errorf("sweep left %d secrets", n)
	}
}

func TestLaunchSecretRegistrationLimits(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	stop, sh, err := ensureProxyShim(r.creds_, r.creds, r.port, func(string, ...any) {})
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	if err := sh.addLaunchSecret("short", os.Getpid()); err == nil {
		t.Error("a short secret was accepted")
	}
	if err := sh.addLaunchSecret(strings.Repeat("a", maxLaunchSecretLen+1), os.Getpid()); err == nil {
		t.Error("an over-long secret was accepted")
	}
	for i := 0; i < maxLaunchSecrets; i++ {
		if err := sh.addLaunchSecret(fmt.Sprintf("gl-%020d", i), os.Getpid()); err != nil {
			t.Fatalf("registration %d: %v", i, err)
		}
	}
	// over HTTP, as a second launcher would, the refusal is readable
	_, err = registerLaunchSecret("127.0.0.1:"+itPortStr(r.port), r.creds_.ShimSecret, "gl-one-too-many-secret")
	if err == nil || !strings.Contains(err.Error(), "too many") {
		t.Errorf("err = %v, want a 'too many launches' refusal", err)
	}
}
