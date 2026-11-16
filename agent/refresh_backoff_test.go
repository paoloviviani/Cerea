package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		in   string
		want time.Duration
	}{
		{"", 0},
		{"120", 120 * time.Second},
		{" 7 ", 7 * time.Second},
		{"0", 0},
		{"-5", 0},
		{"soon", 0},
		{now.Add(90 * time.Second).UTC().Format(http.TimeFormat), 90 * time.Second},
		{now.Add(-time.Minute).UTC().Format(http.TimeFormat), 0},
	}
	for _, c := range cases {
		if got := parseRetryAfter(c.in, now); got != c.want {
			t.Errorf("parseRetryAfter(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestRefreshBackoffGrowsCapsAndResets(t *testing.T) {
	b := refreshBackoff{rand01: func() float64 { return 0.5 }} // no jitter
	now := time.Now()
	var got []time.Duration
	for range 7 {
		got = append(got, b.fail(now, 0, "x"))
	}
	want := []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 10 * time.Minute, 10 * time.Minute}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("wait %d = %v, want %v (all: %v)", i, got[i], want[i], got)
		}
	}
	if b.waiting(now.Add(9*time.Minute)) == 0 || b.waiting(now.Add(11*time.Minute)) != 0 {
		t.Fatal("waiting() does not follow until")
	}
	b.reset()
	if b.waiting(now) != 0 || b.fail(now, 0, "x") != 30*time.Second {
		t.Fatal("reset did not restart the growth from 30s")
	}
}

func TestRefreshBackoffJitterStaysInBand(t *testing.T) {
	for _, r := range []float64{0, 0.999} {
		b := refreshBackoff{rand01: func() float64 { return r }}
		w := b.fail(time.Now(), 0, "x")
		if w < 24*time.Second || w > 36*time.Second {
			t.Fatalf("jittered 30s wait = %v, want within 24-36s", w)
		}
	}
}

func TestRefreshBackoffHonoursRetryAfter(t *testing.T) {
	b := refreshBackoff{}
	if w := b.fail(time.Now(), 4*time.Minute, "x"); w != 4*time.Minute {
		t.Fatalf("wait = %v, want the server's 4m", w)
	}
	if w := b.fail(time.Now(), 5*time.Hour, "x"); w != refreshRetryAfterMax {
		t.Fatalf("absurd Retry-After not clamped: %v", w)
	}
}

func TestHumanWait(t *testing.T) {
	for in, want := range map[time.Duration]string{45 * time.Second: "45s", 4 * time.Minute: "4m", 10 * time.Minute: "10m", 2 * time.Hour: "2h"} {
		if got := humanWait(in); got != want {
			t.Errorf("humanWait(%v) = %q, want %q", in, got, want)
		}
	}
}

// limitedTokenServer answers 429 (with an optional Retry-After) until ok is
// set, then a fresh token; calls counts every hit.
func limitedTokenServer(t *testing.T, retryAfter string, ok *atomic.Bool) (*httptest.Server, *int32) {
	t.Helper()
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		if ok.Load() {
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fresh", "expires_in": 300})
			return
		}
		if retryAfter != "" {
			w.Header().Set("Retry-After", retryAfter)
		}
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error": "temporarily_unavailable", "error_description": "Too many requests. The endpoint is temporarily unavailable. Try again later.",
		})
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func TestShimBacksOffWhenRateLimited(t *testing.T) {
	var ok atomic.Bool
	srv, calls := limitedTokenServer(t, "240", &ok)
	dir := t.TempDir()
	sh := newShim(expiredCreds(srv.URL), filepath.Join(dir, "credentials.json"), filepath.Join(dir, "status.json"), 0)

	err := sh.refresh()
	var wait *refreshWaitError
	if !errors.As(err, &wait) || wait.RetryAfter() != 4*time.Minute {
		t.Fatalf("first refresh err = %v, want a 4m wait", err)
	}
	if !strings.Contains(err.Error(), "the sign-in server is rate-limiting; retrying in 4m") {
		t.Fatalf("message not clear: %v", err)
	}
	// Every other caller: the proxy, the link (Token and ForceRefresh), the timer.
	_, _ = sh.token()
	_, _ = sh.ForceRefresh(context.Background())
	_ = sh.refresh()
	if n := atomic.LoadInt32(calls); n != 1 {
		t.Fatalf("the IdP was called %d times while backing off, want 1", n)
	}
	// The link learns how long to wait.
	if _, err := sh.Token(context.Background()); retryAfterOf(err) <= 0 {
		t.Fatalf("link error carries no RetryAfter: %v", err)
	}

	// Wait over and the server recovered: one call, backoff cleared.
	ok.Store(true)
	sh.mu.Lock()
	sh.backoff.until = time.Now().Add(-time.Second)
	sh.mu.Unlock()
	tok, err := sh.token()
	if err != nil || tok != "fresh" {
		t.Fatalf("after the wait: %q, %v", tok, err)
	}
	sh.mu.Lock()
	step := sh.backoff.step
	sh.mu.Unlock()
	if step != 0 {
		t.Fatal("a successful refresh did not reset the backoff")
	}
}

func TestShimServesAStillValidTokenWhileBackingOff(t *testing.T) {
	var ok atomic.Bool
	srv, calls := limitedTokenServer(t, "", &ok)
	dir := t.TempDir()
	creds := expiredCreds(srv.URL)
	creds.AccessToken, creds.ExpiresIn, creds.ObtainedAt = "still-good", 300, time.Now().Add(-270*time.Second).Unix() // inside the 60s skew, not expired
	sh := newShim(creds, filepath.Join(dir, "credentials.json"), filepath.Join(dir, "status.json"), 0)
	for range 3 {
		tok, err := sh.token()
		if err != nil || tok != "still-good" {
			t.Fatalf("token = %q, %v; want the live token", tok, err)
		}
	}
	if n := atomic.LoadInt32(calls); n != 1 {
		t.Fatalf("IdP called %d times, want 1", n)
	}
}

func TestShimConcurrentCallersShareOneRefresh(t *testing.T) {
	var ok atomic.Bool
	ok.Store(true)
	srv, calls := limitedTokenServer(t, "", &ok)
	dir := t.TempDir()
	sh := newShim(expiredCreds(srv.URL), filepath.Join(dir, "credentials.json"), filepath.Join(dir, "status.json"), 0)
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if tok, err := sh.token(); err != nil || tok != "fresh" {
				t.Errorf("token = %q, %v", tok, err)
			}
		}()
	}
	wg.Wait()
	if n := atomic.LoadInt32(calls); n != 1 {
		t.Fatalf("%d concurrent callers made %d refreshes, want 1", 20, n)
	}
}

func TestDeviceFlowBacksOffOnRateLimit(t *testing.T) {
	stub := newStubDeviceServer(t, func(call int) (int, string) {
		switch call {
		case 1:
			return http.StatusTooManyRequests, `{"error":"temporarily_unavailable","error_description":"Too many requests"}`
		case 2, 3:
			return http.StatusTooManyRequests, `not json`
		case 4:
			return http.StatusBadRequest, `{"error":"authorization_pending"}`
		}
		return http.StatusOK, `{"access_token":"at","refresh_token":"rt","expires_in":300}`
	})
	var sleeps []time.Duration
	hooks := noopHooks()
	hooks.sleep = func(_ context.Context, d time.Duration) error { sleeps = append(sleeps, d); return nil }
	tokens, err := runDeviceFlowWithHooks(context.Background(), docFor(stub), "opencode-enrollment", hooks)
	if err != nil || tokens.AccessToken != "at" {
		t.Fatalf("flow: %v, %+v", err, tokens)
	}
	// advertised 1s; each limit doubles the wait; pending leaves it as is.
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 8 * time.Second}
	if len(sleeps) != len(want) {
		t.Fatalf("sleeps = %v, want %v", sleeps, want)
	}
	for i := range want {
		if sleeps[i] != want[i] {
			t.Fatalf("sleeps = %v, want %v", sleeps, want)
		}
	}
}

func TestDeviceFlowBackoffCapsAtAMinuteAndHonoursRetryAfter(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/device" {
			_ = json.NewEncoder(w).Encode(map[string]any{"device_code": "d", "user_code": "U", "verification_uri": "https://i/d", "expires_in": 6000, "interval": 5})
			return
		}
		calls++
		switch {
		case calls <= 5:
			w.WriteHeader(http.StatusTooManyRequests)
		case calls == 6:
			w.Header().Set("Retry-After", "17")
			w.WriteHeader(http.StatusTooManyRequests)
		default:
			_, _ = w.Write([]byte(`{"access_token":"at","refresh_token":"rt"}`))
		}
	}))
	defer srv.Close()
	var sleeps []time.Duration
	hooks := noopHooks()
	hooks.sleep = func(_ context.Context, d time.Duration) error { sleeps = append(sleeps, d); return nil }
	doc := &discovery{TokenEndpoint: srv.URL + "/token", DeviceAuthorizationEndpoint: srv.URL + "/device"}
	if _, err := runDeviceFlowWithHooks(context.Background(), doc, "c", hooks); err != nil {
		t.Fatal(err)
	}
	want := []time.Duration{5 * time.Second, 10 * time.Second, 20 * time.Second, 40 * time.Second, time.Minute, time.Minute, 17 * time.Second}
	for i := range want {
		if sleeps[i] != want[i] {
			t.Fatalf("sleeps = %v, want %v", sleeps, want)
		}
	}
}

func TestDeviceFlowRateLimitedUntilExpiryFailsClearly(t *testing.T) {
	stub := newStubDeviceServer(t, func(int) (int, string) {
		return http.StatusTooManyRequests, `{"error":"temporarily_unavailable"}`
	})
	now := time.Now()
	hooks := deviceFlowHooks{
		sleep: func(_ context.Context, d time.Duration) error { now = now.Add(d); return nil },
		now:   func() time.Time { return now },
	}
	_, err := runDeviceFlowWithHooks(context.Background(), docFor(stub), "opencode-enrollment", hooks)
	if err == nil || !strings.Contains(err.Error(), "rate-limiting") || !strings.Contains(err.Error(), "WDJB-MJHT") {
		t.Fatalf("err = %v, want a clear rate-limit message naming the code", err)
	}
	if stub.tokenCalls > 20 {
		t.Fatalf("polled %d times in a 10 minute code life; the backoff is not slowing it down", stub.tokenCalls)
	}
}
