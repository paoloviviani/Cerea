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
  galopin browser setup   [--bundled] [--prune] [--state-dir PATH] [--creds PATH]
  galopin browser enable  [--headed | --headless] [--no-sandbox] [--state-dir PATH] [--creds PATH] [--mcp-config PATH]
  galopin browser disable [--remove-profile] [--state-dir PATH] [--creds PATH] [--mcp-config PATH]
  galopin browser status  [--state-dir PATH] [--creds PATH] [--mcp-config PATH]

  setup    Check that Node (22.18 or newer) is installed, write the runtime into galopin's
           own directory, install its npm dependency there, and try the browser once.
           An installed Google Chrome is used, and then nothing is downloaded; Playwright's
           Chromium is downloaded into galopin's directory only when there is no Chrome, or
           with --bundled. --prune removes a Chromium an earlier setup downloaded. It
           always uses galopin's own profile, never your Chrome profile. Installs nothing
           system-wide.
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
	// exists reports whether a file is there (swapped in tests).
	exists func(path string) bool
	// confirm asks the user a yes/no question; false when there is nobody to ask.
	confirm func(question string) bool
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
		exists: func(path string) bool {
			st, err := os.Stat(path)
			return err == nil && !st.IsDir()
		},
		confirm: askYesNo,
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
	// Browser is "chrome" (an installed Google Chrome, which needs no download) or "chromium"
	// (Playwright's own, downloaded into galopin's directory). Version is its version.
	Browser string `json:"browser"`
	Version string `json:"version"`
	// ChromePath is where an installed Chrome was found.
	ChromePath string `json:"chromePath,omitempty"`
	// Chromium is kept for files written by an earlier setup: the bundled version.
	Chromium string `json:"chromium,omitempty"`
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
	headed, headless, noSandbox, removeProfile, bundled, prune bool
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
	fs.BoolVar(&f.bundled, "bundled", false, "")
	fs.BoolVar(&f.prune, "prune", false, "")
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
		return browserSetup(ctx, env, f)
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

// The runtime's package.json says "node": ">=22.18" (native TypeScript is not needed by the
// bundle, but the Node it was tested on is), and setup holds it to that.
const nodeMinMajor, nodeMinMinor = 22, 18

func nodeOK(v string) bool {
	m := nodeVersionRE.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		return false
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	return major > nodeMinMajor || (major == nodeMinMajor && minor >= nodeMinMinor)
}

// playwrightVersion is the version package.json pins.
// tighten makes an existing directory private to the user (0700), as it holds logins and a key.
func tighten(dir string) {
	if st, err := os.Stat(dir); err == nil && st.IsDir() && st.Mode().Perm() != 0o700 {
		_ = os.Chmod(dir, 0o700)
	}
}

func playwrightVersion() string {
	var p struct {
		Dependencies map[string]string `json:"dependencies"`
	}
	_ = json.Unmarshal(browserrt.PackageJSON, &p)
	return p.Dependencies["playwright-core"]
}

func browserSetup(ctx context.Context, env *browserEnv, f browserFlags) error {
	p := pathsFor(env.stateDir)
	node, err := env.lookPath("node")
	if err != nil {
		return errors.New("Node.js is not installed (or not on PATH). The browser runtime needs Node 22.18 or newer: install it from https://nodejs.org or with your package manager, then run this again. galopin installs nothing system-wide")
	}
	out, err := env.run(ctx, "", nil, node, "--version")
	if err != nil {
		return fmt.Errorf("could not run %s --version: %w", node, err)
	}
	version := strings.TrimSpace(string(out))
	if !nodeOK(version) {
		return fmt.Errorf("Node %s is too old: the browser runtime needs Node %d.%d or newer", version, nodeMinMajor, nodeMinMinor)
	}
	npm, err := env.lookPath("npm")
	if err != nil {
		return errors.New("npm is not installed (it normally comes with Node.js); the runtime's dependencies are installed with it")
	}
	env.say("Node %s at %s", version, node)

	if err := os.MkdirAll(p.runtime, 0o700); err != nil {
		return err
	}
	tighten(p.dir)
	if err := writeFileAtomic(p.bundle, browserrt.Bundle, 0o600); err != nil {
		return err
	}
	if err := writeFileAtomic(filepath.Join(p.runtime, "package.json"), browserrt.PackageJSON, 0o600); err != nil {
		return err
	}
	// The lock carries the tarball's sha512: `npm ci` installs that exact artifact or fails.
	if err := writeFileAtomic(filepath.Join(p.runtime, "package-lock.json"), browserrt.PackageLock, 0o600); err != nil {
		return err
	}
	env.say("Wrote the runtime to %s", p.runtime)

	pinned := playwrightVersion()
	installed := installedPlaywright(p)
	if installed == pinned && pinned != "" {
		env.say("playwright-core %s is already installed", pinned)
	} else {
		env.say("Installing playwright-core %s (npm ci from a lockfile with its sha512, into %s) ...", pinned, p.runtime)
		if out, err := env.run(ctx, p.runtime, nil, npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"); err != nil {
			return fmt.Errorf("npm install failed: %w\n%s", err, tail(out))
		}
	}
	browsersEnv := []string{"PLAYWRIGHT_BROWSERS_PATH=" + p.browsers}

	// An installed Google Chrome is preferred: nothing is downloaded, and it looks like the
	// browser the user already has. galopin's own profile is used with it, never the user's.
	type selfTest struct {
		OK      bool   `json:"ok"`
		Sandbox bool   `json:"sandbox"`
		Version string `json:"version"`
		Error   string `json:"error"`
	}
	try := func(channel string) (*selfTest, error) {
		args := []string{p.bundle, "--self-test"}
		if channel != "" {
			args = append(args, "--channel", channel)
		}
		out, err := env.run(ctx, p.runtime, browsersEnv, node, args...)
		var st selfTest
		if jerr := json.Unmarshal(lastLine(out), &st); jerr != nil || !st.OK {
			msg := firstNonEmpty(st.Error, string(tail(out)))
			if err != nil {
				msg = fmt.Sprintf("%v: %s", err, msg)
			}
			return nil, errors.New(msg)
		}
		return &st, nil
	}
	info := browserInfo{Node: node, NodeVer: version, Playwright: pinned}
	var st *selfTest
	if !f.bundled {
		if chrome := env.findChrome(); chrome != "" {
			env.say("Found Google Chrome at %s", chrome)
			if got, err := try("chrome"); err == nil {
				st = got
				info.Browser, info.Version, info.ChromePath = "chrome", got.Version, chrome
				env.say("Google Chrome %s starts: nothing is downloaded.", got.Version)
			} else {
				env.say("Google Chrome did not start under the runtime (%v); using Chromium instead.", err)
			}
		}
	}
	if st == nil {
		env.say("Installing Chromium into %s ...", p.browsers)
		cli := filepath.Join("node_modules", "playwright-core", "cli.js")
		if out, err := env.run(ctx, p.runtime, browsersEnv, node, cli, "install", "chromium"); err != nil {
			return fmt.Errorf("installing Chromium failed: %w\n%s", err, tail(out))
		}
		got, err := try("")
		if err != nil {
			return fmt.Errorf("the browser did not start: %w", err)
		}
		st = got
		info.Browser, info.Version = "chromium", got.Version
		env.say("Chromium %s starts.", got.Version)
	} else {
		env.prune(p, f.prune)
	}
	info.Sandbox = st.Sandbox
	body, _ := json.MarshalIndent(info, "", "\t")
	if err := writeFileAtomic(p.info, append(body, '\n'), 0o600); err != nil {
		return err
	}
	if !st.Sandbox {
		env.say("Note: the browser's sandbox does not work on this machine (a restricted user namespace or a container), so it will run without it. Pages it opens are then not isolated from your user account: use it for sites you trust, or fix the restriction and run setup again.")
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
func runtimeArgs(p browserPaths, headed, noSandbox bool, channel string) []string {
	args := []string{p.bundle, "--profile", p.profile, "--state-dir", p.dir}
	if headed {
		args = append(args, "--headed")
	} else {
		args = append(args, "--headless")
	}
	args = append(args, "--key-file", p.key)
	if noSandbox {
		args = append(args, "--no-sandbox")
	}
	if channel != "" {
		args = append(args, "--channel", channel)
	}
	return args
}

// browserTools is the connector's ceiling: the protocol's six tools, the end-of-task call, and the tab, resume and open calls.
var browserTools = []string{"snapshot", "diff", "act", "extract", "screenshot", "download", "end_task", "tabs", "resume", "open"}

type browserEntry struct {
	Command      string            `json:"command"`
	Args         []string          `json:"args"`
	Env          map[string]string `json:"env"`
	Description  string            `json:"description"`
	AllowedTools []string          `json:"allowedTools"`
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
	// The profile holds logins and the key sits beside it: an older, looser directory is tightened.
	tighten(p.dir)
	tighten(p.profile)
	entry := browserEntry{
		Command:      info.Node,
		Args:         runtimeArgs(p, headed, noSandbox, channelOf(info)),
		Env:          map[string]string{"PLAYWRIGHT_BROWSERS_PATH": p.browsers},
		Description:  "Browser for Cerea's browse tool (managed by 'galopin browser'; do not edit)",
		AllowedTools: browserTools,
	}
	raw, _ := json.Marshal(entry)
	if _, err = editMcpServers(env.mcpPath, browserConnectorName, raw); err != nil {
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
	removed, err := editMcpServers(env.mcpPath, browserConnectorName, nil)
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
		line("browser", "not checked (run 'galopin browser setup')")
	} else {
		sandbox := "sandboxed"
		if !info.Sandbox {
			sandbox = "no sandbox on this machine"
		}
		line("browser", fmt.Sprintf("%s, %s; node %s", browserLabel(info), sandbox, info.NodeVer))
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

// askYesNo asks on the terminal; with no terminal (a script, a service) it answers no.
func askYesNo(question string) bool {
	st, err := os.Stdin.Stat()
	if err != nil || st.Mode()&os.ModeCharDevice == 0 {
		return false
	}
	fmt.Fprintf(os.Stderr, "%s [y/N] ", question)
	var answer string
	_, _ = fmt.Fscanln(os.Stdin, &answer)
	return strings.EqualFold(strings.TrimSpace(answer), "y") || strings.EqualFold(strings.TrimSpace(answer), "yes")
}

// findChrome returns the path of an installed Google Chrome, or "".
func (e *browserEnv) findChrome() string {
	var candidates []string
	switch e.goos {
	case "darwin":
		home := e.getenv("HOME")
		candidates = []string{"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
		if home != "" {
			candidates = append(candidates, filepath.Join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"))
		}
	case "windows":
		for _, v := range []string{"ProgramFiles", "ProgramFiles(x86)", "LocalAppData"} {
			if base := e.getenv(v); base != "" {
				candidates = append(candidates, filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"))
			}
		}
	default:
		for _, name := range []string{"google-chrome", "google-chrome-stable"} {
			if p, err := e.lookPath(name); err == nil {
				return p
			}
		}
		candidates = []string{"/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"}
	}
	for _, c := range candidates {
		if e.exists(c) {
			return c
		}
	}
	return ""
}

// downloadedChromium is the size in bytes of what an earlier setup downloaded, 0 if nothing.
func downloadedChromium(dir string) int64 {
	var total int64
	_ = filepath.Walk(dir, func(_ string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total
}

// prune offers to remove a Chromium an earlier setup downloaded, now that Chrome is used (--prune
// does it without asking; with nobody to ask, it only says how).
func (e *browserEnv) prune(p browserPaths, force bool) {
	size := downloadedChromium(p.browsers)
	if size == 0 {
		return
	}
	mb := size / (1 << 20)
	if force || e.confirm(fmt.Sprintf("A downloaded Chromium (%d MB) in %s is no longer used. Remove it?", mb, p.browsers)) {
		if err := os.RemoveAll(p.browsers); err != nil {
			e.say("Could not remove %s: %v", p.browsers, err)
			return
		}
		e.say("Removed the downloaded Chromium (%d MB).", mb)
		return
	}
	e.say("A downloaded Chromium (%d MB) in %s is no longer used. Remove it with 'galopin browser setup --prune'.", mb, p.browsers)
}

// channelOf is the Playwright channel the runtime launches: "chrome" for an installed Chrome.
func channelOf(info *browserInfo) string {
	if info.Browser == "chrome" {
		return "chrome"
	}
	return ""
}

// browserLabel is how status names the browser in use.
func browserLabel(info *browserInfo) string {
	if info.Browser == "chrome" {
		return "Google Chrome " + info.Version + " (installed)"
	}
	return "Chromium " + firstNonEmpty(info.Version, info.Chromium) + " (bundled)"
}
