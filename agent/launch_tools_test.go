package main

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/packaging"
)

// fakeLaunchTool writes an executable that answers --version and otherwise
// records its arguments, the listed environment variables and the contents of
// the listed files (read while the tool runs, since launch removes its temp
// dir), then exits with code.
func fakeLaunchTool(t *testing.T, r *launchRig, name, version string, code int, envVars []string, files []string) string {
	t.Helper()
	path := filepath.Join(filepath.Dir(r.fakeBin), name)
	var b strings.Builder
	b.WriteString("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo '" + version + "'; exit 0; fi\n{\n")
	b.WriteString("  echo \"ARGS:$*\"\n  echo \"CWD:$(pwd)\"\n")
	for _, v := range envVars {
		b.WriteString("  echo \"" + v + "=${" + v + "-<unset>}\"\n")
	}
	for _, f := range files {
		b.WriteString("  echo \"--- " + f + "\"\n  cat \"" + f + "\" 2>/dev/null\n")
	}
	b.WriteString("} > " + r.record + "\nexit " + string(rune('0'+code)) + "\n")
	if err := os.WriteFile(path, []byte(b.String()), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func portFree(t *testing.T, port int) {
	t.Helper()
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", itPortStr(port)))
	if err != nil {
		t.Fatalf("proxy still holds the port after exit: %v", err)
	}
	ln.Close()
}

func TestLaunchGoose(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	// the user's own goose config: must stay byte for byte
	userCfg := filepath.Join(home, "config", "goose")
	if err := os.MkdirAll(userCfg, 0o755); err != nil {
		t.Fatal(err)
	}
	userYAML := filepath.Join(userCfg, "config.yaml")
	if err := os.WriteFile(userYAML, []byte("GOOSE_PROVIDER: mine\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bin := fakeLaunchTool(t, r, "goose", "goose "+packaging.GooseVersion(), 5,
		[]string{"GOOSE_PATH_ROOT", "GOOSE_MODE", "GOOSE_PROVIDER", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOSE_MODEL", "GOOSE_DISABLE_KEYRING"},
		[]string{"$GOOSE_PATH_ROOT/config/config.yaml", "$GOOSE_PATH_ROOT/config/custom_providers/galopin.json"})
	o := r.opts("session", "--resume")
	o.gooseBin = bin
	err := launchGoose(context.Background(), o)
	var ee exitError
	if !errors.As(err, &ee) || ee.code != 5 {
		t.Fatalf("err = %v, want exit code 5", err)
	}
	rec := r.recorded(t)
	for _, want := range []string{
		"ARGS:session --resume", "GOOSE_MODE=approve", "GOOSE_PROVIDER=galopin",
		"OPENAI_API_KEY=<unset>", "ANTHROPIC_API_KEY=<unset>", "GOOSE_DISABLE_KEYRING=1",
		"GOOSE_MODEL: gw-model", `"base_url": "http://127.0.0.1:` + itPortStr(r.port) + `/v1/chat/completions"`,
		"Bearer " + r.creds_.ShimSecret,
	} {
		if !strings.Contains(rec, want) {
			t.Errorf("record lacks %q:\n%s", want, rec)
		}
	}
	if strings.Contains(rec, "GOOSE_PATH_ROOT=<unset>") || strings.Contains(rec, "x-session-id") {
		t.Errorf("bad root or a Cerea session header:\n%s", rec)
	}
	if b, _ := os.ReadFile(userYAML); string(b) != "GOOSE_PROVIDER: mine\n" {
		t.Errorf("the user's goose config changed: %q", b)
	}
	if _, err := os.Stat(filepath.Join(userCfg, "custom_providers")); err == nil {
		t.Error("a provider file was written into the user's goose config")
	}
	for _, line := range strings.Split(rec, "\n") {
		if root, ok := strings.CutPrefix(line, "GOOSE_PATH_ROOT="); ok {
			if _, err := os.Stat(root); err == nil {
				t.Errorf("temp goose root %s was not removed", root)
			}
		}
	}
	if !strings.Contains(r.stderrBuf.String(), "local goose (gw-model), billed to team; not supervised by Cerea") {
		t.Errorf("startup line missing:\n%s", r.stderrBuf.String())
	}
	if strings.Contains(r.stderrBuf.String(), "warning") {
		t.Errorf("unexpected warning:\n%s", r.stderrBuf.String())
	}
	portFree(t, r.port)
}

func TestLaunchGooseDefaultsToSessionAndWarnsOnVersion(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	bin := fakeLaunchTool(t, r, "goose", "goose 0.0.1", 0, nil, nil)
	o := r.opts()
	o.gooseBin, o.model = bin, "other-model"
	if err := launchGoose(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	if rec := r.recorded(t); !strings.Contains(rec, "ARGS:session\n") {
		t.Errorf("no default 'session' argument:\n%s", rec)
	}
	s := r.stderrBuf.String()
	if !strings.Contains(s, "is goose 0.0.1") || !strings.Contains(s, "--model other-model is not in the gateway") {
		t.Errorf("warnings missing:\n%s", s)
	}
}

func TestLaunchGooseNotEnrolled(t *testing.T) {
	err := launchGoose(context.Background(), launchOptions{credsPath: filepath.Join(t.TempDir(), "c.json"), gooseBin: "/bin/true"})
	if err == nil || !strings.Contains(err.Error(), "galopin enroll") {
		t.Fatalf("err = %v", err)
	}
}
