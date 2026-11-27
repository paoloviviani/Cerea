package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"galopin/internal/link"
	"galopin/internal/policy"
)

// osExecutable is os.Executable; a test replaces it to point at a marker's directory.
var osExecutable = os.Executable

// In-place upgrade (PROTOCOL.md §6 machine.upgrade): Cerea's Upgrade button asks galopin to
// run the same path as `galopin upgrade --yes`. That path only survives galopin's own restart
// when the installer can detach through `systemd-run --user` (galopinUpgrade.sh,
// upgrade_detach), so galopin reports hello.agent.upgrade.inPlace true only where that holds.

const (
	upgradeSystemd    = "systemd"
	upgradeMacApp     = "mac_app"
	upgradeDocker     = "docker"
	upgradeLaunchd    = "launchd"
	upgradeForeground = "foreground"
	upgradeDisabled   = "disabled"
	// upgradeDesktopApp: the Cerea desktop app runs this galopin and ships it; a new app build is
	// its upgrade, and the installer would put a second galopin beside it.
	upgradeDesktopApp = "desktop_app"
)

// desktopAppEnv is set to "1" by the Cerea desktop app on every galopin it runs.
const desktopAppEnv = "CEREA_DESKTOP_APP"

// desktopAppMarker is the file the Cerea desktop app writes next to the galopin it ships (beside the
// stable copy). A galopin the app runs carries the env var, but a galopin the app installed as a
// service -- which the app did not start -- has no env var; the marker is how it is known.
const desktopAppMarker = ".cerea-desktop-app"

// desktopAppNextTo: is the marker file beside exe (the symlink chain resolved)?
func desktopAppNextTo(exe string) bool {
	if exe == "" {
		return false
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	_, err := os.Stat(filepath.Join(filepath.Dir(exe), desktopAppMarker))
	return err == nil
}

// desktopAppDetect: the env var the app sets, OR the marker file beside the executable.
func desktopAppDetect(envVar, exe string) bool {
	if envVar == "1" {
		return true
	}
	return desktopAppNextTo(exe)
}

// upgradeCapEnv is everything the capability check reads outside the policy.
type upgradeCapEnv struct {
	goos       string
	home       string
	container  func() bool
	cgroupFile string
	lookPath   func(string) (string, error)
	// userUnitActive: `systemctl --user is-active --quiet galopin.service`, the installer's own
	// test (unit_active) for whether the user unit runs galopin.
	userUnitActive func() bool
	// desktopApp: the Cerea desktop app runs this galopin (the env var is "1", or the marker
	// file sits beside the executable).
	desktopApp bool
}

func realUpgradeCapEnv() upgradeCapEnv {
	home, _ := os.UserHomeDir()
	exe, err := osExecutable()
	if err != nil {
		exe = ""
	}
	return upgradeCapEnv{
		goos: runtime.GOOS, home: home, container: inContainer,
		cgroupFile: "/proc/self/cgroup", lookPath: exec.LookPath,
		desktopApp: desktopAppDetect(os.Getenv(desktopAppEnv), exe),
		userUnitActive: func() bool {
			return exec.Command("systemctl", "--user", "is-active", "--quiet", "galopin.service").Run() == nil
		},
	}
}

// upgradeCapability is hello.agent.upgrade for this process.
func upgradeCapability(pol policy.Policy) *link.UpgradeInfo {
	info := detectUpgrade(realUpgradeCapEnv(), pol)
	return &info
}

// detectUpgrade decides, in this order: a container (the image is pulled instead), the Cerea
// desktop app (a new app build carries its galopin), the Cerea connector app on macOS (its own installer), the owner's opt-out, not running under the
// galopin systemd user unit (the installer's own "inside galopin" test: the unit's cgroup), no
// systemd-run (the installer cannot detach), else in place.
func detectUpgrade(env upgradeCapEnv, pol policy.Policy) link.UpgradeInfo {
	switch {
	case env.container != nil && env.container():
		return link.UpgradeInfo{Reason: upgradeDocker}
	case env.desktopApp:
		return link.UpgradeInfo{Reason: upgradeDesktopApp}
	case env.goos == "darwin" && connectorAppInstalled(env.home):
		return link.UpgradeInfo{Reason: upgradeMacApp}
	case env.goos == "darwin" && launchdServiceInstalled(env.home):
		return link.UpgradeInfo{Reason: upgradeLaunchd}
	case !pol.RemoteUpgradeAllowed():
		return link.UpgradeInfo{Reason: upgradeDisabled}
	case env.goos != "linux" || !underGalopinUserUnit(env.cgroupFile):
		return link.UpgradeInfo{Reason: upgradeForeground}
	case env.userUnitActive == nil || !env.userUnitActive():
		return link.UpgradeInfo{Reason: upgradeForeground}
	}
	if _, err := env.lookPath("systemd-run"); err != nil {
		return link.UpgradeInfo{Reason: upgradeForeground}
	}
	return link.UpgradeInfo{InPlace: true, Reason: upgradeSystemd}
}

// underGalopinUserUnit: this process is in the galopin.service cgroup of a *user* manager
// (".../user@UID.service/.../galopin.service", cgroup v2 and v1 alike). A system unit
// (".../system.slice/galopin.service") matches the installer's "inside galopin" test but is not
// the user unit it can stop and detach from, so it is not in place.
func underGalopinUserUnit(cgroupFile string) bool {
	body, err := os.ReadFile(cgroupFile)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(body), "\n") {
		if strings.Contains(line, "/user@") && strings.Contains(line, "/galopin.service") {
			return true
		}
	}
	return false
}

// launchdServiceInstalled: `galopin service install` wrote org.cerea.galopin's LaunchAgent (the
// connector app's own plist is tested first).
func launchdServiceInstalled(home string) bool {
	_, err := os.Stat(filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist"))
	return err == nil
}

// effectiveUpgradePolicy is pol with remoteUpgrade denied when policy.json now says so too: a
// deny-only merge, so `galopin policy set --no-remote-upgrade` (or a tightened terminal and
// shell) takes effect without a restart, and nothing the file says can turn it back on.
func effectiveUpgradePolicy(pol policy.Policy, path string) policy.Policy {
	if path == "" {
		return pol
	}
	if _, sticky := upgradeDenySeen.Load(path); sticky {
		pol.RemoteUpgrade = policy.TerminalDenied
		return pol
	}
	if _, statErr := os.Stat(path); statErr == nil {
		if file, err := policy.Load(path); err == nil && !file.RemoteUpgradeAllowed() {
			// Sticky for the process lifetime, like policy.Live for permissions: a later hand
			// edit or a half-written file does not lift it until galopin restarts.
			upgradeDenySeen.Store(path, true)
			pol.RemoteUpgrade = policy.TerminalDenied
		}
	}
	return pol
}

// upgradeDenySeen holds the policy files (by path) that have said remote upgrade is denied.
var upgradeDenySeen sync.Map

// watchRemoteUpgrade calls onDenied once when policy.json starts denying remote upgrade while
// galopin runs (run reconnects the link so Cerea's hello says so).
func watchRemoteUpgrade(ctx context.Context, path string, pol policy.Policy, every time.Duration, onDenied func()) {
	if !effectiveUpgradePolicy(pol, path).RemoteUpgradeAllowed() {
		return
	}
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		if !effectiveUpgradePolicy(pol, path).RemoteUpgradeAllowed() {
			onDenied()
			return
		}
	}
}

// selfUpgrade is machine.upgradeSelf: `galopin upgrade --yes` in this process. The installer
// detaches (systemd-run) and returns once it has; whatever fails before that comes back here.
func selfUpgrade(credsPath string) func(ctx context.Context) error {
	return func(ctx context.Context) error {
		creds, err := loadCredentials(credsPath)
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(ctx, 55*time.Second)
		defer cancel()
		return upgradeFrom(ctx, realUpgradeEnv(), creds.CereaOrigin, true, false, false, credsPath)
	}
}

// opMachineUpgrade answers machine.upgrade {}: refuses unless this galopin reported inPlace
// true, then starts the upgrade and answers {started:true}. The request reaches galopin only
// over its own authenticated link to the owner's Cerea, which forwards it for the computer's
// owner alone (like profiles.set); there is no other principal to check here.
func (mc *machine) opMachineUpgrade(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	if len(args) > 0 && string(args) != "null" && string(args) != "{}" {
		return nil, opErrf("invalid", "machine.upgrade takes no arguments")
	}
	var info link.UpgradeInfo
	if mc.upgradeCaps != nil {
		info = mc.upgradeCaps()
	} else {
		info = detectUpgrade(realUpgradeCapEnv(), effectiveUpgradePolicy(mc.pol, mc.policyPath))
	}
	if !info.InPlace {
		if mc.audit != nil {
			mc.audit.upgrade("refused: " + info.Reason)
		}
		return nil, opErrf("forbidden", "this galopin cannot upgrade itself here (%s)", upgradeReasonText(info.Reason))
	}
	if mc.upgradeSelf == nil {
		return nil, opErrf("unsupported", "this galopin has no upgrade source")
	}
	if err := mc.upgradeSelf(ctx); err != nil {
		if mc.audit != nil {
			mc.audit.upgrade("failed")
		}
		return nil, opErrf("unavailable", "could not start the upgrade: %v", err)
	}
	if mc.audit != nil {
		mc.audit.upgrade("started")
	}
	return map[string]any{"started": true}, nil
}

func upgradeReasonText(reason string) string {
	switch reason {
	case upgradeDocker:
		return "it runs in a container: pull the new image"
	case upgradeMacApp:
		return "the Cerea connector app upgrades it"
	case upgradeLaunchd:
		return "it runs under launchd: galopin service uninstall, upgrade, galopin service install"
	case upgradeDisabled:
		return "turned off with --no-remote-upgrade"
	default:
		return "it was not started by its systemd user unit, or systemd-run is missing"
	}
}
