package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"galopin/internal/browserrt"
	"galopin/internal/link"
	"galopin/internal/mcpconn"
)

type runCall struct {
	dir  string
	env  []string
	name string
	args []string
}

type fakeBrowserRig struct {
	env   *browserEnv
	out   *bytes.Buffer
	calls []runCall
	state string
	mcp   string
	// selfTest is what the runtime's --self-test prints.
	selfTest string
	// nodeVersion is what node --version prints.
	nodeVersion string
	hasNPM      bool
	hasNode     bool
	// chrome says an installed Google Chrome is found; chromeSelfTest is what it prints.
	chrome         bool
	chromeSelfTest string
	answer         bool
}

func newBrowserRig(t *testing.T) *fakeBrowserRig {
	t.Helper()
	r := &fakeBrowserRig{out: &bytes.Buffer{}, state: t.TempDir(), selfTest: `{"ok":true,"sandbox":true,"version":"158.0.1"}`, chromeSelfTest: `{"ok":true,"sandbox":true,"version":"142.0.7"}`, nodeVersion: "v24.22.2", hasNPM: true, hasNode: true}
	r.mcp = filepath.Join(r.state, "mcp.json")
	r.env = &browserEnv{
		stateDir: r.state,
		mcpPath:  r.mcp,
		goos:     "linux",
		getenv:   func(k string) string { return map[string]string{"DISPLAY": ":0"}[k] },
		exists:   func(path string) bool { return false },
		confirm:  func(string) bool { return r.answer },
		lookPath: func(name string) (string, error) {
			if name == "google-chrome" && r.chrome {
				return "/usr/bin/google-chrome", nil
			}
			if (name == "node" && r.hasNode) || (name == "npm" && r.hasNPM) {
				return "/fake/bin/" + name, nil
			}
			return "", errors.New("not found")
		},
		run: func(_ context.Context, dir string, env []string, name string, args ...string) ([]byte, error) {
			r.calls = append(r.calls, runCall{dir, env, name, args})
			switch {
			case len(args) == 1 && args[0] == "--version":
				return []byte(r.nodeVersion + "\n"), nil
			case len(args) > 0 && args[0] == "ci" && strings.HasSuffix(name, "npm"):
				pkg := filepath.Join(dir, "node_modules", "playwright-core")
				_ = os.MkdirAll(pkg, 0o755)
				_ = os.WriteFile(filepath.Join(pkg, "package.json"), []byte(`{"version":"`+playwrightVersion()+`"}`), 0o644)
				return nil, nil
			case contains(args, "--self-test") && contains(args, "--channel"):
				return []byte(r.chromeSelfTest + "\n"), nil
			case contains(args, "--self-test"):
				return []byte(r.selfTest + "\n"), nil
			}
			return nil, nil
		},
		check: func(_ context.Context, cfg mcpconn.Config, name string) (*mcpconn.CheckResult, error) {
			return &mcpconn.CheckResult{ServerName: "cerea-browser", ServerVersion: "0.1.0", Tools: browserTools}, nil
		},
		out: r.out,
	}
	return r
}

func (r *fakeBrowserRig) run(t *testing.T, args ...string) error {
	t.Helper()
	return runBrowserWith(context.Background(), r.env, args)
}

func readServers(t *testing.T, path string) map[string]json.RawMessage {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var top struct {
		Servers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(b, &top); err != nil {
		t.Fatalf("%v\n%s", err, b)
	}
	return top.Servers
}

func TestBrowserSetupInstallsIntoGalopinsOwnDirectoryAndSaysWhatItDid(t *testing.T) {
	r := newBrowserRig(t)
	if err := r.run(t, "setup"); err != nil {
		t.Fatal(err)
	}
	p := pathsFor(r.state)
	for _, f := range []string{p.bundle, filepath.Join(p.runtime, "package.json"), p.info} {
		if _, err := os.Stat(f); err != nil {
			t.Errorf("missing %s", f)
		}
	}
	var sawNpm, sawChromium, sawSelfTest bool
	for _, c := range r.calls {
		switch {
		case strings.HasSuffix(c.name, "npm"):
			sawNpm = true
			// A clean install from the lockfile, which carries the tarball's sha512: never `npm install`,
			// and never with the lock switched off.
			if c.args[0] != "ci" || contains(c.args, "--package-lock=false") {
				t.Errorf("npm must run `ci` against the lockfile: %v", c.args)
			}
			if got, _ := os.ReadFile(filepath.Join(p.runtime, "package-lock.json")); !bytes.Equal(got, browserrt.PackageLock) {
				t.Error("the lockfile was not written before npm ran")
			}
			if c.dir != p.runtime || !contains(c.args, "--ignore-scripts") || !contains(c.args, "--omit=dev") {
				t.Errorf("npm ran as %+v", c)
			}
		case len(c.args) >= 3 && c.args[len(c.args)-2] == "install" && c.args[len(c.args)-1] == "chromium":
			sawChromium = true
			if !contains(c.env, "PLAYWRIGHT_BROWSERS_PATH="+p.browsers) {
				t.Errorf("browsers not kept in galopin's directory: %v", c.env)
			}
		case contains(c.args, "--self-test"):
			sawSelfTest = true
		}
		if strings.Contains(strings.Join(c.args, " "), "--with-deps") || strings.Contains(c.name, "sudo") {
			t.Errorf("setup must install nothing system-wide: %+v", c)
		}
	}
	if !sawNpm || !sawChromium || !sawSelfTest {
		t.Errorf("npm=%v chromium=%v selftest=%v", sawNpm, sawChromium, sawSelfTest)
	}
	out := r.out.String()
	for _, want := range []string{"Node v24.22.2", "Wrote the runtime to", "Installing playwright-core", "Installing Chromium into", "Chromium 158.0.1 starts", "galopin browser enable"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	info, err := readBrowserInfo(p)
	if err != nil || info.Version != "158.0.1" || !info.Sandbox || info.Node != "/fake/bin/node" {
		t.Errorf("info %+v %v", info, err)
	}
	// A second run reuses the install.
	r.calls = nil
	if err := r.run(t, "setup"); err != nil {
		t.Fatal(err)
	}
	for _, c := range r.calls {
		if strings.HasSuffix(c.name, "npm") {
			t.Error("npm ran again although playwright-core is installed")
		}
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func TestBrowserSetupRefusesWithoutNodeOrWithAnOldOne(t *testing.T) {
	r := newBrowserRig(t)
	r.hasNode = false
	err := r.run(t, "setup")
	if err == nil || !strings.Contains(err.Error(), "Node.js is not installed") || !strings.Contains(err.Error(), "nothing system-wide") {
		t.Fatalf("%v", err)
	}
	if len(r.calls) != 0 {
		t.Error("something ran")
	}
	r = newBrowserRig(t)
	r.nodeVersion = "v22.17.0"
	if err := r.run(t, "setup"); err == nil || !strings.Contains(err.Error(), "too old") {
		t.Fatalf("%v", err)
	}
	r = newBrowserRig(t)
	r.hasNPM = false
	if err := r.run(t, "setup"); err == nil || !strings.Contains(err.Error(), "npm is not installed") {
		t.Fatalf("%v", err)
	}
}

func TestBrowserSetupNotesAMissingSandbox(t *testing.T) {
	r := newBrowserRig(t)
	r.selfTest = `{"ok":true,"sandbox":false,"version":"158.0.1"}`
	if err := r.run(t, "setup"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.out.String(), "sandbox does not work") {
		t.Errorf("no warning:\n%s", r.out.String())
	}
	r = newBrowserRig(t)
	r.selfTest = `{"ok":false,"error":"no chromium"}`
	if err := r.run(t, "setup"); err == nil || !strings.Contains(err.Error(), "no chromium") {
		t.Fatalf("%v", err)
	}
}

func TestBrowserEnableRegistersTheWellKnownConnectorAndKeepsTheRest(t *testing.T) {
	r := newBrowserRig(t)
	if err := r.run(t, "enable"); err == nil || !strings.Contains(err.Error(), "galopin browser setup") {
		t.Fatalf("enable before setup: %v", err)
	}
	if err := r.run(t, "setup"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(r.mcp, []byte(`{"extra":{"keep":true},"mcpServers":{"notes":{"command":"x","args":["a"]}}}`), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := r.run(t, "enable"); err != nil {
		t.Fatal(err)
	}
	servers := readServers(t, r.mcp)
	if _, ok := servers["notes"]; !ok || len(servers) != 2 {
		t.Fatalf("servers: %v", servers)
	}
	b, _ := os.ReadFile(r.mcp)
	if !strings.Contains(string(b), `"extra"`) {
		t.Errorf("an unknown top-level key was lost:\n%s", b)
	}
	if st, _ := os.Stat(r.mcp); st.Mode().Perm() != 0o640 {
		t.Errorf("mode %v", st.Mode())
	}
	// It is a valid entry for galopin's own parser, with the ceiling and a persistent profile.
	entries, err := mcpconn.Load(r.mcp, func(string) (string, bool) { return "", false })
	if err != nil {
		t.Fatal(err)
	}
	var e *mcpconn.Entry
	for _, x := range entries {
		if x.Name == browserConnectorName {
			e = x
		}
	}
	if e == nil || e.Invalid != "" || e.Transport != mcpconn.TransportStdio {
		t.Fatalf("entry %+v", e)
	}
	p := pathsFor(r.state)
	if e.Command != "/fake/bin/node" || e.Args[0] != p.bundle {
		t.Errorf("command %s %v", e.Command, e.Args)
	}
	if !contains(e.Args, "--profile") || !contains(e.Args, p.profile) || !contains(e.Args, "--key-file") || !contains(e.Args, p.key) {
		t.Errorf("args %v", e.Args)
	}
	if !contains(e.Args, "--headed") || contains(e.Args, "--no-sandbox") {
		t.Errorf("a machine with a display and a sandbox runs headed and sandboxed: %v", e.Args)
	}
	if e.Env["PLAYWRIGHT_BROWSERS_PATH"] != p.browsers {
		t.Errorf("env %v", e.Env)
	}
	if !contains(e.AllowedTools, "act") || len(e.AllowedTools) != 9 {
		t.Errorf("ceiling %v", e.AllowedTools)
	}
	if st, err := os.Stat(p.profile); err != nil || st.Mode().Perm() != 0o700 {
		t.Errorf("profile %v %v", st, err)
	}
	for _, a := range e.Args {
		if strings.Contains(a, "key=") {
			t.Error("a key must never be an argument")
		}
	}
}

func TestBrowserEnableHeadedOnlyWithADisplayAndNoSandboxWhenSetupSaidSo(t *testing.T) {
	r := newBrowserRig(t)
	r.selfTest = `{"ok":true,"sandbox":false,"version":"158.0.1"}`
	if err := r.run(t, "setup"); err != nil {
		t.Fatal(err)
	}
	r.env.getenv = func(string) string { return "" }
	if err := r.run(t, "enable"); err != nil {
		t.Fatal(err)
	}
	args := entryArgs(t, r)
	if !contains(args, "--headless") || contains(args, "--headed") || !contains(args, "--no-sandbox") {
		t.Errorf("args %v", args)
	}
	if err := r.run(t, "enable", "--headed"); err == nil || !strings.Contains(err.Error(), "needs a display") {
		t.Errorf("headed without a display: %v", err)
	}
	r.env.getenv = func(k string) string { return map[string]string{"WAYLAND_DISPLAY": "wayland-0"}[k] }
	if err := r.run(t, "enable", "--headless"); err != nil || !contains(entryArgs(t, r), "--headless") {
		t.Errorf("--headless: %v", err)
	}
	if err := r.run(t, "enable", "--headed", "--headless"); err == nil {
		t.Error("contradiction accepted")
	}
	// macOS and Windows always have a window to show.
	r.env.goos = "darwin"
	r.env.getenv = func(string) string { return "" }
	if err := r.run(t, "enable"); err != nil || !contains(entryArgs(t, r), "--headed") {
		t.Errorf("darwin: %v", err)
	}
}

func entryArgs(t *testing.T, r *fakeBrowserRig) []string {
	t.Helper()
	var e browserEntry
	if err := json.Unmarshal(readServers(t, r.mcp)[browserConnectorName], &e); err != nil {
		t.Fatal(err)
	}
	return e.Args
}

func TestBrowserDisableRemovesOnlyItsEntryAndKeepsTheProfile(t *testing.T) {
	r := newBrowserRig(t)
	if err := r.run(t, "setup"); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(r.mcp, []byte(`{"mcpServers":{"notes":{"command":"x"}}}`), 0o600)
	if err := r.run(t, "enable"); err != nil {
		t.Fatal(err)
	}
	p := pathsFor(r.state)
	_ = os.WriteFile(filepath.Join(p.profile, "Cookies"), []byte("x"), 0o600)
	_ = os.WriteFile(p.key, []byte("k"), 0o600)
	if err := r.run(t, "disable"); err != nil {
		t.Fatal(err)
	}
	servers := readServers(t, r.mcp)
	if _, ok := servers[browserConnectorName]; ok || len(servers) != 1 {
		t.Fatalf("servers %v", servers)
	}
	if _, err := os.Stat(filepath.Join(p.profile, "Cookies")); err != nil {
		t.Error("the profile was not kept")
	}
	if _, err := os.Stat(p.key); err == nil {
		t.Error("the key stays after disable")
	}
	r.out.Reset()
	if err := r.run(t, "disable"); err != nil || !strings.Contains(r.out.String(), "nothing to remove") {
		t.Fatalf("second disable: %v %s", err, r.out.String())
	}
	if err := r.run(t, "disable", "--remove-profile"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p.profile); err == nil {
		t.Error("--remove-profile left the profile")
	}
}

func TestBrowserEnableLeavesAnInvalidMcpJsonAlone(t *testing.T) {
	r := newBrowserRig(t)
	_ = r.run(t, "setup")
	_ = os.WriteFile(r.mcp, []byte(`{not json`), 0o600)
	if err := r.run(t, "enable"); err == nil || !strings.Contains(err.Error(), "left alone") {
		t.Fatalf("%v", err)
	}
	if b, _ := os.ReadFile(r.mcp); string(b) != "{not json" {
		t.Error("the file was changed")
	}
}

func TestBrowserStatusReportsEachStep(t *testing.T) {
	r := newBrowserRig(t)
	if err := r.run(t, "status"); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"not installed", "not checked", "no (run 'galopin browser enable')"} {
		if !strings.Contains(r.out.String(), want) {
			t.Errorf("status lacks %q:\n%s", want, r.out.String())
		}
	}
	_ = r.run(t, "setup")
	_ = r.run(t, "enable")
	r.out.Reset()
	if err := r.run(t, "status"); err != nil {
		t.Fatal(err)
	}
	out := r.out.String()
	for _, want := range []string{"installed, up to date", "Chromium 158.0.1 (bundled), sandboxed", "yes, with a window", "not fetched yet", "yes (cerea-browser 0.1.0, 9 tools)"} {
		if !strings.Contains(out, want) {
			t.Errorf("status lacks %q:\n%s", want, out)
		}
	}
	_ = os.WriteFile(pathsFor(r.state).key, []byte("k"), 0o600)
	r.out.Reset()
	_ = r.run(t, "status")
	if !strings.Contains(r.out.String(), "fetched from Cerea") || strings.Contains(r.out.String(), "k\n") {
		t.Errorf("key line:\n%s", r.out.String())
	}
	r.env.check = func(context.Context, mcpconn.Config, string) (*mcpconn.CheckResult, error) {
		return nil, errors.New("exit status 1")
	}
	r.out.Reset()
	if err := r.run(t, "status"); err == nil || !strings.Contains(r.out.String(), "responding:  no: exit status 1") {
		t.Errorf("a runtime that does not answer: %v\n%s", err, r.out.String())
	}
	r.env.check = func(context.Context, mcpconn.Config, string) (*mcpconn.CheckResult, error) {
		return &mcpconn.CheckResult{Tools: []string{"snapshot"}}, nil
	}
	r.out.Reset()
	if err := r.run(t, "status"); err == nil || !strings.Contains(r.out.String(), "without diff, act") {
		t.Errorf("missing tools: %v\n%s", err, r.out.String())
	}
}

func TestBrowserProfileAndKeyLiveUnderTheStateDirectory(t *testing.T) {
	p := pathsFor("/home/u/.config/galopin")
	if p.profile != "/home/u/.config/galopin/browser/profile" || p.key != "/home/u/.config/galopin/browser/key" {
		t.Errorf("%+v", p)
	}
}

func TestBrowserUnknownSubcommandAndExtraArguments(t *testing.T) {
	r := newBrowserRig(t)
	if err := r.run(t, "frobnicate"); err == nil {
		t.Error("unknown subcommand accepted")
	}
	if err := r.run(t, "status", "extra"); err == nil {
		t.Error("extra argument accepted")
	}
}

// ---- the approval key ----

type fakeCaller struct {
	supports bool
	res      json.RawMessage
	err      *link.OpError
	ops      []string
	calls    []link.Call
}

func (f *fakeCaller) Supports(family string) bool { return f.supports && family == "browser" }
func (f *fakeCaller) Call(_ context.Context, c link.Call) (json.RawMessage, *link.OpError) {
	f.ops = append(f.ops, c.Op)
	f.calls = append(f.calls, c)
	return f.res, f.err
}

func TestFetchBrowserKeyWritesItPrivately(t *testing.T) {
	key := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	path := filepath.Join(t.TempDir(), "browser", "key")
	f := &fakeCaller{supports: true, res: json.RawMessage(`{"key":"` + key + `","alg":"HMAC-SHA256"}`)}
	if oerr := fetchBrowserKey(context.Background(), f, path); oerr != nil {
		t.Fatal(oerr)
	}
	if len(f.ops) != 1 || f.ops[0] != "browser.key" {
		t.Errorf("ops %v", f.ops)
	}
	// The frame is the one the protocol fixture documents.
	var fixture struct {
		Frame struct {
			Op, SessionID, RootSessionID string
			Caller                       json.RawMessage
			Args                         json.RawMessage
		}
	}
	raw, err := os.ReadFile(filepath.Join("protocol-fixtures", "calls", "browser.key.call.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	got := f.calls[0]
	gotCaller, _ := json.Marshal(got.Caller)
	var wantCaller, haveCaller map[string]any
	_ = json.Unmarshal(fixture.Frame.Caller, &wantCaller)
	_ = json.Unmarshal(gotCaller, &haveCaller)
	if got.SessionID != fixture.Frame.SessionID || got.RootSessionID != fixture.Frame.RootSessionID ||
		!reflect.DeepEqual(wantCaller, haveCaller) {
		t.Errorf("call %+v caller %v, fixture %+v caller %v", got, haveCaller, fixture.Frame, wantCaller)
	}
	b, _ := os.ReadFile(path)
	if strings.TrimSpace(string(b)) != key {
		t.Error("key not written")
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", st.Mode())
	}
}

func TestFetchBrowserKeyRefusalsAreReadable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "key")
	good := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
	cases := []struct {
		name string
		f    machineCaller
		code string
		want string
	}{
		{"no link", nil, "unavailable", "not reachable"},
		{"old cerea", &fakeCaller{supports: false}, "unavailable", "does not support browser use"},
		{"unpaired", &fakeCaller{supports: true, err: &link.OpError{Code: "forbidden", Message: "not paired yet"}}, "forbidden", "not paired yet"},
		{"off", &fakeCaller{supports: true, err: &link.OpError{Code: "unavailable", Message: "switched off"}}, "unavailable", "switched off"},
		{"short key", &fakeCaller{supports: true, res: json.RawMessage(`{"key":"AAAA","alg":"HMAC-SHA256"}`)}, "unavailable", "wrong shape"},
		{"other alg", &fakeCaller{supports: true, res: json.RawMessage(`{"key":"` + good + `","alg":"RS256"}`)}, "unavailable", "update galopin"},
		{"garbage", &fakeCaller{supports: true, res: json.RawMessage(`nope`)}, "unavailable", "update galopin"},
	}
	for _, c := range cases {
		oerr := fetchBrowserKey(context.Background(), c.f, path)
		if oerr == nil || oerr.Code != c.code || !strings.Contains(oerr.Message, c.want) {
			t.Errorf("%s: %+v", c.name, oerr)
		}
		if strings.Contains(oerr.Message, good) {
			t.Errorf("%s: the message carries a key", c.name)
		}
	}
	if _, err := os.Stat(path); err == nil {
		t.Error("a refused fetch wrote a key")
	}
}

func TestBrowserHookOnlyActsOnTheBrowserConnector(t *testing.T) {
	mc := &machine{}
	hook := mc.browserBeforeStart(t.TempDir())
	if oerr := hook(context.Background(), &mcpconn.Entry{Name: "notes"}); oerr != nil {
		t.Errorf("another connector was held up: %+v", oerr)
	}
	// With no link the browser's open is refused with a sentence, not a crash.
	if oerr := hook(context.Background(), &mcpconn.Entry{Name: browserConnectorName}); oerr == nil || !strings.Contains(oerr.Message, "not reachable") {
		t.Errorf("%+v", oerr)
	}
}

func TestBrowserSetupNeedsNode2218(t *testing.T) {
	for _, tc := range []struct {
		v  string
		ok bool
	}{{"v22.17.9", false}, {"v22.18.0", true}, {"v22.22.1", true}, {"v23.0.0", true}, {"v24.22.2", true}, {"v20.19.0", false}, {"v18.19.0", false}, {"garbage", false}} {
		if nodeOK(tc.v) != tc.ok {
			t.Errorf("nodeOK(%q) = %v", tc.v, !tc.ok)
		}
	}
	r := newBrowserRig(t)
	r.nodeVersion = "v22.17.0"
	if err := r.run(t, "setup"); err == nil || !strings.Contains(err.Error(), "22.18") {
		t.Fatalf("%v", err)
	}
}

func TestBrowserEnableTightensALooseProfileAndStateDirectory(t *testing.T) {
	r := newBrowserRig(t)
	if err := r.run(t, "setup"); err != nil {
		t.Fatal(err)
	}
	p := pathsFor(r.state)
	if err := os.MkdirAll(p.profile, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(p.profile, 0o755)
	_ = os.Chmod(p.dir, 0o755)
	if err := r.run(t, "enable"); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{p.profile, p.dir} {
		if st, _ := os.Stat(d); st.Mode().Perm() != 0o700 {
			t.Errorf("%s is %v", d, st.Mode().Perm())
		}
	}
	if !contains(entryArgs(t, r), "--state-dir") {
		t.Error("the runtime is not told where to keep spent approvals")
	}
}

// The documented answer (protocol-fixtures/calls/browser.key.callres.json) is accepted as it is.
func TestFetchBrowserKeyAcceptsTheFixtureAnswer(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("protocol-fixtures", "calls", "browser.key.callres.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Frame struct {
			Result json.RawMessage `json:"result"`
		} `json:"frame"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "key")
	if oerr := fetchBrowserKey(context.Background(), &fakeCaller{supports: true, res: fixture.Frame.Result}, path); oerr != nil {
		t.Fatal(oerr)
	}
	b, _ := os.ReadFile(path)
	if strings.TrimSpace(string(b)) != "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc" {
		t.Errorf("%q", b)
	}
}

func (r *fakeBrowserRig) ranChromiumInstall() bool {
	for _, c := range r.calls {
		if len(c.args) >= 2 && c.args[len(c.args)-2] == "install" && c.args[len(c.args)-1] == "chromium" {
			return true
		}
	}
	return false
}

func TestBrowserSetupUsesAnInstalledChromeAndDownloadsNothing(t *testing.T) {
	r := newBrowserRig(t)
	r.chrome = true
	if err := r.run(t, "setup"); err != nil {
		t.Fatal(err)
	}
	if r.ranChromiumInstall() {
		t.Fatal("Chromium was downloaded although Chrome is installed")
	}
	var trySelfTest bool
	for _, c := range r.calls {
		if contains(c.args, "--self-test") && contains(c.args, "--channel") && contains(c.args, "chrome") {
			trySelfTest = true
		}
	}
	if !trySelfTest {
		t.Error("Chrome was not tried with the runtime's self test")
	}
	info, err := readBrowserInfo(pathsFor(r.state))
	if err != nil || info.Browser != "chrome" || info.Version != "142.0.7" || info.ChromePath != "/usr/bin/google-chrome" {
		t.Fatalf("%+v %v", info, err)
	}
	if !strings.Contains(r.out.String(), "nothing is downloaded") {
		t.Errorf("%s", r.out.String())
	}
	// enable launches Chrome with galopin's own profile, and says nothing about the user's.
	if err := r.run(t, "enable"); err != nil {
		t.Fatal(err)
	}
	args := entryArgs(t, r)
	if !contains(args, "--channel") || !contains(args, "chrome") || !contains(args, pathsFor(r.state).profile) {
		t.Errorf("args %v", args)
	}
	r.out.Reset()
	if err := r.run(t, "status"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.out.String(), "browser:     Google Chrome 142.0.7 (installed)") {
		t.Errorf("status:\n%s", r.out.String())
	}
}

func TestBrowserSetupFallsBackToChromiumWhenChromeWillNotStartOrIsAbsent(t *testing.T) {
	r := newBrowserRig(t)
	r.chrome = true
	r.chromeSelfTest = `{"ok":false,"error":"chrome too new"}`
	if err := r.run(t, "setup"); err != nil {
		t.Fatal(err)
	}
	if !r.ranChromiumInstall() {
		t.Error("no fallback to Chromium")
	}
	info, _ := readBrowserInfo(pathsFor(r.state))
	if info.Browser != "chromium" || channelOf(info) != "" {
		t.Errorf("%+v", info)
	}
	if !strings.Contains(r.out.String(), "chrome too new") {
		t.Errorf("the reason was not said:\n%s", r.out.String())
	}
	// No Chrome at all: Chromium, and the status names it as bundled.
	r2 := newBrowserRig(t)
	if err := r2.run(t, "setup"); err != nil || !r2.ranChromiumInstall() {
		t.Fatalf("%v", err)
	}
	r2.out.Reset()
	_ = r2.run(t, "status")
	if !strings.Contains(r2.out.String(), "Chromium 158.0.1 (bundled)") {
		t.Errorf("%s", r2.out.String())
	}
}

func TestBrowserSetupBundledForcesChromium(t *testing.T) {
	r := newBrowserRig(t)
	r.chrome = true
	if err := r.run(t, "setup", "--bundled"); err != nil {
		t.Fatal(err)
	}
	if !r.ranChromiumInstall() {
		t.Fatal("--bundled did not download Chromium")
	}
	info, _ := readBrowserInfo(pathsFor(r.state))
	if info.Browser != "chromium" {
		t.Errorf("%+v", info)
	}
	for _, c := range r.calls {
		if contains(c.args, "--channel") {
			t.Error("Chrome was tried although --bundled was given")
		}
	}
}

func TestBrowserSetupOffersToRemoveAnEarlierChromiumDownload(t *testing.T) {
	seed := func(r *fakeBrowserRig) string {
		dir := pathsFor(r.state).browsers
		_ = os.MkdirAll(filepath.Join(dir, "chromium-1254"), 0o755)
		_ = os.WriteFile(filepath.Join(dir, "chromium-1254", "chrome"), bytes.Repeat([]byte("x"), 3<<20), 0o644)
		return dir
	}
	// Nobody to ask: it says how, and keeps the files.
	r := newBrowserRig(t)
	r.chrome = true
	dir := seed(r)
	if err := r.run(t, "setup"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); err != nil || !strings.Contains(r.out.String(), "setup --prune") {
		t.Errorf("not offered, or removed unasked:\n%s", r.out.String())
	}
	// The user says yes.
	r = newBrowserRig(t)
	r.chrome, r.answer = true, true
	dir = seed(r)
	_ = r.run(t, "setup")
	if _, err := os.Stat(dir); err == nil || !strings.Contains(r.out.String(), "Removed the downloaded Chromium (3 MB)") {
		t.Errorf("not removed after yes:\n%s", r.out.String())
	}
	// --prune does it without asking.
	r = newBrowserRig(t)
	r.chrome = true
	dir = seed(r)
	_ = r.run(t, "setup", "--prune")
	if _, err := os.Stat(dir); err == nil {
		t.Error("--prune left the download")
	}
	// Chromium in use is never removed.
	r = newBrowserRig(t)
	dir = seed(r)
	_ = r.run(t, "setup", "--prune")
	if _, err := os.Stat(dir); err != nil {
		t.Error("the Chromium in use was removed")
	}
}

func TestFindChromePerOperatingSystem(t *testing.T) {
	has := map[string]bool{}
	e := &browserEnv{
		getenv: func(k string) string {
			return map[string]string{"HOME": "/Users/u", "ProgramFiles": `C:\Program Files`, "LocalAppData": `C:\Users\u\AppData\Local`}[k]
		},
		lookPath: func(string) (string, error) { return "", errors.New("no") },
		exists:   func(p string) bool { return has[p] },
	}
	e.goos = "darwin"
	if e.findChrome() != "" {
		t.Error("found a Chrome that is not there")
	}
	has["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] = true
	if e.findChrome() != "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" {
		t.Error("macOS")
	}
	e.goos = "linux"
	has["/opt/google/chrome/chrome"] = true
	if e.findChrome() != "/opt/google/chrome/chrome" {
		t.Error("linux path")
	}
	e.goos = "windows"
	has[filepath.Join(`C:\Program Files`, "Google", "Chrome", "Application", "chrome.exe")] = true
	if !strings.HasSuffix(e.findChrome(), "chrome.exe") {
		t.Error("windows")
	}
}
