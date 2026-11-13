package trayapp

import (
	"strings"
	"testing"
	"time"

	"galopin/internal/appstatus"
)

var now = time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)

func st(link, browser string, age time.Duration) appstatus.Status {
	return appstatus.Status{Link: link, Browser: browser, Cerea: "https://cerea.example.org", UpdatedAt: now.Add(-age)}
}

func TestBuildStates(t *testing.T) {
	cases := []struct {
		name     string
		in       Input
		line     string
		browser  string
		start    bool
		stop     bool
		pairable bool
	}{
		{"never paired", Input{Now: now}, "Not paired", "Browser: not set up", false, false, true},
		{"paired, not running", Input{Now: now, HasCredentials: true, CredsCerea: "https://cerea.example.org"}, "Offline to cerea.example.org", "Browser: not set up", true, false, true},
		{"connected", Input{Now: now, HasCredentials: true, StatusOK: true, ServiceLoaded: true, Status: st("connected", "ready", time.Second)}, "Connected to cerea.example.org", "Browser: ready", false, true, true},
		{"connecting", Input{Now: now, HasCredentials: true, StatusOK: true, ServiceLoaded: true, Status: st("connecting", "ready", time.Second)}, "Offline to cerea.example.org", "Browser: ready", false, true, true},
		{"stale file", Input{Now: now, HasCredentials: true, CredsCerea: "https://cerea.example.org", StatusOK: true, ServiceLoaded: true, Status: st("connected", "ready", time.Minute)}, "Offline to cerea.example.org", "Browser: not set up", false, true, true},
		{"busy", Input{Now: now, HasCredentials: true, Busy: true}, "Offline", "Browser: not set up", true, false, false},
	}
	for _, c := range cases {
		m := Build(c.in)
		if c.name == "busy" {
			if m.PairEnabled || m.BrowserSetup {
				t.Errorf("busy should disable pair and browser setup: %+v", m)
			}
			continue
		}
		if m.StatusLine != c.line || m.BrowserLine != c.browser || m.StartEnabled != c.start || m.StopEnabled != c.stop || m.PairEnabled != c.pairable {
			t.Errorf("%s: %+v", c.name, m)
		}
	}
	if Build(Input{Now: now}).OpenEnabled {
		t.Error("Open Cerea needs an address")
	}
	if !Build(Input{Now: now, LoginItem: true}).LoginChecked {
		t.Error("login toggle")
	}
}

func TestNormalizeAddress(t *testing.T) {
	good := map[string]string{
		"cerea.example.org":               "https://cerea.example.org",
		"  https://cerea.example.org/ ":   "https://cerea.example.org",
		"http://localhost:3000":           "http://localhost:3000",
		"http://127.0.0.1:3000":           "http://127.0.0.1:3000",
		"http://[::1]:3000":               "http://[::1]:3000",
		"https://c.example.org/chat/?x=1": "https://c.example.org/chat",
	}
	for in, want := range good {
		if got, err := NormalizeAddress(in); err != nil || got != want {
			t.Errorf("%q: %q %v", in, got, err)
		}
	}
	for _, in := range []string{"", "   ", "ftp://x.org", "http://cerea.example.org", "http://10.0.0.5:3000", "https://u:p@x.org", "a b"} {
		if _, err := NormalizeAddress(in); err == nil {
			t.Errorf("%q should be refused", in)
		}
	}
}

func TestCommands(t *testing.T) {
	if got := strings.Join(PairArgs("https://c.org", false), " "); got != "enroll --cerea https://c.org --device --yes --connectors-only" {
		t.Error(got)
	}
	if got := strings.Join(PairArgs("https://c.org", true), " "); strings.Contains(got, "connectors-only") {
		t.Error(got)
	}
	if got := strings.Join(LaunchctlBootout(501), " "); got != "bootout gui/501/org.cerea.galopin" {
		t.Error(got)
	}
	if got := LaunchctlBootstrap(501, "/p.plist"); got[1] != "gui/501" || got[2] != "/p.plist" {
		t.Error(got)
	}
	p := Paths{Home: "/Users/a"}
	if p.StateDir() != "/Users/a/Library/Application Support/galopin" || p.Log() != "/Users/a/Library/Logs/galopin.log" {
		t.Error(p.StateDir(), p.Log())
	}
}

func TestParseSignInAndErrors(t *testing.T) {
	var s SignIn
	for _, l := range []string{"sign in with the device code flow:", "  open:  https://idp/device?c=AB", "  enter: AB-12"} {
		ParseSignInLine(l, &s)
	}
	if s.URL != "https://idp/device?c=AB" || s.Code != "AB-12" {
		t.Errorf("%+v", s)
	}
	if ParseSignInLine("billing group: x", &s) {
		t.Error("not a sign-in line")
	}
	if got := FriendlyError("Pairing", "a\nerror: could not reach the address\n"); got != "Pairing did not work: could not reach the address" {
		t.Error(got)
	}
	if !strings.Contains(FriendlyError("Pairing", ""), "Show logs") {
		t.Error("empty output")
	}
}

func TestPlists(t *testing.T) {
	l := Layout{Bundle: "/Users/a/Applications/Cerea connector.app"}
	p := Paths{Home: "/Users/a"}
	svc := ServicePlistXML(l, p)
	for _, want := range []string{
		"<string>org.cerea.galopin</string>",
		"/Users/a/Applications/Cerea connector.app/Contents/Resources/galopin</string>",
		"<string>run</string>",
		"Contents/Resources/node/bin:",
		"<key>SuccessfulExit</key><false/>",
		"/Users/a/Library/Logs/galopin.log",
	} {
		if !strings.Contains(svc, want) {
			t.Errorf("service plist lacks %q", want)
		}
	}
	tray := TrayPlistXML(l)
	if !strings.Contains(tray, "Contents/MacOS/galopin-tray") || !strings.Contains(tray, "org.cerea.connector") {
		t.Error(tray)
	}
	if !strings.Contains(ServicePlistXML(Layout{Bundle: "/a&b"}, p), "/a&amp;b/") {
		t.Error("not escaped")
	}
	if p.ServicePlist() != "/Users/a/Library/Application Support/galopin/org.cerea.galopin.plist" {
		t.Error(p.ServicePlist())
	}
}
