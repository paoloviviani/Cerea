package main

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

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
		[]string{"GOOSE_PATH_ROOT", "GOOSE_MODE", "GOOSE_PROVIDER", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOSE_MODEL", "GOOSE_DISABLE_KEYRING", "TMPDIR"},
		[]string{"$GOOSE_PATH_ROOT/config/config.yaml", "$GOOSE_PATH_ROOT/config/custom_providers/galopin.json"})
	o := r.opts("session", "--resume")
	o.gooseBin = bin
	o.model = "gw-model"
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
	} {
		if !strings.Contains(rec, want) {
			t.Errorf("record lacks %q:\n%s", want, rec)
		}
	}
	assertToolSecret(t, rec, r)
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
	o.gooseBin = bin
	if err := launchGoose(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	if rec := r.recorded(t); !strings.Contains(rec, "ARGS:session\n") {
		t.Errorf("no default 'session' argument:\n%s", rec)
	}
	if s := r.stderrBuf.String(); !strings.Contains(s, "is goose 0.0.1") {
		t.Errorf("version warning missing:\n%s", s)
	}
	// a leading flag means `session <flag>`
	o = r.opts("--resume", "-n", "x")
	o.gooseBin = bin
	if err := launchGoose(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	if rec := r.recorded(t); !strings.Contains(rec, "ARGS:session --resume -n x\n") {
		t.Errorf("a leading flag did not get 'session' prepended:\n%s", rec)
	}
}

func TestLaunchGooseNotEnrolled(t *testing.T) {
	err := launchGoose(context.Background(), launchOptions{credsPath: filepath.Join(t.TempDir(), "c.json"), gooseBin: "/bin/true"})
	if err == nil || !strings.Contains(err.Error(), "galopin enroll") {
		t.Fatalf("err = %v", err)
	}
}

func TestLaunchVibe(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	home := t.TempDir()
	t.Setenv("HOME", home)
	userVibe := filepath.Join(home, ".vibe")
	if err := os.MkdirAll(userVibe, 0o755); err != nil {
		t.Fatal(err)
	}
	userTOML := filepath.Join(userVibe, "config.toml")
	if err := os.WriteFile(userTOML, []byte("active_model = \"mine\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bin := fakeLaunchTool(t, r, "vibe", "vibe "+packaging.VibeVersion(), 3,
		[]string{"VIBE_HOME", "MISTRAL_API_KEY", "OPENAI_API_KEY", "VIBE_ACTIVE_MODEL", "TMPDIR"},
		[]string{"$VIBE_HOME/config.toml", "$VIBE_HOME/trusted_folders.toml"})
	r.baseEnv = append(r.baseEnv, "MISTRAL_API_KEY=leak", "VIBE_ACTIVE_MODEL=evil")
	o := r.opts("--agent", "ask")
	o.vibeBin = bin
	err := launchVibe(context.Background(), o)
	var ee exitError
	if !errors.As(err, &ee) || ee.code != 3 {
		t.Fatalf("err = %v, want exit code 3", err)
	}
	rec := r.recorded(t)
	for _, want := range []string{
		"ARGS:--agent ask", "MISTRAL_API_KEY=<unset>", "OPENAI_API_KEY=<unset>", "VIBE_ACTIVE_MODEL=<unset>",
		`active_model = "gw-model"`, `api_base = "http://127.0.0.1:` + itPortStr(r.port) + `/v1"`,
		"enable_auto_approve = false", "trusted = []",
	} {
		if !strings.Contains(rec, want) {
			t.Errorf("record lacks %q:\n%s", want, rec)
		}
	}
	assertToolSecret(t, rec, r)
	if strings.Contains(rec, "VIBE_HOME=<unset>") || strings.Contains(rec, "VIBE_HOME="+userVibe) {
		t.Errorf("VIBE_HOME not a temp dir:\n%s", rec)
	}
	if b, _ := os.ReadFile(userTOML); string(b) != "active_model = \"mine\"\n" {
		t.Errorf("the user's Vibe config changed: %q", b)
	}
	if ents, _ := os.ReadDir(userVibe); len(ents) != 1 {
		t.Errorf("files were added to ~/.vibe: %v", ents)
	}
	for _, line := range strings.Split(rec, "\n") {
		if h, ok := strings.CutPrefix(line, "VIBE_HOME="); ok {
			if _, err := os.Stat(h); err == nil {
				t.Errorf("temp Vibe home %s was not removed", h)
			}
		}
	}
	if !strings.Contains(r.stderrBuf.String(), "local Mistral Vibe (gw-model), billed to team; not supervised by Cerea") {
		t.Errorf("startup line missing:\n%s", r.stderrBuf.String())
	}
	portFree(t, r.port)
}

func TestLaunchVibeNamedModelSkipsDiscoveryAndWarnsOnVersion(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	bin := fakeLaunchTool(t, r, "vibe", "vibe 0.0.1", 0, nil, []string{"$VIBE_HOME/config.toml"})
	// discovery would fail: no token endpoint answers, so a named model must not need it
	r.creds_.Gateway = "http://127.0.0.1:1/v1"
	if err := saveCredentials(r.creds, r.creds_); err != nil {
		t.Fatal(err)
	}
	o := r.opts()
	o.vibeBin, o.model = bin, "anything-the-gateway-knows"
	if err := launchVibe(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	if rec := r.recorded(t); !strings.Contains(rec, `active_model = "anything-the-gateway-knows"`) {
		t.Errorf("named model not active:\n%s", rec)
	}
	if s := r.stderrBuf.String(); !strings.Contains(s, "is Mistral Vibe 0.0.1") {
		t.Errorf("no version warning:\n%s", s)
	}
}

// assertToolSecret: the tool was given a per-launch secret, never the install's.
func assertToolSecret(t *testing.T, rec string, r *launchRig) {
	t.Helper()
	if strings.Contains(rec, r.creds_.ShimSecret) {
		t.Errorf("the tool was given the long-lived proxy secret:\n%s", rec)
	}
	if !strings.Contains(rec, "gl-") {
		t.Errorf("no per-launch secret in the tool's config:\n%s", rec)
	}
}
func TestLaunchClaude(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	home := t.TempDir()
	t.Setenv("HOME", home)
	userSettings := filepath.Join(home, ".claude", "settings.json")
	userJSON := filepath.Join(home, ".claude.json")
	if err := os.MkdirAll(filepath.Dir(userSettings), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{userSettings, userJSON} {
		if err := os.WriteFile(f, []byte("{\"mine\":true}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	bin := fakeLaunchTool(t, r, "claude", "2.1.317 (Claude Code)", 4,
		[]string{"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
			"ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_CUSTOM_HEADERS", "OPENAI_API_KEY", "NO_PROXY", "TMPDIR"},
		[]string{"$2"})
	r.baseEnv = append(r.baseEnv, "CLAUDE_CODE_USE_BEDROCK=1", "ANTHROPIC_BASE_URL=https://api.anthropic.com", "NO_PROXY=corp.example")
	o := r.opts("-p", "hello world")
	o.claudeBin, o.model, o.smallModel = bin, "gw-model", "gw-small"
	err := launchClaude(context.Background(), o)
	var ee exitError
	if !errors.As(err, &ee) || ee.code != 4 {
		t.Fatalf("err = %v, want exit code 4", err)
	}
	rec := r.recorded(t)
	for _, want := range []string{
		"ARGS:--settings ", "--model gw-model -p hello world",
		"ANTHROPIC_BASE_URL=http://127.0.0.1:" + itPortStr(r.port) + "\n",
		"ANTHROPIC_AUTH_TOKEN=gl-", "ANTHROPIC_API_KEY=\n", "ANTHROPIC_CUSTOM_HEADERS=\n",
		"CLAUDE_CODE_USE_BEDROCK=0", "CLAUDE_CODE_USE_VERTEX=0", "CLAUDE_CODE_USE_FOUNDRY=0", "OPENAI_API_KEY=<unset>",
		`"apiKeyHelper":""`,
		"ANTHROPIC_MODEL=gw-model", "ANTHROPIC_DEFAULT_HAIKU_MODEL=gw-small", "ANTHROPIC_SMALL_FAST_MODEL=gw-small",
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "NO_PROXY=corp.example,127.0.0.1,localhost",
		`"ANTHROPIC_BASE_URL":"http://127.0.0.1:` + itPortStr(r.port) + `"`,
	} {
		if !strings.Contains(rec, want) {
			t.Errorf("record lacks %q:\n%s", want, rec)
		}
	}
	assertToolSecret(t, rec, r)
	if strings.Contains(rec, "api.anthropic.com") || strings.Contains(rec, "sk-ant-leak") {
		t.Errorf("an inherited Anthropic setting reached claude:\n%s", rec)
	}
	for _, f := range []string{userSettings, userJSON} {
		if b, _ := os.ReadFile(f); string(b) != "{\"mine\":true}\n" {
			t.Errorf("%s changed: %q", f, b)
		}
	}
	if ents, _ := os.ReadDir(home); len(ents) != 2 {
		t.Errorf("unexpected files in HOME: %v", ents)
	}
	s := r.stderrBuf.String()
	if !strings.Contains(s, "Claude Code 2.1.317 (Claude Code) (galopin pins no Claude Code version") ||
		!strings.Contains(s, "local Claude Code (gw-model, small model gw-small), billed to team; not supervised by Cerea") {
		t.Errorf("stderr lines missing:\n%s", s)
	}
	portFree(t, r.port)
}

func TestLaunchClaudeDefaultModelFromGateway(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	bin := fakeLaunchTool(t, r, "claude", "2.1.317 (Claude Code)", 0, []string{"ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"}, nil)
	o := r.opts()
	o.claudeBin = bin
	if err := launchClaude(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	rec := r.recorded(t)
	if !strings.Contains(rec, "ANTHROPIC_MODEL=gw-model") || !strings.Contains(rec, "ANTHROPIC_DEFAULT_HAIKU_MODEL=gw-model") {
		t.Errorf("defaults not the gateway's first model:\n%s", rec)
	}
}

func TestLaunchClaudeNotEnrolledAndMissingBinary(t *testing.T) {
	err := launchClaude(context.Background(), launchOptions{credsPath: filepath.Join(t.TempDir(), "c.json"), claudeBin: "/bin/true"})
	if err == nil || !strings.Contains(err.Error(), "galopin enroll") {
		t.Fatalf("err = %v", err)
	}
	r := newLaunchRig(t, 0, "x")
	o := r.opts()
	o.claudeBin = filepath.Join(t.TempDir(), "nope")
	if err := launchClaude(context.Background(), o); err == nil || !strings.Contains(err.Error(), "not an executable") {
		t.Fatalf("err = %v", err)
	}
}

func TestLaunchToolsGetAPrivateTmpdir(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	for _, tc := range []struct {
		name string
		run  func(launchOptions) error
		opt  func(*launchOptions, string)
	}{
		{"goose", func(o launchOptions) error { return launchGoose(context.Background(), o) }, func(o *launchOptions, b string) { o.gooseBin = b }},
		{"vibe", func(o launchOptions) error { return launchVibe(context.Background(), o) }, func(o *launchOptions, b string) { o.vibeBin = b }},
		{"claude", func(o launchOptions) error { return launchClaude(context.Background(), o) }, func(o *launchOptions, b string) { o.claudeBin = b }},
	} {
		bin := fakeLaunchTool(t, r, tc.name, "1", 0, []string{"TMPDIR"}, nil)
		o := r.opts()
		o.model = "gw-model"
		tc.opt(&o, bin)
		if err := tc.run(o); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		rec := r.recorded(t)
		want := tc.name + "-launch-" + strconv.Itoa(os.Getpid()) + "/tmp"
		if !strings.Contains(rec, "TMPDIR=") || !strings.Contains(rec, want) {
			t.Errorf("%s: TMPDIR is not the launch dir's tmp/ (%s):\n%s", tc.name, want, rec)
		}
	}
}

func TestSweepStaleLaunchDirs(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	parent := filepath.Dir(opencodeTmpDir(r.state))
	if err := os.MkdirAll(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	dead := exec.Command("true")
	if err := dead.Run(); err != nil {
		t.Fatal(err)
	}
	deadPid := dead.Process.Pid
	mk := func(name string) string {
		p := filepath.Join(parent, name)
		if err := os.MkdirAll(filepath.Join(p, "tmp"), 0o700); err != nil {
			t.Fatal(err)
		}
		return p
	}
	stale := mk("goose-launch-" + strconv.Itoa(deadPid))
	live := mk("claude-launch-" + strconv.Itoa(os.Getpid()))
	other := mk("something-else-" + strconv.Itoa(deadPid))
	sweepStaleLaunchDirs(r.state)
	if _, err := os.Stat(stale); err == nil {
		t.Error("the dead launch's directory was not swept")
	}
	for _, p := range []string{live, other} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s was removed: %v", p, err)
		}
	}
}

func TestSignalForwarderDoesNotDoubleDeliver(t *testing.T) {
	now := time.Now()
	tty := &signalForwarder{tty: true, last: map[os.Signal]time.Time{}}
	if tty.should(syscall.SIGINT, now) || tty.should(syscall.SIGQUIT, now) {
		t.Error("on a terminal Ctrl-C and Ctrl-\\ reach the tool directly: must not be forwarded")
	}
	f := &signalForwarder{last: map[os.Signal]time.Time{}}
	if !f.should(syscall.SIGINT, now) {
		t.Error("a SIGINT with no terminal must be forwarded")
	}
	if !f.should(syscall.SIGTERM, now) || f.should(syscall.SIGTERM, now.Add(10*time.Millisecond)) || f.should(syscall.SIGHUP, now.Add(20*time.Millisecond)) {
		t.Error("the same termination arriving twice must be forwarded once")
	}
	if !f.should(syscall.SIGTERM, now.Add(2*time.Second)) {
		t.Error("a later SIGTERM must be forwarded again")
	}
}

func TestLaunchForwardsASignalOnce(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	count := filepath.Join(t.TempDir(), "count")
	bin := filepath.Join(filepath.Dir(r.fakeBin), "goose")
	script := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 1; exit 0; fi\ntrap 'echo T >> " + count + "' TERM\ntrap 'exit 0' INT\n: > " + count + ".ready\nwhile :; do sleep 0.1; done\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	o := r.opts()
	o.gooseBin, o.model = bin, "gw-model"
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
	defer stop()
	go func() {
		for i := 0; i < 100; i++ {
			if _, err := os.Stat(count + ".ready"); err == nil {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		_ = syscall.Kill(os.Getpid(), syscall.SIGTERM)
		time.Sleep(700 * time.Millisecond)
		_ = syscall.Kill(os.Getpid(), syscall.SIGINT) // ends the script (the test has no tty on stdin)
	}()
	_ = launchGoose(ctx, o)
	b, _ := os.ReadFile(count)
	if n := strings.Count(string(b), "T"); n != 1 {
		t.Errorf("the tool got SIGTERM %d times, want 1", n)
	}
}

func TestLaunchConnectorsOnlyIsCheckedBeforeTheBinary(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	r.creds_.Mode = modeConnectors
	if err := saveCredentials(r.creds, r.creds_); err != nil {
		t.Fatal(err)
	}
	for name, run := range map[string]func(launchOptions) error{
		"goose": func(o launchOptions) error {
			o.gooseBin = "/no/such/goose"
			return launchGoose(context.Background(), o)
		},
		"vibe": func(o launchOptions) error { o.vibeBin = "/no/such/vibe"; return launchVibe(context.Background(), o) },
		"claude": func(o launchOptions) error {
			o.claudeBin = "/no/such/claude"
			return launchClaude(context.Background(), o)
		},
	} {
		if err := run(r.opts()); err == nil || !strings.Contains(err.Error(), "connectors-only") {
			t.Errorf("%s: err = %v, want the connectors-only refusal", name, err)
		}
	}
}

func TestLaunchSurfacesATokenFailureWithAFix(t *testing.T) {
	r := newLaunchRig(t, 0, "x")
	r.creds_.AccessToken, r.creds_.ObtainedAt = "", 0
	r.creds_.TokenEndpoint = "http://127.0.0.1:1/token"
	if err := saveCredentials(r.creds, r.creds_); err != nil {
		t.Fatal(err)
	}
	o := r.opts()
	o.claudeBin = fakeLaunchTool(t, r, "claude", "1", 0, nil, nil)
	if err := launchClaude(context.Background(), o); err == nil || !strings.Contains(err.Error(), "galopin auth login") {
		t.Fatalf("err = %v, want a pointer to 'galopin auth login'", err)
	}
}
