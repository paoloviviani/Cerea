package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDetectRunMode(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*upgradeCapEnv) string // returns XPC_SERVICE_NAME
		want   string
	}{
		{"systemd unit", func(*upgradeCapEnv) string { return "" }, runModeService},
		{"docker wins", func(e *upgradeCapEnv) string { e.container = func() bool { return true }; return "" }, runModeDocker},
		{"terminal (not the unit's cgroup)", func(e *upgradeCapEnv) string {
			_ = os.WriteFile(e.cgroupFile, []byte("0::/user.slice/session-3.scope\n"), 0o600)
			return ""
		}, runModeTerminal},
		{"mac connector app runs it", func(e *upgradeCapEnv) string { e.goos = "darwin"; return "application.org.cerea.connector.123" }, runModeMacApp},
		{"mac app installed but galopin run by hand", func(e *upgradeCapEnv) string {
			e.goos = "darwin"
			dir := filepath.Join(e.home, "Library", "LaunchAgents")
			_ = os.MkdirAll(dir, 0o755)
			_ = os.WriteFile(filepath.Join(dir, "org.cerea.connector.plist"), nil, 0o600)
			return ""
		}, runModeTerminal},
		{"systemd system unit", func(e *upgradeCapEnv) string {
			_ = os.WriteFile(e.cgroupFile, []byte("0::/system.slice/galopin.service\n"), 0o600)
			return ""
		}, runModeSystem},
		{"mac LaunchAgent", func(e *upgradeCapEnv) string { e.goos = "darwin"; return launchdLabel }, runModeService},
		{"mac by hand", func(e *upgradeCapEnv) string { e.goos = "darwin"; return "" }, runModeTerminal},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			env := capEnv(t)
			xpc := c.mutate(&env)
			if got := detectRunMode(env, xpc); got != c.want {
				t.Errorf("got %s, want %s", got, c.want)
			}
		})
	}
}

func statusOut(t *testing.T, env *serviceEnv, running bool) string {
	t.Helper()
	var out bytes.Buffer
	(&statusEnv{svc: env, runHere: func() bool { return running }, systemUnit: func() bool { return false }, out: &out}).print()
	return out.String()
}

func TestStatusSaysHowGalopinIsKeptRunning(t *testing.T) {
	if inContainer() {
		t.Skip("runs in a container")
	}
	fakeCtl(t, "yes")
	env, _ := testServiceEnv(t, "linux")
	if got := statusOut(t, env, false); !strings.Contains(got, "not running") || !strings.Contains(got, "optional") {
		t.Errorf("none:\n%s", got)
	}
	if got := statusOut(t, env, true); !strings.Contains(got, "Run mode: terminal") || !strings.Contains(got, "Ctrl-C") {
		t.Errorf("terminal:\n%s", got)
	}
	if err := env.dispatch([]string{"install"}); err != nil {
		t.Fatal(err)
	}
	got := statusOut(t, env, true)
	for _, want := range []string{"Run mode: service", "systemctl --user stop galopin", "galopin service uninstall"} {
		if !strings.Contains(got, want) {
			t.Errorf("service lacks %q:\n%s", want, got)
		}
	}
	// installed but stopped
	_, _ = env.ctl("systemctl", "--user", "disable", "--now", unitName)
	if got := statusOut(t, env, false); !strings.Contains(got, "installed but not running") {
		t.Errorf("stopped:\n%s", got)
	}
	// unit inactive while a galopin run is up: that is a terminal
	if got := statusOut(t, env, true); !strings.Contains(got, "Run mode: terminal") || !strings.Contains(got, "not running") {
		t.Errorf("inactive unit, run up:\n%s", got)
	}
}

func TestStatusMacApp(t *testing.T) {
	env, _ := testServiceEnv(t, "darwin")
	dir := filepath.Join(env.home, "Library", "LaunchAgents")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "org.cerea.connector.plist"), nil, 0o600)
	if got := statusOut(t, env, false); !strings.Contains(got, "mac_app") {
		t.Errorf("%s", got)
	}
}

// A galopin launch's proxy is not a terminal run: only the pairing lock that
// 'run' and 'serve' take counts, and 'launch' does not take it.
func TestStatusDoesNotCountALaunchProxyAsATerminalRun(t *testing.T) {
	if inContainer() {
		t.Skip("runs in a container")
	}
	fakeCtl(t, "yes")
	r := newLaunchRig(t, 0, "x")
	_, stop, err := func() (*shim, func(), error) {
		stop, sh, err := ensureProxyShim(r.creds_, r.creds, r.port, func(string, ...any) {})
		return sh, stop, err
	}()
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	unlock, err := lockInstance(r.creds) // nothing holds it: a launch's proxy is not a run
	if err != nil {
		t.Fatal(err)
	}
	unlock()
	env, _ := testServiceEnv(t, "linux")
	var out bytes.Buffer
	se := &statusEnv{svc: env, systemUnit: func() bool { return false }, out: &out}
	se.runHere = func() bool {
		u, err := lockInstance(r.creds)
		if err == nil {
			u()
			return false
		}
		return true
	}
	se.print()
	if strings.Contains(out.String(), "Run mode: terminal") {
		t.Errorf("a launch's proxy was reported as a terminal run:\n%s", out.String())
	}
}

func TestStatusReportsASystemUnit(t *testing.T) {
	if inContainer() {
		t.Skip("runs in a container")
	}
	fakeCtl(t, "yes")
	env, _ := testServiceEnv(t, "linux")
	var out bytes.Buffer
	(&statusEnv{svc: env, runHere: func() bool { return true }, systemUnit: func() bool { return true }, out: &out}).print()
	if !strings.Contains(out.String(), "system_service") {
		t.Errorf("%s", out.String())
	}
}
