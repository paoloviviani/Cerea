package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/packaging"
)

func TestRenderSystemdUnit(t *testing.T) {
	got := renderSystemdUnit(packaging.SystemdUnit(), "/opt/my tools/galopin", []string{"--backend", "acp", "--acp-command", `my-agent --x "y" 100%`, "--machine-name", "lap top"})
	for _, want := range []string{
		`ExecStart="/opt/my tools/galopin" run --backend acp --acp-command "my-agent --x \"y\" 100%%" --machine-name "lap top"`,
		"RestartPreventExitStatus=78",
		"Restart=on-failure",
		"WantedBy=default.target",
		`Environment="PATH=/opt/my tools:%h/.local/bin`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("unit lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "install -D") {
		t.Errorf("the manual-install header must not be in the written unit:\n%s", got)
	}
	plain := renderSystemdUnit(packaging.SystemdUnit(), "/home/u/.local/bin/galopin", nil)
	if !strings.Contains(plain, "ExecStart=/home/u/.local/bin/galopin run\n") {
		t.Errorf("plain unit:\n%s", plain)
	}
}

func TestRenderLaunchdPlist(t *testing.T) {
	got := renderLaunchdPlist(packaging.LaunchdPlist(), "/Users/a b", "/Users/a b/bin/galopin", "/Users/a b/Library/Logs/galopin.log",
		[]string{"--backend", "acp", "--acp-command", "agent <x> & y"})
	for _, want := range []string{
		"<string>/Users/a b/bin/galopin</string>\n    <string>run</string>\n    <string>--backend</string>",
		"<string>agent &lt;x&gt; &amp; y</string>",
		"<key>PATH</key><string>/Users/a b/bin:/Users/a b/.local/bin:",
		"<string>/Users/a b/Library/Logs/galopin.log</string>",
		"<key>KeepAlive</key>",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("plist lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "USER") || strings.Contains(got, "sed ") {
		t.Errorf("template placeholders or install header left:\n%s", got)
	}
}

// fakeCtl puts fake systemctl, loginctl and launchctl on PATH; each appends its arguments to calls.
func fakeCtl(t *testing.T, linger string) (calls string) {
	t.Helper()
	dir := t.TempDir()
	calls = filepath.Join(dir, "calls")
	script := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\necho \""+name+" $*\" >> "+calls+"\n"+body+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// is-active answers from a marker the fake enable/stop maintain.
	script("systemctl", `case "$2" in
  enable) : > "`+dir+`/active" ;;
  disable) rm -f "`+dir+`/active" ;;
  is-active) [ -f "`+dir+`/active" ] ;;
  is-enabled) [ -f "`+dir+`/active" ] ;;
esac`)
	script("loginctl", "echo Linger="+linger)
	script("launchctl", `case "$1" in print) [ -f "`+dir+`/loaded" ] && echo "	pid = 42" ;; bootstrap) : > "`+dir+`/loaded" ;; bootout) rm -f "`+dir+`/loaded" ;; esac`)
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	return calls
}

func readCalls(t *testing.T, calls string) string {
	t.Helper()
	b, _ := os.ReadFile(calls)
	return string(b)
}

func testServiceEnv(t *testing.T, goos string) (*serviceEnv, *bytes.Buffer) {
	t.Helper()
	home := t.TempDir()
	out := &bytes.Buffer{}
	return &serviceEnv{goos: goos, home: home, exe: filepath.Join(home, ".local", "bin", "galopin"), uid: 501, user: "ada", out: out}, out
}

func TestServiceLinuxLifecycle(t *testing.T) {
	if inContainer() {
		t.Skip("runs in a container")
	}
	calls := fakeCtl(t, "no")
	env, out := testServiceEnv(t, "linux")

	if err := env.dispatch([]string{"install", "--", "--backend", "acp", "--acp-command", "my agent acp"}); err != nil {
		t.Fatal(err)
	}
	unit, err := os.ReadFile(env.unitPath())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(unit), `run --backend acp --acp-command "my agent acp"`) {
		t.Errorf("flags not kept:\n%s", unit)
	}
	c := readCalls(t, calls)
	for _, want := range []string{"systemctl --user daemon-reload", "systemctl --user enable --now galopin.service"} {
		if !strings.Contains(c, want) {
			t.Errorf("calls lack %q:\n%s", want, c)
		}
	}
	if strings.Contains(c, "restart") {
		t.Errorf("a first install must not restart:\n%s", c)
	}
	if !strings.Contains(out.String(), "loginctl enable-linger ada") {
		t.Errorf("no linger hint:\n%s", out)
	}

	// Re-install updates the unit and restarts.
	out.Reset()
	if err := env.dispatch([]string{"install"}); err != nil {
		t.Fatal(err)
	}
	unit, _ = os.ReadFile(env.unitPath())
	if strings.Contains(string(unit), "--backend") {
		t.Errorf("re-install kept the old flags:\n%s", unit)
	}
	if c := readCalls(t, calls); !strings.Contains(c, "systemctl --user restart galopin.service") {
		t.Errorf("re-install did not restart:\n%s", c)
	}

	out.Reset()
	if err := env.dispatch([]string{"status"}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Installed: yes", "Running:   yes", "journalctl --user -u galopin -f", "enable-linger"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("status lacks %q:\n%s", want, out)
		}
	}

	out.Reset()
	if err := env.dispatch([]string{"uninstall"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(env.unitPath()); !os.IsNotExist(err) {
		t.Errorf("unit still there: %v", err)
	}
	if c := readCalls(t, calls); !strings.Contains(c, "disable --now galopin.service") {
		t.Errorf("no disable:\n%s", c)
	}
	// A second uninstall is not an error.
	if err := env.dispatch([]string{"uninstall"}); err != nil {
		t.Fatal(err)
	}
}

func TestServiceLingerOnPrintsNoHint(t *testing.T) {
	if inContainer() {
		t.Skip("runs in a container")
	}
	fakeCtl(t, "yes")
	env, out := testServiceEnv(t, "linux")
	if err := env.dispatch([]string{"install"}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "enable-linger") {
		t.Errorf("hint shown although linger is on:\n%s", out)
	}
}

func TestServiceDarwinLifecycle(t *testing.T) {
	calls := fakeCtl(t, "no")
	env, out := testServiceEnv(t, "darwin")
	if err := env.dispatch([]string{"install", "--machine-name", "mac"}); err != nil {
		t.Fatal(err)
	}
	plist, err := os.ReadFile(env.plistPath())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(plist), "<string>--machine-name</string>") || !strings.Contains(string(plist), env.home+"/Library/Logs/galopin.log") {
		t.Errorf("plist:\n%s", plist)
	}
	c := readCalls(t, calls)
	for _, want := range []string{"launchctl bootstrap gui/501 " + env.plistPath(), "launchctl kickstart -k gui/501/org.cerea.galopin"} {
		if !strings.Contains(c, want) {
			t.Errorf("calls lack %q:\n%s", want, c)
		}
	}
	// Re-install unloads what is loaded first.
	if err := env.dispatch([]string{"install"}); err != nil {
		t.Fatal(err)
	}
	if c := readCalls(t, calls); !strings.Contains(c, "launchctl bootout gui/501/org.cerea.galopin") {
		t.Errorf("no bootout on re-install:\n%s", c)
	}
	out.Reset()
	if err := env.dispatch([]string{"status"}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Installed: yes", "Loaded:    yes", "pid = 42", "Library/Logs/galopin.log"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("status lacks %q:\n%s", want, out)
		}
	}
	if err := env.dispatch([]string{"uninstall"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(env.plistPath()); !os.IsNotExist(err) {
		t.Errorf("plist still there")
	}
}

func TestServiceRefusals(t *testing.T) {
	env, _ := testServiceEnv(t, "windows")
	if err := env.dispatch([]string{"install"}); err == nil || !strings.Contains(err.Error(), "WSL") {
		t.Errorf("windows: %v", err)
	}
	mac, _ := testServiceEnv(t, "darwin")
	_ = os.MkdirAll(filepath.Join(mac.home, "Library", "LaunchAgents"), 0o755)
	_ = os.WriteFile(filepath.Join(mac.home, "Library", "LaunchAgents", "org.cerea.connector.plist"), nil, 0o644)
	if err := mac.dispatch([]string{"install"}); err == nil || !strings.Contains(err.Error(), "connector app") {
		t.Errorf("connector app: %v", err)
	}
	if err := env.dispatch([]string{"install", "stray"}); err == nil {
		t.Error("a stray argument must be refused")
	}
}
