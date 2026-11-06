package main

import (
	"bytes"
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"galopin/packaging"
)

// launchRig enrolls against the fake IdP/gateway into a temp state dir on a
// free shim port and writes a fake opencode that records how it was started.
type launchRig struct {
	creds     string
	state     string
	port      int
	record    string
	fakeBin   string
	creds_    *credentials
	baseEnv   []string
	stderrBuf bytes.Buffer
}

func newLaunchRig(t *testing.T, exitCode int, version string) *launchRig {
	t.Helper()
	root := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(root, "run"))
	if err := os.MkdirAll(filepath.Join(root, "run"), 0o700); err != nil {
		t.Fatal(err)
	}
	r := &launchRig{state: filepath.Join(root, "galopin"), port: itFreePort(t)}
	r.creds = filepath.Join(r.state, "credentials.json")
	srv := fakeEnrollServer(t)
	opts := &enrollOptions{
		discover: true, issuer: srv.URL, gateway: srv.URL, clientID: "opencode-enrollment",
		device: true, group: "team", creds: r.creds, shimPort: r.port, yes: true, maxTerminals: 8,
	}
	if err := enroll(context.Background(), opts); err != nil {
		t.Fatalf("enroll: %v", err)
	}
	var err error
	if r.creds_, err = loadCredentials(r.creds); err != nil {
		t.Fatal(err)
	}
	r.record = filepath.Join(root, "record")
	r.fakeBin = filepath.Join(root, "opencode")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo ` + version + `; exit 0; fi
{
  echo "ARGS:$*"
  echo "CWD:$(pwd)"
  for v in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_DISABLE_PROJECT_CONFIG TMPDIR OPENCODE_SERVER_PASSWORD; do
    eval "echo \"$v=\${$v-<unset>}\""
  done
} > ` + r.record + `
exit ` + string(rune('0'+exitCode)) + `
`
	if err := os.WriteFile(r.fakeBin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	r.baseEnv = append(os.Environ(),
		"ANTHROPIC_API_KEY=sk-ant-leak", "OPENAI_API_KEY=sk-leak", "OPENROUTER_API_KEY=or-leak",
		"OPENCODE_SERVER_PASSWORD=x", "OPENCODE_CONFIG_CONTENT={\"model\":\"evil/x\"}")
	return r
}

func (r *launchRig) opts(args ...string) launchOptions {
	return launchOptions{credsPath: r.creds, opencodeBin: r.fakeBin, args: args, stderr: &r.stderrBuf, env: r.baseEnv}
}

func (r *launchRig) recorded(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(r.record)
	if err != nil {
		t.Fatalf("the fake opencode did not run: %v", err)
	}
	return string(b)
}

func TestLaunchNotEnrolled(t *testing.T) {
	dir := t.TempDir()
	err := launchOpencode(context.Background(), launchOptions{credsPath: filepath.Join(dir, "credentials.json"), opencodeBin: "/bin/true"})
	if err == nil || !strings.Contains(err.Error(), "galopin enroll") {
		t.Fatalf("err = %v, want a 'run galopin enroll first' error", err)
	}
}

func TestLaunchPassesArgsEnvAndExitCode(t *testing.T) {
	r := newLaunchRig(t, 7, packaging.OpencodeVersion())
	err := launchOpencode(context.Background(), r.opts("run", "--model", "x y", "-c"))
	var ee exitError
	if !errors.As(err, &ee) || ee.code != 7 {
		t.Fatalf("err = %v, want exit code 7", err)
	}
	rec := r.recorded(t)
	for _, want := range []string{
		// default policy loads no project config: --pure first, then the user's args untouched
		"ARGS:--pure run --model x y -c",
		"ANTHROPIC_API_KEY=<unset>", "OPENAI_API_KEY=<unset>", "OPENROUTER_API_KEY=<unset>",
		"OPENCODE_SERVER_PASSWORD=<unset>",
		"OPENCODE_CONFIG=" + r.creds_.OpencodeConfig,
		"OPENCODE_DISABLE_PROJECT_CONFIG=1",
	} {
		if !strings.Contains(rec, want) {
			t.Errorf("record lacks %q:\n%s", want, rec)
		}
	}
	if strings.Contains(rec, "evil/x") {
		t.Errorf("an inherited OPENCODE_CONFIG_CONTENT reached opencode:\n%s", rec)
	}
	if !strings.Contains(rec, `"permission"`) || !strings.Contains(rec, `"ask"`) {
		t.Errorf("OPENCODE_CONFIG_CONTENT lacks the ask floor:\n%s", rec)
	}
	for _, line := range strings.Split(rec, "\n") {
		if strings.HasPrefix(line, "TMPDIR=") && (strings.Contains(line, "<unset>") || !strings.Contains(line, "opencode-launch-")) {
			t.Errorf("TMPDIR not galopin's private launch dir: %s", line)
		}
	}
	stderr := r.stderrBuf.String()
	want := "galopin: local opencode, billed to team; not supervised by Cerea (no Plan/Ask/Auto, no review log)"
	if !strings.Contains(stderr, want) {
		t.Errorf("startup line missing; stderr:\n%s", stderr)
	}
	if strings.Contains(stderr, "warning") {
		t.Errorf("unexpected warning at the pinned version:\n%s", stderr)
	}
	// the in-process proxy is gone and the temp dir removed
	ln, lerr := net.Listen("tcp", net.JoinHostPort("127.0.0.1", itPortStr(r.port)))
	if lerr != nil {
		t.Fatalf("proxy still holds the port after exit: %v", lerr)
	}
	ln.Close()
}

func TestLaunchWarnsOnVersionMismatch(t *testing.T) {
	r := newLaunchRig(t, 0, "0.0.1")
	if err := launchOpencode(context.Background(), r.opts()); err != nil {
		t.Fatal(err)
	}
	if s := r.stderrBuf.String(); !strings.Contains(s, "opencode 0.0.1") || !strings.Contains(s, "tested against "+packaging.OpencodeVersion()) {
		t.Errorf("no version warning:\n%s", s)
	}
	if _, err := os.Stat(r.record); err != nil {
		t.Errorf("a version mismatch must not stop the launch: %v", err)
	}
}

func TestEnsureProxyStartsAndStopsThenReuses(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	logf := func(string, ...any) {}
	stop1, reused1, err := ensureProxy(r.creds_, r.creds, r.port, logf)
	if err != nil || reused1 {
		t.Fatalf("first: reused=%v err=%v, want a fresh in-process proxy", reused1, err)
	}
	// a second launcher while the first runs reuses it: never two on the port
	stop2, reused2, err := ensureProxy(r.creds_, r.creds, r.port, logf)
	if err != nil || !reused2 {
		t.Fatalf("second: reused=%v err=%v, want reuse", reused2, err)
	}
	stop2() // reuse's stop must not take the owner's proxy down
	if !shimAnswers(net.JoinHostPort("127.0.0.1", itPortStr(r.port)), r.creds_.ShimSecret) {
		t.Fatal("reuse's stop closed the proxy it did not start")
	}
	stop1()
	ln, lerr := net.Listen("tcp", net.JoinHostPort("127.0.0.1", itPortStr(r.port)))
	if lerr != nil {
		t.Fatalf("port still held after stop: %v", lerr)
	}
	ln.Close()
}

func TestEnsureProxyRefusesAForeignListener(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", itPortStr(r.port)))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	if _, _, err := ensureProxy(r.creds_, r.creds, r.port, func(string, ...any) {}); err == nil || !strings.Contains(err.Error(), "not this machine's galopin proxy") {
		t.Fatalf("err = %v, want a refusal naming the port holder", err)
	}
}

func TestLaunchUnknownTool(t *testing.T) {
	err := runLaunch([]string{"claude"})
	var ee exitError
	if !errors.As(err, &ee) || ee.code != 2 || !strings.Contains(err.Error(), "supported: opencode") {
		t.Fatalf("err = %v", err)
	}
}

func itPortStr(p int) string { return strconv.Itoa(p) }
