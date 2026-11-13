// Package trayapp is the logic of the "Cerea connector" menu-bar app that needs
// no GUI: what the menu says for a given state, how an address is cleaned up,
// which commands the menu items run, and how the sign-in output is read. The
// tray itself (cmd/galopin-tray) only draws this and runs the commands.
package trayapp

import (
	"errors"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"galopin/internal/appstatus"
)

// AppName is what users see.
const AppName = "Cerea connector"

// LaunchLabel is the LaunchAgent's label (the existing service name).
const LaunchLabel = "org.cerea.galopin"

// Link states shown on the status line.
type Link int

const (
	NotPaired Link = iota // no credentials: never enrolled
	Offline               // enrolled, but not running or not connected
	Connected
)

// Input is everything the menu depends on.
type Input struct {
	Now time.Time
	// HasCredentials: credentials.json exists in the state directory.
	HasCredentials bool
	// CredsCerea is the origin recorded at enroll (read from credentials.json).
	CredsCerea string
	// Status is the app-status.json content; StatusOK says it could be read.
	Status   appstatus.Status
	StatusOK bool
	// ServiceLoaded: launchd has the LaunchAgent loaded.
	ServiceLoaded bool
	// LoginItem: the LaunchAgent plist is installed (it starts at login).
	LoginItem bool
	// Busy is set while pairing or browser setup runs.
	Busy bool
}

// Menu is the menu's content for an Input.
type Menu struct {
	Link         Link
	StatusLine   string
	BrowserLine  string
	PairEnabled  bool
	BrowserSetup bool // "Set up browser" enabled
	EditEnabled  bool // "Edit connectors..." enabled (always: it needs no pairing)
	OpenEnabled  bool
	StartEnabled bool
	StopEnabled  bool
	LoginChecked bool
	Tooltip      string
	Address      string
}

// Build works the menu out.
func Build(in Input) Menu {
	m := Menu{LoginChecked: in.LoginItem, EditEnabled: true}
	fresh := in.StatusOK && in.Status.Fresh(in.Now)
	m.Address = in.CredsCerea
	if fresh && in.Status.Cerea != "" {
		m.Address = in.Status.Cerea
	}
	switch {
	case !in.HasCredentials:
		m.Link = NotPaired
	case fresh && in.Status.Link == appstatus.LinkConnected:
		m.Link = Connected
	default:
		m.Link = Offline
	}
	word := map[Link]string{NotPaired: "Not paired", Offline: "Offline", Connected: "Connected"}[m.Link]
	m.StatusLine = word
	if m.Address != "" && m.Link != NotPaired {
		m.StatusLine += " to " + hostOf(m.Address)
	}
	m.Tooltip = AppName + ": " + strings.ToLower(word)

	if fresh && in.Status.Browser == appstatus.BrowserReady {
		m.BrowserLine = "Browser: ready"
	} else {
		m.BrowserLine = "Browser: not set up"
	}
	m.PairEnabled = !in.Busy
	m.BrowserSetup = !in.Busy && in.HasCredentials
	m.OpenEnabled = m.Address != ""
	m.StartEnabled = in.HasCredentials && !in.ServiceLoaded
	m.StopEnabled = in.ServiceLoaded
	return m
}

func hostOf(addr string) string {
	if u, err := url.Parse(addr); err == nil && u.Host != "" {
		return u.Host
	}
	return addr
}

// NormalizeAddress turns what a user typed into a Cerea origin: it trims
// spaces and a trailing slash, adds https:// when there is no scheme, and
// refuses anything that is not a plain web address.
func NormalizeAddress(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", errors.New("Type the address of your Cerea, for example https://cerea.example.org.")
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || strings.ContainsAny(u.Host, " ") || (u.Scheme != "https" && u.Scheme != "http") {
		return "", errors.New("That does not look like a web address.")
	}
	if u.User != nil {
		return "", errors.New("Leave the user name and password out of the address.")
	}
	if u.Scheme == "http" {
		switch u.Hostname() {
		case "localhost", "127.0.0.1", "::1":
		default:
			return "", errors.New("Use https: a plain http address is only accepted for this Mac itself (localhost).")
		}
	}
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawQuery, u.Fragment = "", ""
	return u.String(), nil
}

// Paths are the files the app and the installer share, under one home folder.
type Paths struct{ Home string }

// StateDir is galopin's state directory on macOS (os.UserConfigDir is
// ~/Library/Application Support there).
func (p Paths) StateDir() string {
	return filepath.Join(p.Home, "Library", "Application Support", "galopin")
}
func (p Paths) Plist() string {
	return filepath.Join(p.Home, "Library", "LaunchAgents", LaunchLabel+".plist")
}
func (p Paths) Log() string { return filepath.Join(p.Home, "Library", "Logs", "galopin.log") }

// PairArgs is the galopin command that pairs this Mac with a Cerea: the short
// form (the address alone), the device flow, and connectors only unless agent
// is set.
func PairArgs(address string, agent bool) []string {
	a := []string{"enroll", "--cerea", address, "--device", "--yes"}
	if !agent {
		a = append(a, "--connectors-only")
	}
	return a
}

// BrowserSetupArgs and BrowserEnableArgs are the two commands behind "Set up browser".
func BrowserSetupArgs() []string  { return []string{"browser", "setup"} }
func BrowserEnableArgs() []string { return []string{"browser", "enable", "--headed"} }

// LaunchctlBootstrap and LaunchctlBootout start and stop the LaunchAgent for a user.
func LaunchctlBootstrap(uid int, plist string) []string {
	return []string{"bootstrap", "gui/" + strconv.Itoa(uid), plist}
}
func LaunchctlBootout(uid int) []string {
	return []string{"bootout", "gui/" + strconv.Itoa(uid) + "/" + LaunchLabel}
}

// LaunchctlPrint asks whether the job is loaded (exit status 0 when it is).
func LaunchctlPrint(uid int) []string {
	return []string{"print", "gui/" + strconv.Itoa(uid) + "/" + LaunchLabel}
}

// SignIn is what a line of `galopin enroll` output tells the tray.
type SignIn struct{ URL, Code string }

// ParseSignInLine reads the device-flow lines ("  open:  URL", "  enter: CODE")
// and updates s. It reports whether the line was one of them.
func ParseSignInLine(line string, s *SignIn) bool {
	t := strings.TrimSpace(line)
	switch {
	case strings.HasPrefix(t, "open:"):
		s.URL = strings.TrimSpace(strings.TrimPrefix(t, "open:"))
		return true
	case strings.HasPrefix(t, "enter:"):
		s.Code = strings.TrimSpace(strings.TrimPrefix(t, "enter:"))
		return true
	}
	return false
}

// FriendlyError turns the tail of a failed command's output into one plain
// sentence for a dialog.
func FriendlyError(what, output string) string {
	last := ""
	for _, l := range strings.Split(strings.TrimSpace(output), "\n") {
		if t := strings.TrimSpace(l); t != "" {
			last = strings.TrimPrefix(t, "error: ")
		}
	}
	if last == "" {
		return what + " did not work. Choose Show logs to see why."
	}
	if len(last) > 300 {
		last = last[:300] + "..."
	}
	return what + " did not work: " + last
}

// TrayLabel is the LaunchAgent that opens the app at login ("Start at login").
const TrayLabel = "org.cerea.connector"

// BundleDirName is the app's folder name in ~/Applications.
const BundleDirName = "Cerea connector.app"

// Layout is where things sit inside an installed bundle.
type Layout struct{ Bundle string }

func (l Layout) Tray() string { return filepath.Join(l.Bundle, "Contents", "MacOS", "galopin-tray") }
func (l Layout) CLI() string  { return filepath.Join(l.Bundle, "Contents", "Resources", "galopin") }
func (l Layout) NodeBin() string {
	return filepath.Join(l.Bundle, "Contents", "Resources", "node", "bin")
}

// PathEnv is the PATH the CLI and the service run with: the bundled Node first,
// so the browser runtime needs nothing installed.
func (l Layout) PathEnv(home string) string {
	return strings.Join([]string{l.NodeBin(), filepath.Join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"}, ":")
}

// ServicePlist is where the app keeps the service's LaunchAgent file. It is
// not in ~/Library/LaunchAgents: the app starts the service itself, so that
// "Start at login" is one switch.
func (p Paths) ServicePlist() string {
	return filepath.Join(p.StateDir(), LaunchLabel+".plist")
}

// TrayPlist is the login item (in ~/Library/LaunchAgents).
func (p Paths) TrayPlist() string {
	return filepath.Join(p.Home, "Library", "LaunchAgents", TrayLabel+".plist")
}

// LegacyServicePlist is where the documented manual install put the service.
func (p Paths) LegacyServicePlist() string {
	return filepath.Join(p.Home, "Library", "LaunchAgents", LaunchLabel+".plist")
}

func xmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	return r.Replace(s)
}

const plistHead = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
`

// ServicePlistXML is the LaunchAgent that keeps `galopin run` up. launchd
// cannot skip one exit code: after a revocation (exit 78) it restarts once,
// that start finds the machine id marked revoked and exits 0, which ends it.
func ServicePlistXML(l Layout, p Paths) string {
	return plistHead +
		"  <key>Label</key><string>" + LaunchLabel + "</string>\n" +
		"  <key>ProgramArguments</key>\n  <array>\n    <string>" + xmlEscape(l.CLI()) + "</string>\n    <string>run</string>\n  </array>\n" +
		"  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key><string>" + xmlEscape(l.PathEnv(p.Home)) + "</string>\n  </dict>\n" +
		"  <key>RunAtLoad</key><true/>\n" +
		"  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n" +
		"  <key>StandardOutPath</key><string>" + xmlEscape(p.Log()) + "</string>\n" +
		"  <key>StandardErrorPath</key><string>" + xmlEscape(p.Log()) + "</string>\n" +
		"</dict>\n</plist>\n"
}

// TrayPlistXML is the login item that opens the app.
func TrayPlistXML(l Layout) string {
	return plistHead +
		"  <key>Label</key><string>" + TrayLabel + "</string>\n" +
		"  <key>ProgramArguments</key>\n  <array>\n    <string>" + xmlEscape(l.Tray()) + "</string>\n  </array>\n" +
		"  <key>RunAtLoad</key><true/>\n" +
		"  <key>LimitLoadToSessionType</key><string>Aqua</string>\n" +
		"</dict>\n</plist>\n"
}
