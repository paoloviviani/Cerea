package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"galopin/internal/link"
	"galopin/internal/policy"
)

// In-place upgrade (PROTOCOL.md §6 machine.upgrade): Cerea's Upgrade button asks galopin to
// run the same path as `galopin upgrade --yes`. That path only survives galopin's own restart
// when the installer can detach through `systemd-run --user` (galopinUpgrade.sh,
// upgrade_detach), so galopin reports hello.agent.upgrade.inPlace true only where that holds.

const (
	upgradeSystemd    = "systemd"
	upgradeMacApp     = "mac_app"
	upgradeDocker     = "docker"
	upgradeForeground = "foreground"
	upgradeDisabled   = "disabled"
)

// upgradeCapEnv is everything the capability check reads outside the policy.
type upgradeCapEnv struct {
	goos       string
	home       string
	container  func() bool
	cgroupFile string
	lookPath   func(string) (string, error)
}

func realUpgradeCapEnv() upgradeCapEnv {
	home, _ := os.UserHomeDir()
	return upgradeCapEnv{
		goos: runtime.GOOS, home: home, container: inContainer,
		cgroupFile: "/proc/self/cgroup", lookPath: exec.LookPath,
	}
}

// upgradeCapability is hello.agent.upgrade for this process.
func upgradeCapability(pol policy.Policy) *link.UpgradeInfo {
	info := detectUpgrade(realUpgradeCapEnv(), pol)
	return &info
}

// detectUpgrade decides, in this order: a container (the image is pulled instead), the Cerea
// connector app on macOS (its own installer), the owner's opt-out, not running under the
// galopin systemd user unit (the installer's own "inside galopin" test: the unit's cgroup), no
// systemd-run (the installer cannot detach), else in place.
func detectUpgrade(env upgradeCapEnv, pol policy.Policy) link.UpgradeInfo {
	switch {
	case env.container != nil && env.container():
		return link.UpgradeInfo{Reason: upgradeDocker}
	case env.goos == "darwin" && connectorAppInstalled(env.home):
		return link.UpgradeInfo{Reason: upgradeMacApp}
	case !pol.RemoteUpgradeAllowed():
		return link.UpgradeInfo{Reason: upgradeDisabled}
	case env.goos != "linux" || !underGalopinUnit(env.cgroupFile):
		return link.UpgradeInfo{Reason: upgradeForeground}
	}
	if _, err := env.lookPath("systemd-run"); err != nil {
		return link.UpgradeInfo{Reason: upgradeForeground}
	}
	return link.UpgradeInfo{InPlace: true, Reason: upgradeSystemd}
}

// underGalopinUnit: this process is in the galopin.service cgroup (the same test as the
// installer's upgrade_inside_galopin).
func underGalopinUnit(cgroupFile string) bool {
	body, err := os.ReadFile(cgroupFile)
	return err == nil && strings.Contains(string(body), "/galopin.service")
}

// selfUpgrade is machine.upgradeSelf: `galopin upgrade --yes` in this process. The installer
// detaches (systemd-run) and returns once it has; whatever fails before that comes back here.
func selfUpgrade(credsPath string) func(ctx context.Context) error {
	return func(ctx context.Context) error {
		creds, err := loadCredentials(credsPath)
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
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
		info = detectUpgrade(realUpgradeCapEnv(), mc.pol)
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
	case upgradeDisabled:
		return "turned off with --no-remote-upgrade"
	default:
		return "it was not started by its systemd user unit, or systemd-run is missing"
	}
}
