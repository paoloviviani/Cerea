package main

// How galopin is kept running on this computer, and `galopin status`.
//
// hello.agent.runMode (PROTOCOL.md §5) tells Cerea, so the Agents panel can say
// it: "service" (the systemd user unit or launchd LaunchAgent `galopin service
// install` wrote), "terminal" (a `galopin run` somebody started), "mac_app" (the
// Cerea connector app on macOS) or "docker" (a container). It reuses the
// detection the remote-upgrade capability does (upgrade_inplace.go).

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

const (
	runModeService = "service"
	// runModeSystem is a systemd SYSTEM unit (galopin.service under system.slice):
	// stopped with root's systemctl, not the user's.
	runModeSystem   = "system_service"
	runModeTerminal = "terminal"
	runModeMacApp   = "mac_app"
	runModeDocker   = "docker"
)

// connectorAppLabel is the Cerea connector app's launchd label: launchd gives
// the processes the app starts XPC_SERVICE_NAME with it in it.
const connectorAppLabel = "org.cerea.connector"

// detectRunMode is hello.agent.runMode for THIS process. xpcService is the
// XPC_SERVICE_NAME launchd sets for a LaunchAgent's (or the app's) process:
// mac_app is only when galopin is actually run by the connector app, not merely
// when the app is installed on the Mac.
func detectRunMode(env upgradeCapEnv, xpcService string) string {
	switch {
	case env.container != nil && env.container():
		return runModeDocker
	case env.goos == "darwin" && strings.Contains(xpcService, connectorAppLabel):
		return runModeMacApp
	case env.goos == "darwin" && xpcService == launchdLabel:
		return runModeService
	case env.goos == "linux" && underGalopinUserUnit(env.cgroupFile):
		return runModeService
	case env.goos == "linux" && underGalopinSystemUnit(env.cgroupFile):
		return runModeSystem
	}
	return runModeTerminal
}

// underGalopinSystemUnit: the process is in a system-level galopin.service.
func underGalopinSystemUnit(cgroupFile string) bool {
	body, err := os.ReadFile(cgroupFile)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(body), "\n") {
		if strings.Contains(line, "/system.slice/") && strings.Contains(line, "/galopin.service") {
			return true
		}
	}
	return false
}

func currentRunMode() string {
	return detectRunMode(realUpgradeCapEnv(), os.Getenv("XPC_SERVICE_NAME"))
}

const statusUsage = `galopin status — how galopin is kept running on this computer.

Usage:
  galopin status [--creds PATH]

Says whether galopin runs as the service (systemd user unit on Linux, LaunchAgent
on macOS), in a terminal ('galopin run' left open), under the Cerea connector app
on macOS, or in a container, and how to stop or remove it. The Agents panel in
Cerea shows the same word for each paired computer.
`

// statusEnv is what 'galopin status' reaches outside itself.
type statusEnv struct {
	svc *serviceEnv
	// runHere: a 'galopin run' or 'serve' of this pairing is up right now (it
	// holds the one-galopin-per-pairing lock, which 'launch' and its proxy do not
	// take). A launch's proxy is therefore never mistaken for a terminal run.
	runHere func() bool
	// systemUnit: a systemd system unit galopin.service is active.
	systemUnit func() bool
	out        io.Writer
}

func runStatus(args []string) error {
	fs := flagSetWithHelp("status", statusUsage)
	credsFlag := fs.String("creds", "", "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %v", fs.Args())
	}
	svc, err := realServiceEnv()
	if err != nil {
		return err
	}
	credsPath := *credsFlag
	if credsPath == "" {
		if credsPath, err = resolveDefaultCredsPath(); err != nil {
			return err
		}
	}
	env := &statusEnv{svc: svc, out: os.Stdout}
	_, cerr := loadCredentials(credsPath)
	env.runHere = func() bool {
		if cerr != nil {
			return false
		}
		unlock, err := lockInstance(credsPath)
		if err == nil {
			unlock()
			return false
		}
		var busy *alreadyRunningError
		return errors.As(err, &busy)
	}
	env.systemUnit = func() bool {
		_, err := exec.LookPath("systemctl")
		return err == nil && exec.Command("systemctl", "is-active", "--quiet", unitName).Run() == nil
	}
	fmt.Fprintf(env.out, "galopin %s\n", agentVersion)
	switch {
	case errors.Is(cerr, os.ErrNotExist):
		fmt.Fprintln(env.out, "Enrolled:  no ('galopin enroll' first)")
	case cerr != nil:
		fmt.Fprintf(env.out, "Enrolled:  unreadable credentials (%v)\n", cerr)
	default:
		fmt.Fprintf(env.out, "Enrolled:  yes (%s)\n", credsPath)
	}
	env.print()
	return nil
}

func (e *statusEnv) say(format string, a ...any) { fmt.Fprintf(e.out, format+"\n", a...) }

// print says how galopin is kept running here and how to stop or remove that.
func (e *statusEnv) print() {
	s := e.svc
	switch {
	case s.goos == "linux" && inContainer():
		e.say("Run mode: docker (this is a container)")
		e.say("Stop it:  docker stop <container>; remove it: docker rm <container>")
		return
	case s.goos == "darwin" && connectorAppInstalled(s.home):
		e.say("Run mode: mac_app (the Cerea connector app keeps galopin running)")
		e.say("Stop it:  quit the app from the menu bar; remove it by deleting the app")
		return
	case s.goos != "linux" && s.goos != "darwin":
		e.say("Run mode: unsupported platform %s", s.goos)
		return
	}
	installed, active := e.serviceState()
	running := e.runHere != nil && e.runHere()
	switch {
	case installed && active:
		e.say("Run mode: service (galopin starts at login and restarts if it stops)")
		e.stopHints()
	case installed && running:
		// The service is not what is running: a galopin run left open is.
		e.say("Run mode: terminal ('galopin run' left open; the service is installed but not running)")
		e.say("Stop it:  Ctrl-C in that terminal. Remove the unused service with 'galopin service uninstall'.")
	case installed:
		e.say("Run mode: service installed but not running")
		e.say("Start it: %s", e.startCmd())
		e.stopHints()
	case s.goos == "linux" && e.systemUnit != nil && e.systemUnit():
		e.say("Run mode: system_service (a systemd system unit, galopin.service)")
		e.say("Stop it:  sudo systemctl stop galopin; remove it: sudo systemctl disable --now galopin and delete its unit file")
	case running:
		e.say("Run mode: terminal ('galopin run' or 'galopin serve' left open; not a service)")
		e.say("Stop it:  Ctrl-C in that terminal. It does not start again by itself.")
		e.say("Optional: 'galopin service install' keeps it running at login (and 'galopin service uninstall' removes that again).")
	default:
		e.say("Run mode: not running")
		e.say("Start it: 'galopin run' in a terminal, or 'galopin service install' to keep it running at login (optional).")
	}
}

func (e *statusEnv) serviceState() (installed, active bool) {
	s := e.svc
	if s.goos == "darwin" {
		if _, err := os.Stat(s.plistPath()); err != nil {
			return false, false
		}
		_, err := s.ctl("launchctl", "print", s.launchTarget())
		return true, err == nil
	}
	if _, err := os.Stat(s.unitPath()); err != nil {
		return false, false
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		return true, false
	}
	_, err := s.ctl("systemctl", "--user", "is-active", "--quiet", unitName)
	return true, err == nil
}

func (e *statusEnv) startCmd() string {
	if e.svc.goos == "darwin" {
		return "galopin service install (re-run it)"
	}
	return "systemctl --user start galopin"
}

func (e *statusEnv) stopHints() {
	if e.svc.goos == "darwin" {
		e.say("Stop it:  'galopin service uninstall' (stops it and removes the LaunchAgent)")
		return
	}
	e.say("Stop it:  systemctl --user stop galopin (until the next login)")
	e.say("Remove it: galopin service uninstall (stops it and deletes the unit; 'galopin run' still works by hand)")
}
