package trayapp

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"
)

type sig struct {
	pid int
	s   syscall.Signal
}

// procRig is an App whose processes are fake: a log of every call (launchctl
// and signals in one order), a set of live pids, and no real sleeping.
type procRig struct {
	a                  *App
	log                []string
	signals            []sig
	live               map[int]bool
	ps                 string
	printOut           string // launchctl print output while loaded
	loaded             bool
	bootedOut          bool
	printsAfterBootout int // prints that still succeed after bootout
	answer             string
	askErr             error
}

func newProcRig(t *testing.T) *procRig {
	r := &procRig{live: map[int]bool{}}
	a, _ := newApp(t)
	a.Self = 100
	a.Children = &ChildSet{}
	a.Run = func(ctx context.Context, name string, args, env []string, onLine func(string)) (string, error) {
		switch name {
		case "launchctl":
			r.log = append(r.log, "launchctl "+args[0])
			switch args[0] {
			case "bootout":
				r.bootedOut = true
			case "print":
				if r.bootedOut {
					if r.printsAfterBootout > 0 {
						r.printsAfterBootout--
						return r.printOut, nil
					}
					return "", errors.New("not loaded")
				}
				if !r.loaded {
					return "", errors.New("not loaded")
				}
				return r.printOut, nil
			}
		case "ps":
			return r.ps, nil
		case "osascript":
			r.log = append(r.log, "dialog")
			return r.answer, r.askErr
		}
		return "", nil
	}
	a.Kill = func(pid int, s syscall.Signal) error {
		r.log = append(r.log, "kill")
		r.signals = append(r.signals, sig{pid, s})
		// A group signal reaches its leader; SIGTERM and SIGKILL both end a fake.
		p := pid
		if p < 0 {
			p = -p
		}
		if s != 0 {
			delete(r.live, p)
		}
		return nil
	}
	a.Alive = func(pid int) bool { return r.live[pid] }
	a.Sleep = func(time.Duration) {}
	r.a = a
	return r
}

func TestQuitSequence(t *testing.T) {
	r := newProcRig(t)
	r.loaded = true
	r.printsAfterBootout = 2 // still loaded for two polls after bootout
	r.a.Children.Add(555)
	r.a.Children.Add(556)
	r.live[555], r.live[556] = true, true

	r.a.Quit(context.Background())

	// bootout first, then polls until print fails, then the children.
	want := []string{"launchctl bootout", "launchctl print", "launchctl print", "launchctl print", "kill", "kill", "kill", "kill"}
	if !reflect.DeepEqual(r.log, want) {
		t.Fatalf("order = %v, want %v", r.log, want)
	}
	// Each child's group gets SIGTERM, then (the leaders being gone) SIGKILL.
	wantSigs := []sig{{-555, syscall.SIGTERM}, {-556, syscall.SIGTERM}, {-555, syscall.SIGKILL}, {-556, syscall.SIGKILL}}
	if !reflect.DeepEqual(r.signals, wantSigs) {
		t.Fatalf("signals = %v, want %v", r.signals, wantSigs)
	}
	if err := r.a.StartService(context.Background()); err == nil {
		t.Fatal("the service must not start after quit")
	}
}

func TestQuitWaitsAtMostFiveSecondsForService(t *testing.T) {
	r := newProcRig(t)
	r.loaded = true
	r.printsAfterBootout = 1000 // never goes
	var slept time.Duration
	r.a.Sleep = func(d time.Duration) { slept += d }
	r.a.Quit(context.Background())
	if slept < 4*time.Second || slept > 6*time.Second {
		t.Fatalf("waited %v", slept)
	}
}

func TestKillChildrenEscalatesToKill(t *testing.T) {
	r := newProcRig(t)
	r.a.Children.Add(7)
	r.live[7] = true
	r.a.Kill = func(pid int, s syscall.Signal) error { // ignores SIGTERM
		r.signals = append(r.signals, sig{pid, s})
		if s == syscall.SIGKILL {
			delete(r.live, -pid)
		}
		return nil
	}
	r.a.Alive = func(pid int) bool { return true }
	r.a.KillChildren()
	want := []sig{{-7, syscall.SIGTERM}, {-7, syscall.SIGKILL}}
	if !reflect.DeepEqual(r.signals, want) {
		t.Fatalf("%v", r.signals)
	}
}

const psOut = `  100     1 /Users/u/Applications/Cerea connector.app/Contents/MacOS/galopin-tray
  101   100 /Users/u/Applications/Cerea connector.app/Contents/Resources/galopin enroll --cerea https://c --device
  200     1 /Users/u/Applications/Cerea connector.app/Contents/Resources/galopin run
  300     1 /usr/local/bin/galopin run --connectors-only
  310   555 galopin run
  400     1 tail -f /Users/u/Library/Logs/galopin.log
  401     1 grep galopin run
  402     1 /usr/local/bin/galopin runtime-check
  403     1 vim notes about galopin run
`

func TestParsePSAndMatching(t *testing.T) {
	ps := ParsePS(psOut)
	if len(ps) != 9 || ps[2].PID != 200 || ps[2].PPID != 1 ||
		ps[2].Command != "/Users/u/Applications/Cerea connector.app/Contents/Resources/galopin run" {
		t.Fatalf("%+v", ps)
	}
	got := map[int]bool{}
	for _, p := range ps {
		got[p.PID] = IsGalopinRun(p.Command)
	}
	for pid, want := range map[int]bool{100: false, 101: false, 200: true, 300: true, 310: true, 400: false, 401: false, 402: false, 403: false} {
		if got[pid] != want {
			t.Errorf("pid %d: IsGalopinRun = %v", pid, got[pid])
		}
	}
	if ServicePID("gui/501/org.cerea.galopin = {\n\tstate = running\n\tpid = 200\n\tlast exit code = 0\n}") != 200 || ServicePID("state = waiting") != 0 {
		t.Fatal("ServicePID")
	}
}

func TestFindStraysExcludesSelfChildrenAndService(t *testing.T) {
	r := newProcRig(t)
	r.ps = psOut
	r.loaded = true
	r.printOut = "state = running\n\tpid = 200\n"
	r.a.Children.Add(310) // a command the tray started itself
	got := r.a.FindStrays(context.Background())
	if len(got) != 1 || got[0].PID != 300 {
		t.Fatalf("strays = %+v, want only pid 300", got)
	}
	// Service not running: the bundle's galopin is a stray too (never pid 100/101 or children).
	r.loaded = false
	got = r.a.FindStrays(context.Background())
	if len(got) != 2 || got[0].PID != 200 || got[1].PID != 300 {
		t.Fatalf("strays = %+v", got)
	}
	// A galopin run whose parent is the tray is excluded.
	r.ps = "  500   100 /x/galopin run\n"
	if got = r.a.FindStrays(context.Background()); len(got) != 0 {
		t.Fatalf("%+v", got)
	}
}

func TestStopDecision(t *testing.T) {
	cases := []struct {
		out  string
		err  error
		want bool
	}{
		{"button returned:Stop\n", nil, true},
		{"button returned:Leave\n", nil, false},
		{"", nil, true}, // Stop is the default
		{"", errors.New("User canceled."), false},
	}
	for _, c := range cases {
		if got := StopDecision(c.out, c.err, true); got != c.want {
			t.Errorf("%q %v: %v", c.out, c.err, got)
		}
	}
	if StrayPrompt(Proc{PID: 42}, true) != "Another Cerea connector process is running (pid 42). Stop it?" {
		t.Fatal(StrayPrompt(Proc{PID: 42}, true))
	}
	// Not the app's own: only an explicit Stop stops, and the path is shown.
	if StopDecision("", nil, false) || StopDecision("button returned:Leave", nil, false) || !StopDecision("button returned:Stop", nil, false) {
		t.Fatal("foreign process: Keep must be the default")
	}
	if p := StrayPrompt(Proc{PID: 7, Command: "/opt/x/galopin run"}, false); !strings.Contains(p, "/opt/x/galopin run") {
		t.Fatal(p)
	}
}

func TestIsOurs(t *testing.T) {
	r := newProcRig(t)
	cli := r.a.Layout.CLI()
	sd := r.a.Paths.StateDir()
	for cmd, want := range map[string]bool{
		cli + " run":                 true,
		"/usr/local/bin/galopin run": false,
		"/usr/local/bin/galopin run --state-dir " + sd: true,
		"/usr/local/bin/galopin run --state-dir=" + sd: true,
		"/usr/local/bin/galopin run --state-dir /x":    false,
	} {
		if got := r.a.IsOurs(Proc{Command: cmd}); got != want {
			t.Errorf("%q: %v", cmd, got)
		}
	}
}

func TestStopStraysAsksThenTerminates(t *testing.T) {
	r := newProcRig(t)
	r.ps = "  300     1 /usr/local/bin/galopin run\n"
	r.live[300] = true
	r.answer = "button returned:Leave\n"
	if got := r.a.StopStrays(context.Background()); len(got) != 0 || len(r.signals) != 0 {
		t.Fatalf("Leave must not signal: %v %v", got, r.signals)
	}
	r.answer = "button returned:Stop\n"
	got := r.a.StopStrays(context.Background())
	if !reflect.DeepEqual(got, []int{300}) || len(r.signals) != 1 || r.signals[0] != (sig{300, syscall.SIGTERM}) {
		t.Fatalf("%v %v", got, r.signals)
	}
}

func TestOrphanBrowsersMatchByProfile(t *testing.T) {
	r := newProcRig(t)
	profile := r.a.Paths.BrowserProfile()
	r.ps = "  600     1 node /x/cerea-browser.mjs --profile " + profile + " --headed\n" +
		"  601   600 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=" + profile + " --no-first-run\n" +
		"  602     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n" + // the user's own Chrome
		"  603     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=" + profile + "-other\n" +
		"  100     1 /x/galopin-tray --note " + profile + "\n" + // the tray itself
		"  101   100 /x/galopin browser setup --profile " + profile + "\n" // its child
	for _, p := range []int{600, 601, 602, 603} {
		r.live[p] = true
	}
	got := r.a.StopOrphanBrowsers(context.Background())
	if !reflect.DeepEqual(got, []int{600, 601}) {
		t.Fatalf("stopped %v", got)
	}
	for _, s := range r.signals {
		if s.pid != 600 && s.pid != 601 {
			t.Fatalf("signalled %v", s)
		}
	}

	// A running service owns its browser: nothing is touched.
	r2 := newProcRig(t)
	r2.ps = r.ps
	r2.loaded = true
	r2.printOut = "pid = 900\n"
	if got := r2.a.StopOrphanBrowsers(context.Background()); len(got) != 0 || len(r2.signals) != 0 {
		t.Fatalf("service running: %v %v", got, r2.signals)
	}
	// So does a stray galopin run.
	r3 := newProcRig(t)
	r3.ps = r.ps + "  700     1 /usr/local/bin/galopin run\n"
	if got := r3.a.StopOrphanBrowsers(context.Background()); len(got) != 0 || len(r3.signals) != 0 {
		t.Fatalf("stray running: %v", got)
	}
}
