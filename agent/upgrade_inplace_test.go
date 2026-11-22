package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
		lookPath:       func(string) (string, error) { return "/usr/bin/systemd-run", nil },
		userUnitActive: func() bool { return true },
	}
}

func TestDetectUpgradePerCase(t *testing.T) {
	pol := policy.Default()
	pol.Terminal = policy.TerminalAllowed
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
		{"cgroup v1 user unit", func(e *upgradeCapEnv, _ *policy.Policy) {
			_ = os.WriteFile(e.cgroupFile, []byte("12:cpu:/\n1:name=systemd:/user.slice/user-1000.slice/user@1000.service/galopin.service\n"), 0o600)
		}, link.UpgradeInfo{InPlace: true, Reason: "systemd"}},
		{"system unit (system.slice), not the user unit", func(e *upgradeCapEnv, _ *policy.Policy) {
			_ = os.WriteFile(e.cgroupFile, []byte("0::/system.slice/galopin.service\n"), 0o600)
		}, link.UpgradeInfo{Reason: "foreground"}},
		{"cgroup v1 system unit", func(e *upgradeCapEnv, _ *policy.Policy) {
			_ = os.WriteFile(e.cgroupFile, []byte("1:name=systemd:/system.slice/galopin.service\n"), 0o600)
		}, link.UpgradeInfo{Reason: "foreground"}},
		{"user unit not active", func(e *upgradeCapEnv, _ *policy.Policy) { e.userUnitActive = func() bool { return false } }, link.UpgradeInfo{Reason: "foreground"}},
		{"launchd service on a Mac", func(e *upgradeCapEnv, _ *policy.Policy) {
			e.goos = "darwin"
			dir := filepath.Join(e.home, "Library", "LaunchAgents")
			_ = os.MkdirAll(dir, 0o755)
			_ = os.WriteFile(filepath.Join(dir, "org.cerea.galopin.plist"), nil, 0o600)
		}, link.UpgradeInfo{Reason: "launchd"}},
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
	// Absent reads allowed, unless the terminal and the command shell are both denied.
	if !(policy.Policy{Terminal: policy.TerminalAllowed}).RemoteUpgradeAllowed() {
		t.Fatal("absent with a terminal must read allowed")
	}
	if !(policy.Policy{CommandShell: policy.TerminalAllowed}).RemoteUpgradeAllowed() {
		t.Fatal("absent with a command shell must read allowed")
	}
	if (policy.Policy{}).RemoteUpgradeAllowed() {
		t.Fatal("absent with neither terminal nor shell must read denied")
	}
	if !(policy.Policy{RemoteUpgrade: policy.TerminalAllowed}).RemoteUpgradeAllowed() {
		t.Fatal("an explicit allow overrides the default rule")
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
	// --allow-remote-upgrade=false must not turn it on.
	stays, err := enrollPolicy(&enrollOptions{set: map[string]bool{"allow-remote-upgrade": true}, base: &off, allowRemoteUpgrade: false})
	if err != nil || stays.RemoteUpgradeAllowed() {
		t.Fatalf("=false turned it on: %v %+v", err, stays.RemoteUpgrade)
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
}

// The opted-out reason comes from detection with its inputs forced: a Linux user unit.
func TestOptedOutReadsDisabledInTheHello(t *testing.T) {
	pol := policy.Default()
	pol.RemoteUpgrade = policy.TerminalDenied
	if got := detectUpgrade(capEnv(t), pol); got != (link.UpgradeInfo{Reason: "disabled"}) {
		t.Fatalf("%+v", got)
	}
}

func writePolicy(t *testing.T, dir, body string) string {
	t.Helper()
	path := filepath.Join(dir, policyFileName)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// A policy.json tightened while galopin runs takes effect at once, deny-only.
func TestRuntimePolicyChangeDeniesRemoteUpgrade(t *testing.T) {
	dir := t.TempDir()
	path := writePolicy(t, dir, `{"terminal":"allowed"}`)
	start := policy.Policy{Terminal: policy.TerminalAllowed}
	if !effectiveUpgradePolicy(start, path).RemoteUpgradeAllowed() {
		t.Fatal("allowed to begin with")
	}
	writePolicy(t, dir, `{"terminal":"allowed","remoteUpgrade":"denied"}`)
	if effectiveUpgradePolicy(start, path).RemoteUpgradeAllowed() {
		t.Fatal("the file now denies it")
	}
	// Tightening the terminal and shell away reads denied too.
	writePolicy(t, dir, `{"terminal":"denied","commandShell":"denied"}`)
	if effectiveUpgradePolicy(start, path).RemoteUpgradeAllowed() {
		t.Fatal("no terminal and no shell denies the default")
	}
	// A file that allows never loosens a startup that denied.
	writePolicy(t, dir, `{"remoteUpgrade":"allowed"}`)
	if effectiveUpgradePolicy(policy.Policy{RemoteUpgrade: policy.TerminalDenied}, path).RemoteUpgradeAllowed() {
		t.Fatal("the file must not loosen the startup policy")
	}
	// An unreadable file changes nothing.
	if !effectiveUpgradePolicy(start, filepath.Join(dir, "nope.json")).RemoteUpgradeAllowed() {
		t.Fatal("a missing file must not deny")
	}
}

func TestMachineUpgradeRefusesAfterPolicyTightenedAtRuntime(t *testing.T) {
	dir := t.TempDir()
	path := writePolicy(t, dir, `{"terminal":"allowed"}`)
	mc := newTestMachine(t, newE2EFakeBackend())
	mc.pol.Terminal = policy.TerminalAllowed
	mc.policyPath = path
	// detection against a unit-like environment, with the live policy handed through.
	env := capEnv(t)
	mc.upgradeCaps = func() link.UpgradeInfo {
		return detectUpgrade(env, effectiveUpgradePolicy(mc.pol, mc.policyPath))
	}
	calls := 0
	mc.upgradeSelf = func(context.Context) error { calls++; return nil }
	if _, oerr := mc.Handle(context.Background(), "machine.upgrade", nil); oerr != nil || calls != 1 {
		t.Fatalf("before: %+v %d", oerr, calls)
	}
	writePolicy(t, dir, `{"terminal":"allowed","remoteUpgrade":"denied"}`)
	_, oerr := mc.Handle(context.Background(), "machine.upgrade", nil)
	if oerr == nil || oerr.Code != "forbidden" || calls != 1 {
		t.Fatalf("after: %+v %d", oerr, calls)
	}
}

func TestWatchRemoteUpgradeReconnectsWhenDenied(t *testing.T) {
	dir := t.TempDir()
	path := writePolicy(t, dir, `{"terminal":"allowed"}`)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	denied := make(chan struct{}, 1)
	go watchRemoteUpgrade(ctx, path, policy.Policy{Terminal: policy.TerminalAllowed}, 10*time.Millisecond, func() { denied <- struct{}{} })
	select {
	case <-denied:
		t.Fatal("fired before any change")
	case <-time.After(60 * time.Millisecond):
	}
	writePolicy(t, dir, `{"terminal":"allowed","remoteUpgrade":"denied"}`)
	select {
	case <-denied:
	case <-time.After(2 * time.Second):
		t.Fatal("no reconnect after the policy tightened")
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

func TestSeenUpgradeDenyIsStickyUntilRestart(t *testing.T) {
	dir := t.TempDir()
	path := writePolicy(t, dir, `{"terminal":"allowed","remoteUpgrade":"denied"}`)
	start := policy.Policy{Terminal: policy.TerminalAllowed}
	if effectiveUpgradePolicy(start, path).RemoteUpgradeAllowed() {
		t.Fatal("denied in the file")
	}
	writePolicy(t, dir, `{"terminal":"allowed","remoteUpgrade":"allowed"}`)
	if effectiveUpgradePolicy(start, path).RemoteUpgradeAllowed() {
		t.Fatal("a later allow must not lift a seen deny")
	}
	writePolicy(t, dir, `{ not json`)
	if effectiveUpgradePolicy(start, path).RemoteUpgradeAllowed() {
		t.Fatal("an unparseable file must not lift a seen deny")
	}
	_ = os.Remove(path)
	if effectiveUpgradePolicy(start, path).RemoteUpgradeAllowed() {
		t.Fatal("a missing file must not lift a seen deny")
	}
}
