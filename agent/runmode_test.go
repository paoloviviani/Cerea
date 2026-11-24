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
		{"mac connector app", func(e *upgradeCapEnv) string {
			e.goos = "darwin"
			dir := filepath.Join(e.home, "Library", "LaunchAgents")
			_ = os.MkdirAll(dir, 0o755)
			_ = os.WriteFile(filepath.Join(dir, "org.cerea.connector.plist"), nil, 0o600)
			return ""
		}, runModeMacApp},
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

func statusOut(t *testing.T, env *serviceEnv, proxy bool) string {
	t.Helper()
	var out bytes.Buffer
	(&statusEnv{svc: env, proxyOurs: func() bool { return proxy }, out: &out}).print()
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
