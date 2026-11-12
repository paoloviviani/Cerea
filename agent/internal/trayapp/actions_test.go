package trayapp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"galopin/internal/appstatus"
)

type call struct {
	name string
	args []string
	env  []string
}

type fake struct {
	calls  []call
	loaded bool
	out    map[string]string
	fail   map[string]bool
	lines  []string
}

func (f *fake) run(ctx context.Context, name string, args, env []string, onLine func(string)) (string, error) {
	f.calls = append(f.calls, call{name, args, env})
	key := name
	if name == "launchctl" {
		key += " " + args[0]
		switch args[0] {
		case "print":
			if !f.loaded {
				return "", os.ErrNotExist
			}
		case "bootstrap":
			f.loaded = true
		case "bootout":
			f.loaded = false
		}
	}
	if onLine != nil {
		for _, l := range f.lines {
			onLine(l)
		}
	}
	if f.fail[key] {
		return f.out[key], os.ErrInvalid
	}
	return f.out[key], nil
}

func newApp(t *testing.T) (*App, *fake) {
	home := t.TempDir()
	f := &fake{out: map[string]string{}, fail: map[string]bool{}}
	return &App{
		Layout: Layout{Bundle: filepath.Join(home, "Applications", BundleDirName)},
		Paths:  Paths{Home: home}, UID: 501, Run: f.run, Now: time.Now,
	}, f
}

func TestSnapshot(t *testing.T) {
	a, f := newApp(t)
	in := a.Snapshot(context.Background(), false)
	if in.HasCredentials || in.ServiceLoaded || in.LoginItem || in.StatusOK {
		t.Fatalf("empty home: %+v", in)
	}
	os.MkdirAll(a.Paths.StateDir(), 0o700)
	os.WriteFile(filepath.Join(a.Paths.StateDir(), "credentials.json"), []byte(`{"cerea_origin":"https://c.example","refresh_token":"SECRET"}`), 0o600)
	appstatus.Write(a.Paths.StateDir(), appstatus.Status{Link: appstatus.LinkConnected})
	f.loaded = true
	in = a.Snapshot(context.Background(), true)
	if !in.HasCredentials || in.CredsCerea != "https://c.example" || !in.ServiceLoaded || !in.StatusOK || !in.Busy {
		t.Fatalf("%+v", in)
	}
}

func TestStartStopService(t *testing.T) {
	a, f := newApp(t)
	if err := a.StartService(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !f.loaded {
		t.Fatal("not bootstrapped")
	}
	if _, err := os.Stat(a.Paths.ServicePlist()); err != nil {
		t.Fatal("plist not written")
	}
	n := len(f.calls)
	if err := a.StartService(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, c := range f.calls[n:] {
		if c.name == "launchctl" && c.args[0] == "bootstrap" {
			t.Fatal("bootstrapped twice")
		}
	}
	if err := a.StopService(context.Background()); err != nil || f.loaded {
		t.Fatal("not stopped", err)
	}
	f.fail["launchctl bootstrap"] = true
	f.out["launchctl bootstrap"] = "Bootstrap failed: 5: Input/output error\n"
	if err := a.StartService(context.Background()); err == nil || !strings.Contains(err.Error(), "Input/output error") {
		t.Fatal(err)
	}
}

func TestLoginItemAndInstallAgents(t *testing.T) {
	a, _ := newApp(t)
	if err := a.InstallAgents(); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{a.Paths.ServicePlist(), a.Paths.TrayPlist()} {
		if _, err := os.Stat(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.SetLoginItem(false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(a.Paths.TrayPlist()); !os.IsNotExist(err) {
		t.Fatal("login item stays")
	}
	if err := a.SetLoginItem(false); err != nil {
		t.Fatal("removing twice should be fine:", err)
	}
}

func TestPairShowsCodeOnceAndRestarts(t *testing.T) {
	a, f := newApp(t)
	f.lines = []string{"  open:  https://idp/d?c=X", "  enter: ABCD-1234", "  enter: ABCD-1234"}
	var got []SignIn
	if err := a.Pair(context.Background(), "https://c.example", false, func(s SignIn) { got = append(got, s) }); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Code != "ABCD-1234" || got[0].URL != "https://idp/d?c=X" {
		t.Fatalf("%+v", got)
	}
	enroll := f.calls[0]
	if enroll.name != a.Layout.CLI() || !strings.Contains(strings.Join(enroll.args, " "), "--connectors-only") {
		t.Fatalf("%+v", enroll)
	}
	if !strings.HasPrefix(enroll.env[0], "PATH="+a.Layout.NodeBin()) {
		t.Fatal(enroll.env)
	}
	if !f.loaded {
		t.Fatal("service not restarted")
	}
}

func TestPairFailureSaysWhy(t *testing.T) {
	a, f := newApp(t)
	f.fail[a.Layout.CLI()] = true
	f.out[a.Layout.CLI()] = "error: discovery: no such host\n"
	err := a.Pair(context.Background(), "https://nope.example", false, func(SignIn) {})
	if err == nil || !strings.Contains(err.Error(), "no such host") {
		t.Fatal(err)
	}
}

func TestSetupBrowserRunsSetupThenEnable(t *testing.T) {
	a, f := newApp(t)
	if err := a.SetupBrowser(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.calls) != 2 || f.calls[0].args[1] != "setup" || f.calls[1].args[1] != "enable" {
		t.Fatalf("%+v", f.calls)
	}
}

func TestAppleScriptQuote(t *testing.T) {
	if got := AppleScriptQuote(`a "b" \c`); got != `"a \"b\" \\c"` {
		t.Fatal(got)
	}
}

func TestAskAddressCancel(t *testing.T) {
	a, f := newApp(t)
	f.fail["osascript"] = true
	if _, ok := a.AskAddress(context.Background(), ""); ok {
		t.Fatal("cancel should not be ok")
	}
}

func TestFirstRunOnce(t *testing.T) {
	a, _ := newApp(t)
	first, err := a.FirstRun()
	if err != nil || !first {
		t.Fatal(first, err)
	}
	if _, err := os.Stat(a.Paths.TrayPlist()); err != nil {
		t.Fatal("login item not set")
	}
	os.Remove(a.Paths.TrayPlist()) // the user turned it off
	first, err = a.FirstRun()
	if err != nil || first {
		t.Fatal("second run should do nothing", first, err)
	}
	if _, err := os.Stat(a.Paths.TrayPlist()); !os.IsNotExist(err) {
		t.Fatal("login item came back")
	}
}

func TestEditConnectors(t *testing.T) {
	a, f := newApp(t)
	path := filepath.Join(a.Paths.StateDir(), "mcp.json")
	if err := a.EditConnectors(context.Background()); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("stat %v %v", st, err)
	}
	body, _ := os.ReadFile(path)
	var v struct {
		S map[string]any `json:"mcpServers"`
	}
	if json.Unmarshal(body, &v) != nil || v.S == nil {
		t.Fatalf("template not valid: %s", body)
	}
	last := f.calls[len(f.calls)-1]
	if last.name != "open" || len(last.args) != 2 || last.args[0] != "-e" || last.args[1] != path {
		t.Fatalf("call %+v", last)
	}
	// An existing file (e.g. with cerea-browser) is left alone.
	mine := `{"mcpServers":{"cerea-browser":{"command":"x"}}}`
	os.WriteFile(path, []byte(mine), 0o644)
	if err := a.EditConnectors(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); string(got) != mine {
		t.Fatalf("overwritten: %s", got)
	}
}

func TestEditConnectorsEnvPath(t *testing.T) {
	a, f := newApp(t)
	p := filepath.Join(t.TempDir(), "x", "c.json")
	a.Getenv = func(string) string { return p }
	if err := a.EditConnectors(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatal(err)
	}
	if f.calls[len(f.calls)-1].args[1] != p {
		t.Fatal("wrong path")
	}
}

func TestMenuHasEditItem(t *testing.T) {
	if !Build(Input{Now: time.Now()}).EditEnabled {
		t.Fatal("edit item must always be enabled")
	}
}
