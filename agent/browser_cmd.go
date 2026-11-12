package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"galopin/internal/browserrt"
	"galopin/internal/mcpconn"
)

// `galopin browser`: the browser runtime for Cerea's browse tool (ADR 0116, PROTOCOL.md §10.7).
// The runtime is a Node program (browser-runtime/ in the Cerea repository, embedded here) that
// drives a Chromium of its own. galopin installs it into its own directory, and offers it to the
// chat as the well-known local connector "cerea-browser" through mcp.json, the same way any
// local connector is offered. Nothing is installed system-wide.

const browserConnectorName = "cerea-browser"

const browserUsage = `galopin browser — the browser Cerea's browse tool uses on this machine.

Usage:
  galopin browser setup   [--state-dir PATH] [--creds PATH]
  galopin browser enable  [--headed | --headless] [--no-sandbox] [--state-dir PATH] [--creds PATH] [--mcp-config PATH]
  galopin browser disable [--remove-profile] [--state-dir PATH] [--creds PATH] [--mcp-config PATH]
  galopin browser status  [--state-dir PATH] [--creds PATH] [--mcp-config PATH]

  setup    Check that Node (20 or newer) is installed, write the runtime into galopin's
           own directory, install its npm dependencies and Playwright's Chromium there,
           and try the browser once. Installs nothing system-wide.
  enable   Offer the runtime to Cerea as the local connector "cerea-browser" (it is
           added to mcp.json, with a profile under galopin's directory that keeps your
           logins). The window is shown when this machine has a display, unless you say
           --headless. Cerea gives this machine a key for approvals the first time its
           browser is used; run 'galopin run' (or keep it running) for that.
  disable  Remove the connector from mcp.json. The profile is kept unless
           --remove-profile is given.
  status   Say whether the runtime is installed, offered to Cerea and answering.

Files live in <state dir>/browser (the state directory is <config-dir>/galopin by default).
`

// browserEnv is everything `galopin browser` reaches outside itself, so the tests need no
// network, no Node and no browser.
type browserEnv struct {
	stateDir string
	mcpPath  string
	goos     string
	getenv   func(string) string
	lookPath func(string) (string, error)
	run      func(ctx context.Context, dir string, env []string, name string, args ...string) ([]byte, error)
	check    func(ctx context.Context, cfg mcpconn.Config, name string) (*mcpconn.CheckResult, error)
	out      io.Writer
}

func realBrowserEnv() *browserEnv {
	return &browserEnv{
		goos:     runtime.GOOS,
		getenv:   os.Getenv,
		lookPath: exec.LookPath,
		run: func(ctx context.Context, dir string, env []string, name string, args ...string) ([]byte, error) {
			cmd := exec.CommandContext(ctx, name, args...)
			cmd.Dir = dir
			cmd.Env = append(os.Environ(), env...)
			var buf bytes.Buffer
			cmd.Stdout, cmd.Stderr = &buf, &buf
			err := cmd.Run()
			return buf.Bytes(), err
		},
		check: mcpconn.Check,
		out:   os.Stdout,
	}
}

// browserPaths are galopin's own browser files.
type browserPaths struct{ dir, runtime, bundle, profile, browsers, key, info string }

func pathsFor(stateDir string) browserPaths {
	dir := filepath.Join(stateDir, "browser")
	return browserPaths{
		dir: dir, runtime: filepath.Join(dir, "runtime"), bundle: filepath.Join(dir, "runtime", "cerea-browser.mjs"),
		profile: filepath.Join(dir, "profile"), browsers: filepath.Join(dir, "ms-playwright"),
		key: filepath.Join(dir, "key"), info: filepath.Join(dir, "browser.json"),
	}
}

// browserInfo is what setup learned, kept in browser.json.
type browserInfo struct {
	Node       string `json:"node"`
	NodeVer    string `json:"nodeVersion"`
	Playwright string `json:"playwright"`
	Chromium   string `json:"chromium"`
	// Sandbox says whether Chromium's own sandbox works on this machine; when it does not
	// (a restricted user namespace, a container), enable starts the browser without it.
	Sandbox bool `json:"sandbox"`
}

func runBrowser(args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Fprint(os.Stderr, browserUsage)
		if len(args) == 0 {
			return exitError{code: 2, err: fmt.Errorf("a subcommand is required")}
		}
		return nil
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return runBrowserWith(ctx, realBrowserEnv(), args)
}

type browserFlags struct {
	connectorsOptions
	headed, headless, noSandbox, removeProfile bool
}

func runBrowserWith(ctx context.Context, env *browserEnv, args []string) error {
	sub, rest := args[0], args[1:]
	fs := flagSetWithHelp("browser "+sub, browserUsage)
	var f browserFlags
	fs.StringVar(&f.creds, "creds", "", "")
	fs.StringVar(&f.stateDir, "state-dir", "", "")
	fs.StringVar(&f.mcpConfig, "mcp-config", "", "")
	fs.BoolVar(&f.headed, "headed", false, "")
	fs.BoolVar(&f.headless, "headless", false, "")
	fs.BoolVar(&f.noSandbox, "no-sandbox", false, "")
	fs.BoolVar(&f.removeProfile, "remove-profile", false, "")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	if f.headed && f.headless {
		return errors.New("--headed and --headless contradict each other")
	}
	if env.stateDir == "" {
		dir, err := connectorsStateDir(&f.connectorsOptions)
		if err != nil {
			return err
		}
		env.stateDir = dir
	}
	if env.mcpPath == "" {
		p, _, err := resolveMcpConfig(f.mcpConfig, env.getenv, env.stateDir)
		if err != nil {
			return err
		}
		env.mcpPath = p
	}
	switch sub {
	case "setup":
		return browserSetup(ctx, env)
	case "enable":
		return browserEnable(env, f)
	case "disable":
		return browserDisable(env, f)
	case "status":
		return browserStatus(ctx, env)
	}
	return fmt.Errorf("unknown browser subcommand %q\n\n%s", sub, browserUsage)
}

func (e *browserEnv) say(format string, a ...any) { fmt.Fprintf(e.out, format+"\n", a...) }

var nodeVersionRE = regexp.MustCompile(`^v?(\d+)\.(\d+)`)

func nodeMajor(v string) int {
	m := nodeVersionRE.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

// playwrightVersion is the version package.json pins.
func playwrightVersion() string {
	var p struct {
		Dependencies map[string]string `json:"dependencies"`
	}
	_ = json.Unmarshal(browserrt.PackageJSON, &p)
	return p.Dependencies["playwright-core"]
}

func browserSetup(ctx context.Context, env *browserEnv) error {
	p := pathsFor(env.stateDir)
	node, err := env.lookPath("node")
	if err != nil {
		return errors.New("Node.js is not installed (or not on PATH). The browser runtime needs Node 20 or newer: install it from https://nodejs.org or with your package manager, then run this again. galopin installs nothing system-wide")
	}
	out, err := env.run(ctx, "", nil, node, "--version")
	if err != nil {
		return fmt.Errorf("could not run %s --version: %w", node, err)
	}
	version := strings.TrimSpace(string(out))
	if nodeMajor(version) < 20 {
		return fmt.Errorf("Node %s is too old: the browser runtime needs Node 20 or newer", version)
	}
	npm, err := env.lookPath("npm")
	if err != nil {
		return errors.New("npm is not installed (it normally comes with Node.js); the runtime's dependencies are installed with it")
	}
	env.say("Node %s at %s", version, node)

	if err := os.MkdirAll(p.runtime, 0o700); err != nil {
		return err
	}
	if err := writeFileAtomic(p.bundle, browserrt.Bundle, 0o600); err != nil {
		return err
	}
	if err := writeFileAtomic(filepath.Join(p.runtime, "package.json"), browserrt.PackageJSON, 0o600); err != nil {
		return err
	}
	env.say("Wrote the runtime to %s", p.runtime)

	pinned := playwrightVersion()
	installed := installedPlaywright(p)
	if installed == pinned && pinned != "" {
		env.say("playwright-core %s is already installed", pinned)
	} else {
		env.say("Installing playwright-core %s (npm, into %s) ...", pinned, p.runtime)
		if out, err := env.run(ctx, p.runtime, nil, npm, "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"); err != nil {
			return fmt.Errorf("npm install failed: %w\n%s", err, tail(out))
		}
	}
	browsersEnv := []string{"PLAYWRIGHT_BROWSERS_PATH=" + p.browsers}
	env.say("Installing Chromium into %s ...", p.browsers)
	cli := filepath.Join("node_modules", "playwright-core", "cli.js")
	if out, err := env.run(ctx, p.runtime, browsersEnv, node, cli, "install", "chromium"); err != nil {
		return fmt.Errorf("installing Chromium failed: %w\n%s", err, tail(out))
	}
	out, err = env.run(ctx, p.runtime, browsersEnv, node, p.bundle, "--self-test")
	if err != nil {
		return fmt.Errorf("the browser did not start: %w\n%s", err, tail(out))
	}
	var st struct {
		OK      bool   `json:"ok"`
		Sandbox bool   `json:"sandbox"`
		Version string `json:"version"`
		Error   string `json:"error"`
	}
	if err := json.Unmarshal(lastLine(out), &st); err != nil || !st.OK {
		return fmt.Errorf("the browser did not start: %s", firstNonEmpty(st.Error, string(tail(out))))
	}
	info := browserInfo{Node: node, NodeVer: version, Playwright: pinned, Chromium: st.Version, Sandbox: st.Sandbox}
	body, _ := json.MarshalIndent(info, "", "\t")
	if err := writeFileAtomic(p.info, append(body, '\n'), 0o600); err != nil {
		return err
	}
	env.say("Chromium %s starts.", st.Version)
	if !st.Sandbox {
		env.say("Note: Chromium's sandbox does not work on this machine (a restricted user namespace or a container), so the browser will run without it. Pages it opens are then not isolated from your user account: use it for sites you trust, or fix the restriction and run setup again.")
	}
	env.say("Done. Next: galopin browser enable")
	return nil
}

func installedPlaywright(p browserPaths) string {
	b, err := os.ReadFile(filepath.Join(p.runtime, "node_modules", "playwright-core", "package.json"))
	if err != nil {
		return ""
	}
	var v struct {
		Version string `json:"version"`
	}
	_ = json.Unmarshal(b, &v)
	return v.Version
}

func tail(b []byte) []byte {
	if len(b) > 1500 {
		b = b[len(b)-1500:]
	}
	return bytes.TrimSpace(b)
}

func lastLine(b []byte) []byte {
	lines := bytes.Split(bytes.TrimSpace(b), []byte("\n"))
	return lines[len(lines)-1]
}

func firstNonEmpty(s ...string) string {
	for _, x := range s {
		if x != "" {
			return x
		}
	}
	return ""
}

func readBrowserInfo(p browserPaths) (*browserInfo, error) {
	b, err := os.ReadFile(p.info)
	if err != nil {
		return nil, errors.New("the browser is not set up yet: run 'galopin browser setup' first")
	}
	var info browserInfo
	if err := json.Unmarshal(b, &info); err != nil {
		return nil, fmt.Errorf("%s is unreadable: run 'galopin browser setup' again", p.info)
	}
	return &info, nil
}

// hasDisplay reports whether a window can be shown: always on macOS and Windows, on Linux when
// an X11 or Wayland display is set.
func (e *browserEnv) hasDisplay() bool {
	if e.goos == "linux" {
		return e.getenv("DISPLAY") != "" || e.getenv("WAYLAND_DISPLAY") != ""
	}
	return true
}

// runtimeArgs are the runtime's command line for this machine. Everything is in the command line
// or a file; the approval key is never an argument.
func runtimeArgs(p browserPaths, headed, noSandbox bool) []string {
	args := []string{p.bundle, "--profile", p.profile}
	if headed {
		args = append(args, "--headed")
	} else {
		args = append(args, "--headless")
	}
	args = append(args, "--key-file", p.key)
	if noSandbox {
		args = append(args, "--no-sandbox")
	}
	return args
}

// browserTools is the connector's ceiling: the protocol's six tools and the end-of-task call.
var browserTools = []string{"snapshot", "diff", "act", "extract", "screenshot", "download", "end_task"}

type browserEntry struct {
	Command      string            `json:"command"`
	Args         []string          `json:"args"`
	Env          map[string]string `json:"env"`
	Description  string            `json:"description"`
	AllowedTools []string          `json:"allowedTools"`
}

// editMcpServers reads mcp.json (absent is empty), lets fn change its mcpServers and writes it back,
// keeping every other server and key as they were.
func editMcpServers(path string, fn func(servers map[string]json.RawMessage) (changed bool, err error)) (bool, error) {
	top := map[string]json.RawMessage{}
	body, err := os.ReadFile(path)
	switch {
	case err == nil:
		if len(bytes.TrimSpace(body)) > 0 {
			if err := json.Unmarshal(body, &top); err != nil {
				return false, fmt.Errorf("%s is not valid JSON, so it was left alone: %w", path, err)
			}
		}
	case !os.IsNotExist(err):
		return false, err
	}
	servers := map[string]json.RawMessage{}
	if raw, ok := top["mcpServers"]; ok {
		if err := json.Unmarshal(raw, &servers); err != nil {
			return false, fmt.Errorf("mcpServers in %s is not an object: %w", path, err)
		}
	}
	changed, err := fn(servers)
	if err != nil || !changed {
		return false, err
	}
	raw, _ := json.Marshal(servers)
	top["mcpServers"] = raw
	keys := make([]string, 0, len(top))
	for k := range top {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var buf bytes.Buffer
	buf.WriteString("{\n")
	for i, k := range keys {
		var pretty bytes.Buffer
		if err := json.Indent(&pretty, top[k], "\t", "\t"); err != nil {
			pretty.Write(top[k])
		}
		fmt.Fprintf(&buf, "\t%q: %s", k, pretty.String())
		if i < len(keys)-1 {
			buf.WriteString(",")
		}
		buf.WriteString("\n")
	}
	buf.WriteString("}\n")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return false, err
	}
	perm := os.FileMode(0o600)
	if st, err := os.Stat(path); err == nil {
		perm = st.Mode().Perm()
	}
	return true, writeFileAtomic(path, buf.Bytes(), perm)
}

func browserEnable(env *browserEnv, f browserFlags) error {
	p := pathsFor(env.stateDir)
	info, err := readBrowserInfo(p)
	if err != nil {
		return err
	}
	if _, err := os.Stat(p.bundle); err != nil {
		return errors.New("the runtime is not installed: run 'galopin browser setup' first")
	}
	headed := env.hasDisplay() && !f.headless
	if f.headed {
		if !env.hasDisplay() {
			return errors.New("--headed needs a display, and this machine has none")
		}
		headed = true
	}
	noSandbox := f.noSandbox || !info.Sandbox
	if err := os.MkdirAll(p.profile, 0o700); err != nil {
		return err
	}
	entry := browserEntry{
		Command:      info.Node,
		Args:         runtimeArgs(p, headed, noSandbox),
		Env:          map[string]string{"PLAYWRIGHT_BROWSERS_PATH": p.browsers},
		Description:  "Browser for Cerea's browse tool (managed by 'galopin browser'; do not edit)",
		AllowedTools: browserTools,
	}
	raw, _ := json.Marshal(entry)
	_, err = editMcpServers(env.mcpPath, func(servers map[string]json.RawMessage) (bool, error) {
		servers[browserConnectorName] = raw
		return true, nil
	})
	if err != nil {
		return err
	}
	mode := "headless"
	if headed {
		mode = "with a window"
	}
	env.say("Enabled the local connector %q in %s (%s).", browserConnectorName, env.mcpPath, mode)
	env.say("Profile (your logins stay here): %s", p.profile)
	if noSandbox {
		env.say("Chromium runs without its sandbox on this machine.")
	}
	env.say("galopin picks the change up by itself if it is running; otherwise start it with 'galopin run'. Cerea hands this machine its approval key the first time the browser is used.")
	return nil
}

func browserDisable(env *browserEnv, f browserFlags) error {
	p := pathsFor(env.stateDir)
	removed, err := editMcpServers(env.mcpPath, func(servers map[string]json.RawMessage) (bool, error) {
		if _, ok := servers[browserConnectorName]; !ok {
			return false, nil
		}
		delete(servers, browserConnectorName)
		return true, nil
	})
	if err != nil {
		return err
	}
	if removed {
		env.say("Removed the local connector %q from %s.", browserConnectorName, env.mcpPath)
	} else {
		env.say("The browser was not enabled: nothing to remove.")
	}
	_ = os.Remove(p.key)
	if f.removeProfile {
		if err := os.RemoveAll(p.profile); err != nil {
			return err
		}
		env.say("Removed the profile %s (its logins are gone).", p.profile)
	} else if _, err := os.Stat(p.profile); err == nil {
		env.say("The profile %s is kept (its logins stay); --remove-profile deletes it.", p.profile)
	}
	return nil
}

func browserStatus(ctx context.Context, env *browserEnv) error {
	p := pathsFor(env.stateDir)
	line := func(k, v string) { env.say("%-12s %s", k+":", v) }

	if b, err := os.ReadFile(p.bundle); err != nil {
		line("runtime", "not installed (run 'galopin browser setup')")
	} else if bytes.Equal(b, browserrt.Bundle) {
		line("runtime", "installed, up to date ("+p.runtime+")")
	} else {
		line("runtime", "installed, but older than this galopin (run 'galopin browser setup')")
	}
	if v := installedPlaywright(p); v == "" {
		line("playwright", "not installed")
	} else if v != playwrightVersion() {
		line("playwright", v+" (this galopin pins "+playwrightVersion()+"; run setup)")
	} else {
		line("playwright", v)
	}
	if info, err := readBrowserInfo(p); err != nil {
		line("chromium", "not checked (run 'galopin browser setup')")
	} else {
		sandbox := "sandboxed"
		if !info.Sandbox {
			sandbox = "no sandbox on this machine"
		}
		line("chromium", fmt.Sprintf("%s, %s; node %s", info.Chromium, sandbox, info.NodeVer))
	}

	var entry *mcpconn.Entry
	if entries, err := mcpconn.Load(env.mcpPath, os.LookupEnv); err == nil {
		for _, e := range entries {
			if e.Name == browserConnectorName {
				entry = e
			}
		}
	}
	if entry == nil {
		line("registered", "no (run 'galopin browser enable')")
		return nil
	}
	if entry.Invalid != "" {
		line("registered", "yes, but invalid: "+entry.Invalid)
		return nil
	}
	mode := "headless"
	for _, a := range entry.Args {
		if a == "--headed" {
			mode = "with a window"
		}
	}
	state := "yes, " + mode
	if entry.Disabled {
		state = "yes, but disabled in mcp.json"
	}
	line("registered", state+" ("+env.mcpPath+")")
	if st, err := os.Stat(p.key); err == nil {
		line("key", "fetched from Cerea "+st.ModTime().Format("2006-01-02 15:04"))
	} else {
		line("key", "not fetched yet (Cerea hands it over when its browser is first used)")
	}
	if entry.Disabled {
		return nil
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	res, err := env.check(cctx, mcpconn.Config{Path: env.mcpPath, StateDir: env.stateDir, Logf: func(string, ...any) {}}, browserConnectorName)
	if err != nil {
		line("responding", "no: "+err.Error())
		return exitError{code: 1, err: errors.New("the browser runtime does not answer")}
	}
	missing := []string{}
	have := map[string]bool{}
	for _, t := range res.Tools {
		have[t] = true
	}
	for _, t := range browserTools[:6] {
		if !have[t] {
			missing = append(missing, t)
		}
	}
	if len(missing) > 0 {
		line("responding", "yes, but without "+strings.Join(missing, ", "))
		return exitError{code: 1, err: errors.New("the browser runtime is missing tools")}
	}
	line("responding", fmt.Sprintf("yes (%s %s, %d tools)", res.ServerName, res.ServerVersion, len(res.Tools)))
	return nil
}
