package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	backendopencode "galopin/internal/backend/opencode"
	"galopin/internal/policy"
	"galopin/packaging"
)

const launchUsage = `galopin launch — start your own interactive tool the way galopin sets it up,
without connecting to Cerea.

Usage:
  galopin launch opencode [options] [-- opencode arguments…]
  galopin launch goose    [options] [-- goose arguments…]
  galopin launch vibe     [options] [-- vibe arguments…]

Starts opencode in the current directory with the opencode.json 'galopin
enroll' wrote, through the same local proxy (so the same gateway, billing
group and refreshed credential), the same TMPDIR handling and the same
project-config setting as the opencode 'galopin run' supervises. It does not
dial Cerea: no pairing, no machine link, nothing in the Agents panel.

  --creds PATH       Credential file (default <config-dir>/galopin/
                     credentials.json).
  --state-dir PATH   Where policy.json lives (default: beside --creds).
  --opencode PATH    The opencode binary to run (default: 'opencode' on PATH,
                     then $HOME/.opencode/bin). A different version from the
                     one galopin is tested against is warned about, not
                     refused.
  --port PORT        Proxy port (default: the one enroll recorded).

Everything after the options (use -- before opencode's own flags) is passed to
opencode unchanged. galopin's exit code is opencode's.

The proxy: if 'galopin run' or 'galopin serve' already listens on the port it
is reused; otherwise galopin starts one for the lifetime of this opencode and
stops it when opencode exits.

Not supervised: opencode's own permission prompts reach you in its TUI (every
tool call asks), but nothing answers for galopin, so galopin's protections for
its own state, the Plan/Ask/Auto modes and the review log do not apply. Provider
API keys in your environment (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) are removed
from opencode's environment so nothing is billed outside the gateway.

goose: 'galopin launch goose [--goose PATH] [--model ID] [--creds PATH]
[--state-dir PATH] [--port PORT] [-- goose arguments…]'. Runs 'goose session' (or
your arguments) with a temporary goose config directory (GOOSE_PATH_ROOT) that
holds the same provider galopin's supervised goose uses (the gateway's models
through the local proxy) and the default model (first chat model, or --model).
Your own goose config, extensions and keys are not read or written, and the
temporary directory is removed at exit; your session store is linked, so
'goose session --resume' sees your history. goose runs in approve mode (asks
before each tool call, in the terminal), keyring and telemetry off. Binary:
--goose, then the copy galopin installed, then goose on PATH; a version other
than the tested one only warns. galopin's protected paths, Plan/Ask/Auto, the
Cerea connectors extension and the review log do not apply.

vibe: 'galopin launch vibe [--vibe PATH] [--model ID] [--creds PATH]
[--state-dir PATH] [--port PORT] [-- vibe arguments…]'. Runs Mistral Vibe with a
temporary VIBE_HOME holding galopin's supervised-engine config: the gateway's
models through the local proxy (only those; Vibe's own Mistral models are not
offered), the chosen model active (--model, else the first chat model),
telemetry, update checks and the model catalogue off, every file and shell tool
asking first, auto-approve refused. Your own ~/.vibe (config, trusted folders,
API key, sessions) is not read or written and the temporary home is removed at
exit, so Vibe's sessions are not kept and each project's trust prompt appears
afresh. VIBE_* and provider keys are stripped from the environment. Binary:
--vibe, then vibe on PATH, then the copy galopin installed. galopin's protected
paths, Plan/Ask/Auto and the review log do not apply.
`

// launchOptions is what 'galopin launch opencode' needs; split from the flag
// parsing so tests can drive it with a fake opencode.
type launchOptions struct {
	credsPath   string
	stateDir    string
	opencodeBin string
	gooseBin    string // --goose
	vibeBin     string // --vibe
	claudeBin   string // --claude
	model       string // --model (goose, vibe, claude)
	smallModel  string // --small-model (claude)
	port        int
	args        []string // handed to opencode unchanged
	stderr      io.Writer
	env         []string // base environment (nil: os.Environ())
}

const launchSupported = "opencode, goose, vibe, claude"

func runLaunch(args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "-help" || args[0] == "--help" {
		fmt.Fprint(os.Stderr, launchUsage)
		if len(args) == 0 {
			return exitError{code: 2, err: errors.New("launch: which tool? (supported: " + launchSupported + ")")}
		}
		return nil
	}
	tool, rest := args[0], args[1:]
	var run func(context.Context, launchOptions) error
	switch tool {
	case "opencode":
		run = launchOpencode
	case "goose":
		run = launchGoose
	case "vibe":
		run = launchVibe
	default:
		return exitError{code: 2, err: fmt.Errorf("launch: unknown tool %q (supported: %s)", tool, launchSupported)}
	}
	fs := flagSetWithHelp("launch "+tool, launchUsage)
	opts := launchOptions{stderr: os.Stderr}
	fs.StringVar(&opts.credsPath, "creds", "", "")
	fs.StringVar(&opts.stateDir, "state-dir", "", "")
	fs.IntVar(&opts.port, "port", 0, "")
	switch tool {
	case "opencode":
		fs.StringVar(&opts.opencodeBin, "opencode", "opencode", "")
	case "goose":
		fs.StringVar(&opts.gooseBin, "goose", "", "")
		fs.StringVar(&opts.model, "model", "", "")
	case "vibe":
		fs.StringVar(&opts.vibeBin, "vibe", "", "")
		fs.StringVar(&opts.model, "model", "", "")
	}
	if err := fs.Parse(rest); err != nil {
		return err
	}
	opts.args = fs.Args()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	return run(ctx, opts)
}

// launchSession is what every 'galopin launch' tool shares: the enrolled
// credentials, the policy, and a local proxy that lives as long as the tool.
type launchSession struct {
	creds     *credentials
	credsPath string
	stateDir  string
	pol       policy.Policy
	port      int
	logf      func(string, ...any)
	stopProxy func()
}

func (ls *launchSession) close() { ls.stopProxy() }

// shimAddr is the proxy's address as the launched tool dials it.
func (ls *launchSession) shimAddr() string { return fmt.Sprintf("127.0.0.1:%d", ls.port) }

// startLaunch loads what 'enroll' wrote and makes sure the proxy answers.
func startLaunch(opts launchOptions) (*launchSession, error) {
	logw := opts.stderr
	if logw == nil {
		logw = io.Discard
	}
	ls := &launchSession{logf: func(format string, args ...any) { fmt.Fprintf(logw, "galopin: "+format+"\n", args...) }}
	credsPath := opts.credsPath
	if credsPath == "" {
		if err := migrateLegacyState(); err != nil {
			return nil, err
		}
		p, err := defaultCredsPath()
		if err != nil {
			return nil, err
		}
		credsPath = p
	}
	creds, err := loadCredentials(credsPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("this machine is not enrolled: run 'galopin enroll' first")
		}
		return nil, err
	}
	if creds.Gateway == "" {
		return nil, errors.New("creds file has no gateway: re-run 'galopin enroll'")
	}
	if creds.ShimSecret == "" {
		return nil, errors.New("creds file has no shim secret: re-run 'galopin enroll'")
	}
	stateDir := resolveStateDir(opts.stateDir, credsPath)
	pol, err := policy.Load(filepath.Join(stateDir, policyFileName))
	if err != nil {
		return nil, err
	}
	ls.creds, ls.credsPath, ls.stateDir, ls.pol = creds, credsPath, stateDir, pol
	return ls, nil
}

// startProxy reuses a running galopin proxy or starts one for this session.
func (ls *launchSession) startProxy(opts launchOptions) error {
	port := opts.port
	if port == 0 {
		port = ls.creds.ShimPort
	}
	if port == 0 {
		port = defaultShimPort
	}
	stop, reused, err := ensureProxy(ls.creds, ls.credsPath, port, ls.logf)
	if err != nil {
		return err
	}
	ls.port, ls.stopProxy = port, stop
	if reused {
		ls.logf("using the proxy already listening on 127.0.0.1:%d", port)
	}
	return nil
}

// launchOpencode runs the interactive opencode to completion and returns an
// exitError carrying its exit code when that is not zero.
func launchOpencode(ctx context.Context, opts launchOptions) error {
	ls, err := startLaunch(opts)
	if err != nil {
		return err
	}
	logf, creds, stateDir, pol := ls.logf, ls.creds, ls.stateDir, ls.pol
	configPath, warning := resolveOpencodeConfig("", creds)
	if configPath == "" {
		return errors.New("no opencode.json from enroll to use: " + warning)
	}

	bin, err := backendopencode.ResolveBin(opts.opencodeBin)
	if err != nil {
		return err
	}
	if got := opencodeVersion(bin); got == "" {
		logf("warning: could not read %s's version (galopin is tested against opencode %s)", bin, packaging.OpencodeVersion())
	} else if want := packaging.OpencodeVersion(); got != want {
		logf("warning: %s is opencode %s; galopin is tested against %s", bin, got, want)
	}

	if err := ls.startProxy(opts); err != nil {
		return err
	}
	defer ls.close()

	// A private TMPDIR, never the supervised one: galopin run empties that on
	// every start, which would pull opencode's libraries from under us.
	tmp := filepath.Join(filepath.Dir(opencodeTmpDir(stateDir)), fmt.Sprintf("opencode-launch-%d", os.Getpid()))
	defer os.RemoveAll(tmp)
	live := policy.NewLive(pol.Permission)
	cfg := backendopencode.Config{
		Bin:                 bin,
		ConfigPath:          configPath,
		Env:                 opts.env,
		TmpDir:              tmp,
		ProjectConfig:       pol.ProjectConfigAllowed(),
		BackgroundSubagents: pol.BackgroundSubagentsAllowed(),
		// Non-nil so the "everything asks" permission floor is part of the
		// environment; opencode then prompts in its own TUI.
		Permissions: live.Layers,
	}
	env, err := backendopencode.LaunchEnv(cfg)
	if err != nil {
		return err
	}

	logf("local opencode, billed to %s; not supervised by Cerea (no Plan/Ask/Auto, no review log)", billingLabel(creds))
	logf("opencode asks before each tool call, in this terminal; galopin's own-state protections need galopin to answer and do not apply")
	return runLaunched(ctx, "opencode", bin, backendopencode.LaunchArgs(cfg, opts.args), env)
}

// runLaunched runs the tool on the terminal until it exits, forwarding
// SIGINT/SIGTERM/SIGHUP, and returns its exit code as an exitError.
func runLaunched(ctx context.Context, name, bin string, args, env []string) error {
	cmd := exec.Command(bin, args...)
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("starting %s: %w", name, err)
	}
	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(sigs)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	for {
		select {
		case sig := <-sigs:
			_ = cmd.Process.Signal(sig)
		case <-ctx.Done():
			_ = cmd.Process.Signal(syscall.SIGTERM)
			ctx = context.Background()
		case err := <-done:
			return exitFromWait(name, err)
		}
	}
}

// exitFromWait maps cmd.Wait's result to galopin's own exit: nil for success,
// the child's code otherwise (128+signal when it died of one).
func exitFromWait(name string, err error) error {
	if err == nil {
		return nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code := ee.ExitCode()
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			code = 128 + int(ws.Signal())
		}
		return exitError{code: code, err: fmt.Errorf("%s exited with status %d", name, code)}
	}
	return err
}

// billingLabel names where the launched opencode's spend goes.
func billingLabel(creds *credentials) string {
	switch {
	case creds.BillToDefault:
		return "your default group"
	case creds.Group != "":
		return creds.Group
	default:
		return "no group (none recorded: 'galopin auth group NAME')"
	}
}

// opencodeVersion is what `bin --version` prints, or "" when it cannot be read.
func opencodeVersion(bin string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "--version").Output()
	if err != nil {
		return ""
	}
	// 1.x prints "1.19.3", 2.x "opencode v2.3.0": the bare release number.
	v := strings.TrimSpace(string(out))
	v = strings.TrimPrefix(v, "opencode ")
	return strings.TrimPrefix(v, "v")
}

// ensureProxy makes sure a galopin shim answers on 127.0.0.1:port. A free
// port gets an in-process shim, stopped by the returned func; a port a
// galopin shim already holds (run or serve; recognised by its health endpoint
// accepting this install's secret) is reused and the func does nothing;
// anything else on the port is an error. Never two shims on one port.
func ensureProxy(creds *credentials, credsPath string, port int, logf func(string, ...any)) (stop func(), reused bool, err error) {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	ln, listenErr := net.Listen("tcp", addr)
	if listenErr != nil {
		if shimAnswers(addr, creds.ShimSecret) {
			return func() {}, true, nil
		}
		return nil, false, fmt.Errorf("port %d is in use and is not this machine's galopin proxy (%v); stop what holds it, or pass --port", port, listenErr)
	}
	sh := newShim(creds, credsPath, statusPathFor(credsPath), port)
	_ = sh.refresh()
	sh.mu.Lock()
	state, msg := sh.status.State, sh.status.Message
	sh.mu.Unlock()
	if state == stateExpired {
		_ = ln.Close()
		return nil, false, fmt.Errorf("the enrolled credential has expired (%s): run 'galopin auth login'", msg)
	}
	go sh.refreshLoop()
	mux := http.NewServeMux()
	mux.HandleFunc("/galopin/health", sh.requireLocalAuth(sh.healthHandler))
	mux.HandleFunc("/", sh.requireLocalAuth(sh.handler))
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			logf("proxy error: %v", err)
		}
	}()
	return func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		_ = srv.Close()
	}, false, nil
}

// shimAnswers reports whether a galopin shim holds addr: its health endpoint
// answers 200 with a status body to this install's bearer secret.
func shimAnswers(addr, secret string) bool {
	req, err := http.NewRequest(http.MethodGet, "http://"+addr+"/galopin/health", nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var st healthStatus
	return json.NewDecoder(resp.Body).Decode(&st) == nil && st.State != ""
}
