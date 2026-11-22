package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/internal/link"
	"galopin/internal/policy"
)

// capEnv is a Linux computer under the galopin systemd user unit with systemd-run, no container.
func capEnv(t *testing.T) upgradeCapEnv {
	t.Helper()
	cg := filepath.Join(t.TempDir(), "cgroup")
	if err := os.WriteFile(cg, []byte("0::/user.slice/user-1000.slice/user@1000.service/app.slice/galopin.service\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return upgradeCapEnv{
		goos: "linux", home: t.TempDir(), container: func() bool { return false }, cgroupFile: cg,
		lookPath: func(string) (string, error) { return "/usr/bin/systemd-run", nil },
	}
}

func TestDetectUpgradePerCase(t *testing.T) {
	pol := policy.Default()
	cases := []struct {
		name   string
		mutate func(*upgradeCapEnv, *policy.Policy)
		want   link.UpgradeInfo
	}{
		{"systemd unit with systemd-run", func(*upgradeCapEnv, *policy.Policy) {}, link.UpgradeInfo{InPlace: true, Reason: "systemd"}},
		{"docker", func(e *upgradeCapEnv, _ *policy.Policy) { e.container = func() bool { return true } }, link.UpgradeInfo{Reason: "docker"}},
		{"docker wins over the opt-out", func(e *upgradeCapEnv, p *policy.Policy) {
			e.container = func() bool { return true }
			p.RemoteUpgrade = policy.TerminalDenied
		}, link.UpgradeInfo{Reason: "docker"}},
		{"mac connector app", func(e *upgradeCapEnv, _ *policy.Policy) {
			e.goos = "darwin"
			dir := filepath.Join(e.home, "Library", "LaunchAgents")
			_ = os.MkdirAll(dir, 0o755)
			_ = os.WriteFile(filepath.Join(dir, "org.cerea.connector.plist"), nil, 0o600)
		}, link.UpgradeInfo{Reason: "mac_app"}},
		{"mac without the app", func(e *upgradeCapEnv, _ *policy.Policy) { e.goos = "darwin" }, link.UpgradeInfo{Reason: "foreground"}},
		{"opted out", func(_ *upgradeCapEnv, p *policy.Policy) { p.RemoteUpgrade = policy.TerminalDenied }, link.UpgradeInfo{Reason: "disabled"}},
		{"foreground run (not the unit's cgroup)", func(e *upgradeCapEnv, _ *policy.Policy) {
			_ = os.WriteFile(e.cgroupFile, []byte("0::/user.slice/user-1000.slice/session-3.scope\n"), 0o600)
		}, link.UpgradeInfo{Reason: "foreground"}},
		{"no cgroup file", func(e *upgradeCapEnv, _ *policy.Policy) { e.cgroupFile = "/nonexistent" }, link.UpgradeInfo{Reason: "foreground"}},
		{"no systemd-run", func(e *upgradeCapEnv, _ *policy.Policy) {
			e.lookPath = func(string) (string, error) { return "", errors.New("not found") }
		}, link.UpgradeInfo{Reason: "foreground"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			env, p := capEnv(t), pol
			c.mutate(&env, &p)
			if got := detectUpgrade(env, p); got != c.want {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
		})
	}
}

func TestRemoteUpgradeOptOutPolicy(t *testing.T) {
	if !(policy.Policy{}).RemoteUpgradeAllowed() {
		t.Fatal("absent must read allowed")
	}
	if (policy.Policy{RemoteUpgrade: policy.TerminalDenied}).RemoteUpgradeAllowed() {
		t.Fatal("denied must read denied")
	}
	// enroll: a fresh enroll allows it; --no-remote-upgrade turns it off; a re-enroll that
	// does not name it keeps it off; --allow-remote-upgrade turns it back on.
	fresh, err := enrollPolicy(&enrollOptions{set: map[string]bool{}})
	if err != nil || !fresh.RemoteUpgradeAllowed() {
		t.Fatalf("fresh: %v %+v", err, fresh.RemoteUpgrade)
	}
	off, err := enrollPolicy(&enrollOptions{set: map[string]bool{"no-remote-upgrade": true}, noRemoteUpgrade: true})
	if err != nil || off.RemoteUpgradeAllowed() {
		t.Fatalf("off: %v %+v", err, off.RemoteUpgrade)
	}
	kept, err := enrollPolicy(&enrollOptions{set: map[string]bool{}, base: &off})
	if err != nil || kept.RemoteUpgradeAllowed() {
		t.Fatalf("kept: %v %+v", err, kept.RemoteUpgrade)
	}
	on, err := enrollPolicy(&enrollOptions{set: map[string]bool{"allow-remote-upgrade": true}, base: &off, allowRemoteUpgrade: true})
	if err != nil || !on.RemoteUpgradeAllowed() {
		t.Fatalf("on: %v %+v", err, on.RemoteUpgrade)
	}
}

func TestHelloReportsUpgradeCapability(t *testing.T) {
	body, err := json.Marshal(buildHello(newE2EFakeBackend(), policy.Default()))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"upgrade":{"inPlace":`) {
		t.Fatalf("hello lacks agent.upgrade: %s", body)
	}
	var h link.Hello
	pol := policy.Default()
	pol.RemoteUpgrade = policy.TerminalDenied
	body, _ = json.Marshal(buildHello(newE2EFakeBackend(), pol))
	if err := json.Unmarshal(body, &h); err != nil {
		t.Fatal(err)
	}
	if h.Agent.Upgrade == nil || h.Agent.Upgrade.InPlace || (h.Agent.Upgrade.Reason != "disabled" && h.Agent.Upgrade.Reason != "docker" && h.Agent.Upgrade.Reason != "mac_app") {
		t.Fatalf("opted-out hello: %+v", h.Agent.Upgrade)
	}
}

func upgradeMachine(t *testing.T, info link.UpgradeInfo, run func(context.Context) error) *machine {
	mc := newTestMachine(t, newE2EFakeBackend())
	mc.upgradeCaps = func() link.UpgradeInfo { return info }
	mc.upgradeSelf = run
	return mc
}

func TestMachineUpgradeStartsWhenInPlace(t *testing.T) {
	calls := 0
	mc := upgradeMachine(t, link.UpgradeInfo{InPlace: true, Reason: "systemd"}, func(context.Context) error { calls++; return nil })
	res, oerr := mc.Handle(context.Background(), "machine.upgrade", json.RawMessage(`{}`))
	if oerr != nil {
		t.Fatal(oerr)
	}
	if b, _ := json.Marshal(res); string(b) != `{"started":true}` || calls != 1 {
		t.Fatalf("res %s, calls %d", b, calls)
	}
}

func TestMachineUpgradeRefusedWhenNotInPlace(t *testing.T) {
	for _, reason := range []string{"docker", "mac_app", "foreground", "disabled"} {
		calls := 0
		mc := upgradeMachine(t, link.UpgradeInfo{Reason: reason}, func(context.Context) error { calls++; return nil })
		_, oerr := mc.Handle(context.Background(), "machine.upgrade", json.RawMessage(`{}`))
		if oerr == nil || oerr.Code != "forbidden" || calls != 0 {
			t.Fatalf("%s: err %+v, calls %d", reason, oerr, calls)
		}
	}
}

func TestMachineUpgradeReturnsErrorsBeforeDetaching(t *testing.T) {
	mc := upgradeMachine(t, link.UpgradeInfo{InPlace: true, Reason: "systemd"}, func(context.Context) error { return errors.New("installer unreachable") })
	_, oerr := mc.Handle(context.Background(), "machine.upgrade", nil)
	if oerr == nil || oerr.Code != "unavailable" || !strings.Contains(oerr.Message, "installer unreachable") {
		t.Fatalf("%+v", oerr)
	}
	_, oerr = mc.Handle(context.Background(), "machine.upgrade", json.RawMessage(`{"yes":true}`))
	if oerr == nil || oerr.Code != "invalid" {
		t.Fatalf("arguments must be refused: %+v", oerr)
	}
}

func TestMachineUpgradeWorksOnAConnectorsOnlyMachine(t *testing.T) {
	mc := &machine{pol: policy.Default()}
	mc.upgradeCaps = func() link.UpgradeInfo { return link.UpgradeInfo{InPlace: true, Reason: "systemd"} }
	mc.upgradeSelf = func(context.Context) error { return nil }
	if _, oerr := mc.Handle(context.Background(), "machine.upgrade", nil); oerr != nil {
		t.Fatal(oerr)
	}
}

func TestPolicySetNoRemoteUpgrade(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	if err := os.WriteFile(path, []byte(`{"autoAccept":"denied"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--no-remote-upgrade"}); err != nil {
		t.Fatal(err)
	}
	got, err := policy.Load(path)
	if err != nil || got.RemoteUpgradeAllowed() {
		t.Fatalf("remote upgrade should be denied: %+v %v", got.RemoteUpgrade, err)
	}
}
