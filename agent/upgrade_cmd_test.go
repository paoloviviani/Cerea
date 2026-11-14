package main

import (
	"bytes"
	"context"
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
	if err := upgradeFrom(context.Background(), env, "https://c.example/chat", false, true, "/c/credentials.json"); err != nil {
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
	if err := upgradeFrom(context.Background(), env, "https://c.example", false, false, "x"); err != nil || len(ran) != 0 {
		t.Fatalf("declined must do nothing: %v %q", err, ran)
	}
	env, _ = fakeUpgradeEnv(true, "<html>", &ran)
	if err := upgradeFrom(context.Background(), env, "https://c.example", true, false, "x"); err == nil {
		t.Fatal("a non-script answer must be refused")
	}
}
