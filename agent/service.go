package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"galopin/packaging"
)

const serviceUsage = `galopin service — keep 'galopin run' going: start at login, restart if it stops.

Usage:
  galopin service install [-- RUN FLAGS...]
  galopin service uninstall
  galopin service status

install   Linux: writes the systemd user unit ~/.config/systemd/user/galopin.service,
          enables and starts it. macOS: writes the LaunchAgent
          ~/Library/LaunchAgents/org.cerea.galopin.plist and starts it. The service
          runs THIS galopin binary as 'galopin run'. Flags after -- are passed to
          'galopin run' (for example: install -- --backend acp --acp-command "my-agent acp"
          --machine-name laptop); without any, the service runs a plain 'galopin run',
          which uses what 'enroll' recorded. Running it again updates the service and
          restarts it.
uninstall Stops the service and removes its file.
status    Whether it is installed and running, and where its log is.

Not for containers (restart them with 'docker run -d --restart unless-stopped')
and not for the Cerea connector app on macOS, which already keeps galopin running.
There is no Windows build of galopin; use WSL.
`

const (
	unitName     = "galopin.service"
	launchdLabel = "org.cerea.galopin"
)

// serviceEnv is everything 'galopin service' reaches outside itself. systemctl, loginctl and
// launchctl are found on PATH, so a test puts fakes there.
type serviceEnv struct {
	goos string
	home string
	exe  string // the galopin binary the service runs
	uid  int
	user string
	out  io.Writer
}

func realServiceEnv() (*serviceEnv, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	name := os.Getenv("USER")
	if name == "" {
		if u, err := user.Current(); err == nil {
			name = u.Username
		}
	}
	return &serviceEnv{goos: runtime.GOOS, home: home, exe: exe, uid: os.Getuid(), user: name, out: os.Stdout}, nil
}

func runService(args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Fprint(os.Stderr, serviceUsage)
		if len(args) == 0 {
			return exitError{code: 2, err: fmt.Errorf("service: want install, uninstall or status")}
		}
		return nil
	}
	env, err := realServiceEnv()
	if err != nil {
		return err
	}
	return env.dispatch(args)
}

func (e *serviceEnv) dispatch(args []string) error {
	switch args[0] {
	case "install":
		runArgs := args[1:]
		if len(runArgs) > 0 && runArgs[0] == "--" {
			runArgs = runArgs[1:]
		}
		if len(runArgs) > 0 && !strings.HasPrefix(runArgs[0], "-") {
			return fmt.Errorf("service install: unexpected argument %q; flags for 'galopin run' go after --", runArgs[0])
		}
		return e.install(runArgs)
	case "uninstall":
		if len(args) > 1 {
			return fmt.Errorf("service uninstall: unexpected arguments: %v", args[1:])
		}
		return e.uninstall()
	case "status":
		if len(args) > 1 {
			return fmt.Errorf("service status: unexpected arguments: %v", args[1:])
		}
		return e.status()
	}
	return fmt.Errorf("service: unknown subcommand %q (want install, uninstall or status)", args[0])
}

// guard refuses the places a service does not belong.
func (e *serviceEnv) guard() error {
	switch e.goos {
	case "linux":
		if inContainer() {
			return fmt.Errorf("this is a container: no service here. Run it detached instead: docker run -d --restart unless-stopped … (see the Pair a computer dialog)")
		}
	case "darwin":
		if _, err := os.Stat(filepath.Join(e.home, "Library", "LaunchAgents", "org.cerea.connector.plist")); err == nil {
			return fmt.Errorf("the Cerea connector app is installed here and already keeps galopin running; nothing to install")
		}
	default:
		return fmt.Errorf("no service for %s: galopin is built for Linux and macOS only (on Windows, use WSL and run this there)", e.goos)
	}
	return nil
}

func (e *serviceEnv) say(format string, a ...any) { fmt.Fprintf(e.out, format+"\n", a...) }

// ctl runs a service manager command and returns its combined output.
func (e *serviceEnv) ctl(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func (e *serviceEnv) unitPath() string {
	return filepath.Join(e.home, ".config", "systemd", "user", unitName)
}
func (e *serviceEnv) plistPath() string {
	return filepath.Join(e.home, "Library", "LaunchAgents", launchdLabel+".plist")
}
func (e *serviceEnv) logPath() string { return filepath.Join(e.home, "Library", "Logs", "galopin.log") }
func (e *serviceEnv) launchTarget() string {
	return "gui/" + strconv.Itoa(e.uid) + "/" + launchdLabel
}

func (e *serviceEnv) install(runArgs []string) error {
	if err := e.guard(); err != nil {
		return err
	}
	if e.goos == "darwin" {
		return e.installLaunchd(runArgs)
	}
	return e.installSystemd(runArgs)
}

func (e *serviceEnv) installSystemd(runArgs []string) error {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return fmt.Errorf("systemctl not found: this computer has no systemd. Keep 'galopin run' going another way (tmux, or your init system)")
	}
	wasActive := false
	if _, err := e.ctl("systemctl", "--user", "is-active", "--quiet", unitName); err == nil {
		wasActive = true
	}
	path := e.unitPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := writeFileAtomic(path, []byte(renderSystemdUnit(packaging.SystemdUnit(), e.exe, runArgs)), 0o644); err != nil {
		return err
	}
	e.say("Wrote %s", path)
	if out, err := e.ctl("systemctl", "--user", "daemon-reload"); err != nil {
		hint := ""
		if strings.Contains(strings.ToLower(out), "failed to connect") {
			hint = " (over SSH, run: export XDG_RUNTIME_DIR=/run/user/$(id -u) and try again)"
		}
		return fmt.Errorf("systemctl --user daemon-reload: %v: %s%s", err, out, hint)
	}
	if out, err := e.ctl("systemctl", "--user", "enable", "--now", unitName); err != nil {
		return fmt.Errorf("systemctl --user enable --now galopin: %v: %s", err, out)
	}
	if wasActive {
		if out, err := e.ctl("systemctl", "--user", "restart", unitName); err != nil {
			return fmt.Errorf("systemctl --user restart galopin: %v: %s", err, out)
		}
		e.say("galopin was already running as a service: restarted it with the new settings.")
	} else {
		e.say("galopin now starts when you log in and restarts if it stops. Started it.")
	}
	e.say("If a 'galopin run' is still open in a terminal, stop it (Ctrl-C): two copies fight over the computer's link.")
	e.say("Log: journalctl --user -u galopin -f")
	e.lingerHint()
	return nil
}

// lingerHint says how to keep the service running with nobody logged in, when linger is off.
func (e *serviceEnv) lingerHint() {
	if e.lingerOn() {
		return
	}
	name := e.user
	if name == "" {
		name = "$USER"
	}
	e.say("")
	e.say("It stops when you log out and starts again at your next login. To keep it running with nobody logged in (a server), run once (may need sudo):")
	e.say("  loginctl enable-linger %s", name)
}

func (e *serviceEnv) lingerOn() bool {
	if _, err := exec.LookPath("loginctl"); err != nil {
		return false
	}
	name := e.user
	if name == "" {
		name = os.Getenv("USER")
	}
	out, err := e.ctl("loginctl", "show-user", name, "-p", "Linger")
	return err == nil && strings.TrimSpace(out) == "Linger=yes"
}

func (e *serviceEnv) installLaunchd(runArgs []string) error {
	if _, err := exec.LookPath("launchctl"); err != nil {
		return fmt.Errorf("launchctl not found")
	}
	path := e.plistPath()
	for _, d := range []string{filepath.Dir(path), filepath.Dir(e.logPath())} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	if err := writeFileAtomic(path, []byte(renderLaunchdPlist(packaging.LaunchdPlist(), e.home, e.exe, e.logPath(), runArgs)), 0o644); err != nil {
		return err
	}
	e.say("Wrote %s", path)
	// A re-install replaces what is loaded: unload first (nothing loaded is fine).
	_, _ = e.ctl("launchctl", "bootout", e.launchTarget())
	domain := "gui/" + strconv.Itoa(e.uid)
	if out, err := e.ctl("launchctl", "bootstrap", domain, path); err != nil {
		// Older macOS has no bootstrap.
		if out2, err2 := e.ctl("launchctl", "load", "-w", path); err2 != nil {
			return fmt.Errorf("launchctl bootstrap: %v: %s (load -w: %v: %s)", err, out, err2, out2)
		}
	}
	_, _ = e.ctl("launchctl", "kickstart", "-k", e.launchTarget())
	e.say("galopin now starts when you log in and restarts if it stops. Started it.")
	e.say("If a 'galopin run' is still open in a terminal, stop it (Ctrl-C): two copies fight over the computer's link.")
	e.say("Log: tail -f %s", e.logPath())
	return nil
}

func (e *serviceEnv) uninstall() error {
	if err := e.guard(); err != nil {
		return err
	}
	if e.goos == "darwin" {
		if _, err := e.ctl("launchctl", "bootout", e.launchTarget()); err != nil {
			_, _ = e.ctl("launchctl", "unload", "-w", e.plistPath())
		}
		return e.removeFile(e.plistPath())
	}
	if _, err := exec.LookPath("systemctl"); err == nil {
		_, _ = e.ctl("systemctl", "--user", "disable", "--now", unitName)
	}
	if err := e.removeFile(e.unitPath()); err != nil {
		return err
	}
	if _, err := exec.LookPath("systemctl"); err == nil {
		_, _ = e.ctl("systemctl", "--user", "daemon-reload")
	}
	return nil
}

func (e *serviceEnv) removeFile(path string) error {
	err := os.Remove(path)
	switch {
	case err == nil:
		e.say("Stopped the service and removed %s. galopin no longer starts by itself; 'galopin run' still works by hand.", path)
	case os.IsNotExist(err):
		e.say("The service was not installed (no %s).", path)
	default:
		return err
	}
	return nil
}

func (e *serviceEnv) status() error {
	if err := e.guard(); err != nil {
		return err
	}
	if e.goos == "darwin" {
		_, statErr := os.Stat(e.plistPath())
		e.say("Installed: %s", yesNo(statErr == nil))
		out, err := e.ctl("launchctl", "print", e.launchTarget())
		e.say("Loaded:    %s", yesNo(err == nil))
		for _, line := range strings.Split(out, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "pid = ") || strings.HasPrefix(line, "state = ") {
				e.say("%s", line)
			}
		}
		e.say("Log:       %s", e.logPath())
		return nil
	}
	_, statErr := os.Stat(e.unitPath())
	e.say("Installed: %s", yesNo(statErr == nil))
	if statErr != nil {
		e.say("Install it with: galopin service install")
		return nil
	}
	_, errActive := e.ctl("systemctl", "--user", "is-active", "--quiet", unitName)
	_, errEnabled := e.ctl("systemctl", "--user", "is-enabled", "--quiet", unitName)
	e.say("Running:   %s", yesNo(errActive == nil))
	e.say("Starts at login: %s", yesNo(errEnabled == nil))
	e.say("Keeps running after logout (linger): %s", yesNo(e.lingerOn()))
	e.say("Unit:      %s", e.unitPath())
	e.say("Log:       journalctl --user -u galopin -f")
	if !e.lingerOn() {
		e.lingerHint()
	}
	return nil
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// systemdWord quotes one word of an ExecStart line: systemd splits on spaces, reads
// double quotes and backslashes, and expands % and $.
func systemdWord(s string) string {
	s = strings.NewReplacer("%", "%%", "$", "$$").Replace(s)
	if s != "" && !strings.ContainsAny(s, " \t\"'\\;") {
		return s
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

// renderSystemdUnit turns the packaged unit into one that runs exe with `run` and runArgs.
func renderSystemdUnit(tmpl, exe string, runArgs []string) string {
	words := []string{systemdWord(exe), "run"}
	for _, a := range runArgs {
		words = append(words, systemdWord(a))
	}
	exeDir := filepath.Dir(exe)
	var out []string
	out = append(out, "# Written by 'galopin service install'; 'galopin service uninstall' removes it.")
	for _, line := range strings.Split(tmpl, "\n") {
		switch {
		case strings.HasPrefix(line, "#") && len(out) == 1:
			continue // the template's manual-install header
		case strings.HasPrefix(line, "ExecStart="):
			line = "ExecStart=" + strings.Join(words, " ")
		case strings.HasPrefix(line, "Environment=PATH="):
			path := strings.TrimPrefix(line, "Environment=PATH=")
			if !containsPathEntry(path, exeDir) {
				path = strings.NewReplacer("%", "%%").Replace(exeDir) + ":" + path
			}
			line = "Environment=PATH=" + path
			if strings.ContainsAny(path, " \t") {
				line = `Environment="PATH=` + path + `"`
			}
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

func containsPathEntry(path, dir string) bool {
	for _, p := range strings.Split(path, ":") {
		if p == dir {
			return true
		}
	}
	return false
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

// renderLaunchdPlist turns the packaged plist into one for this user: the binary, its flags, the
// PATH and the log under ~/Library/Logs.
func renderLaunchdPlist(tmpl, home, exe, logPath string, runArgs []string) string {
	// The packaged header comment is manual-install advice; the generated file has its own.
	if i := strings.Index(tmpl, "<plist"); i >= 0 {
		if c := strings.Index(tmpl, "<!--"); c >= 0 && c < i {
			if end := strings.Index(tmpl, "-->"); end >= 0 && end < i {
				tmpl = tmpl[:c] + "<!-- Written by 'galopin service install'; 'galopin service uninstall' removes it. -->\n" + strings.TrimLeft(tmpl[end+3:], "\n")
			}
		}
	}
	prog := "    <string>/Users/USER/.local/bin/galopin</string>\n    <string>run</string>\n"
	var args strings.Builder
	args.WriteString("    <string>" + xmlEscape(exe) + "</string>\n    <string>run</string>\n")
	for _, a := range runArgs {
		args.WriteString("    <string>" + xmlEscape(a) + "</string>\n")
	}
	tmpl = strings.Replace(tmpl, prog, args.String(), 1)
	tmpl = strings.Replace(tmpl, "/Users/USER/Library/Logs/galopin.log", xmlEscape(logPath), -1)
	exeDir := filepath.Dir(exe)
	if !strings.Contains(tmpl, "<string>"+xmlEscape(exeDir)+":") && exeDir != home+"/.local/bin" {
		tmpl = strings.Replace(tmpl, "<key>PATH</key><string>", "<key>PATH</key><string>"+xmlEscape(exeDir)+":", 1)
	}
	return strings.Replace(tmpl, "/Users/USER", xmlEscape(home), -1)
}
