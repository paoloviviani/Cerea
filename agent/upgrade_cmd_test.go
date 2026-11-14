package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

func TestUpgradeOrigin(t *testing.T) {
	for _, ok := range []string{"https://cerea.example.org/chat/", "http://127.0.0.1:5173", "http://localhost:3000", "http://[::1]:80"} {
		if _, err := upgradeOrigin(ok); err != nil {
			t.Errorf("%s refused: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "http://cerea.example.org", "ftp://x", "https://", "cerea.example.org"} {
		if _, err := upgradeOrigin(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func fakeUpgradeEnv(answer bool, body string, ran *[]string) (*upgradeEnv, *bytes.Buffer) {
	out := &bytes.Buffer{}
	return &upgradeEnv{
		fetch: func(ctx context.Context, u string) ([]byte, error) {
			*ran = append(*ran, "fetch "+u)
			return []byte(body), nil
		},
		run: func(ctx context.Context, script string, args []string, env []string) error {
			b, _ := os.ReadFile(script)
			*ran = append(*ran, "run "+strings.Join(args, " ")+" "+string(b[:9]))
			return nil
		},
		confirm: func(string) (bool, error) { return answer, nil },
		exe:     func() (string, error) { return "/opt/g/galopin", nil },
		out:     out,
	}, out
}

func TestUpgradeFromRunsInstallerAfterConfirm(t *testing.T) {
	var ran []string
	env, out := fakeUpgradeEnv(true, "#!/bin/sh\necho hi\n", &ran)
	if err := upgradeFrom(context.Background(), env, "https://c.example/chat", false, true, false, "/c/credentials.json"); err != nil {
		t.Fatal(err)
	}
	want := []string{"fetch https://c.example/chat/galopin/install.sh", "run --upgrade --creds /c/credentials.json --stop #!/bin/sh"}
	if strings.Join(ran, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q", ran)
	}
	if !strings.Contains(out.String(), "Enrollment and settings are kept") {
		t.Fatalf("plan not shown: %s", out)
	}
}

func TestUpgradeFromDeclinedAndNotAnInstaller(t *testing.T) {
	var ran []string
	env, _ := fakeUpgradeEnv(false, "#!/bin/sh\n", &ran)
	if err := upgradeFrom(context.Background(), env, "https://c.example", false, false, false, "x"); err != nil || len(ran) != 0 {
		t.Fatalf("declined must do nothing: %v %q", err, ran)
	}
	env, _ = fakeUpgradeEnv(true, "<html>", &ran)
	if err := upgradeFrom(context.Background(), env, "https://c.example", true, false, false, "x"); err == nil {
		t.Fatal("a non-script answer must be refused")
	}
}

func TestUpgradeShowPrintsAndRunsNothing(t *testing.T) {
	var ran []string
	env, out := fakeUpgradeEnv(true, "#!/bin/sh\necho hi\n", &ran)
	if err := upgradeFrom(context.Background(), env, "https://c.example", false, false, true, "x"); err != nil {
		t.Fatal(err)
	}
	if out.String() != "#!/bin/sh\necho hi\n" || len(ran) != 1 {
		t.Fatalf("out=%q ran=%q", out, ran)
	}
}

func TestUpgradeFetchRefusesCrossOriginAndDowngradingRedirects(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "#!/bin/sh\n") }))
	defer other.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/same" {
			fmt.Fprint(w, "#!/bin/sh\n")
			return
		}
		if r.URL.Path == "/hop" {
			http.Redirect(w, r, "/same", http.StatusFound)
			return
		}
		http.Redirect(w, r, other.URL+"/x", http.StatusFound)
	}))
	defer redirect.Close()
	fetch := realUpgradeEnv().fetch
	if _, err := fetch(context.Background(), redirect.URL+"/galopin/install.sh"); err == nil || !strings.Contains(err.Error(), "another origin") {
		t.Fatalf("a cross-origin redirect must be refused: %v", err)
	}
	if body, err := fetch(context.Background(), redirect.URL+"/hop"); err != nil || !strings.HasPrefix(string(body), "#!") {
		t.Fatalf("a same-origin redirect is fine: %v", err)
	}
	// https to http on the same host is another origin too
	base, _ := url.Parse("https://c.example")
	req, _ := http.NewRequest("GET", "http://c.example/x", nil)
	if err := sameOriginRedirects(base)(req, nil); err == nil {
		t.Fatal("https to http must be refused")
	}
	if err := sameOriginRedirects(base)(&http.Request{URL: base}, make([]*http.Request, 5)); err == nil {
		t.Fatal("more than five hops must be refused")
	}
}
