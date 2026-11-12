//go:build darwin

// Command galopin-tray is the macOS menu-bar app ("Cerea connector"). It
// draws the menu from internal/trayapp and runs the embedded galopin CLI
// (Contents/Resources/galopin) for everything else. cgo is required (systray).
package main

import (
	"context"
	_ "embed"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"fyne.io/systray"

	"galopin/internal/trayapp"
)

//go:embed icon.png
var icon []byte

func main() {
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	exe, _ := os.Executable()
	// <bundle>/Contents/MacOS/galopin-tray
	bundle := filepath.Dir(filepath.Dir(filepath.Dir(exe)))
	children := &trayapp.ChildSet{}
	app := &trayapp.App{
		Layout:   trayapp.Layout{Bundle: bundle},
		Paths:    trayapp.Paths{Home: home},
		UID:      os.Getuid(),
		Run:      trayapp.NewExecRunner(children),
		Children: children,
		Now:      time.Now,
	}
	// The installer calls this to write the LaunchAgent files, then opens the app.
	if len(os.Args) > 1 && os.Args[1] == "--install-agents" {
		if err := app.InstallAgents(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	systray.Run(func() { onReady(app) }, func() {})
}

func onReady(app *trayapp.App) {
	ctx := context.Background()
	systray.SetTemplateIcon(icon, icon)
	systray.SetTooltip(trayapp.AppName)

	status := systray.AddMenuItem("Starting...", "")
	status.Disable()
	browser := systray.AddMenuItem("Browser: not set up", "")
	browser.Disable()
	systray.AddSeparator()
	pair := systray.AddMenuItem("Pair with Cerea...", "Connect this Mac to your Cerea")
	advanced := systray.AddMenuItem("Advanced", "")
	pairAgent := advanced.AddSubMenuItem("Pair as a coding-agent computer...", "Also lets Cerea use coding agents on this Mac")
	setup := systray.AddMenuItem("Set up browser", "Let Cerea use a browser on this Mac")
	edit := systray.AddMenuItem("Edit connectors...", "Open the connectors file (mcp.json) in TextEdit")
	open := systray.AddMenuItem("Open Cerea", "")
	systray.AddSeparator()
	start := systray.AddMenuItem("Start", "")
	stop := systray.AddMenuItem("Stop", "")
	login := systray.AddMenuItemCheckbox("Start at login", "", false)
	logs := systray.AddMenuItem("Show logs", "")
	systray.AddSeparator()
	quit := systray.AddMenuItem("Quit "+trayapp.AppName, "")

	// quitAll stops the service and every command the app started, then ends
	// the app. It runs once, from the menu or from a termination signal.
	var quitOnce sync.Once
	quitAll := func() {
		quitOnce.Do(func() {
			app.Quit(ctx)
			systray.Quit()
			time.AfterFunc(3*time.Second, func() { os.Exit(0) })
		})
	}
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	go func() {
		<-sigs
		quitAll()
	}()

	var busy atomic.Bool
	var address atomic.Value // string
	address.Store("")

	refresh := func() {
		in := app.Snapshot(ctx, busy.Load())
		m := trayapp.Build(in)
		address.Store(m.Address)
		status.SetTitle(m.StatusLine)
		browser.SetTitle(m.BrowserLine)
		systray.SetTooltip(m.Tooltip)
		set := func(it *systray.MenuItem, on bool) {
			if on {
				it.Enable()
			} else {
				it.Disable()
			}
		}
		set(pair, m.PairEnabled)
		set(pairAgent, m.PairEnabled)
		set(setup, m.BrowserSetup)
		set(edit, m.EditEnabled)
		set(open, m.OpenEnabled)
		set(start, m.StartEnabled)
		set(stop, m.StopEnabled)
		if m.LoginChecked {
			login.Check()
		} else {
			login.Uncheck()
		}
	}

	// work runs a slow action off the menu loop, with the busy flag up.
	work := func(f func()) {
		if !busy.CompareAndSwap(false, true) {
			return
		}
		go func() {
			defer func() { busy.Store(false); refresh() }()
			refresh()
			f()
		}()
	}
	doPair := func(agent bool) {
		def, _ := address.Load().(string)
		raw, ok := app.AskAddress(ctx, def)
		if !ok {
			return
		}
		addr, err := trayapp.NormalizeAddress(raw)
		if err != nil {
			app.Alert(ctx, err.Error())
			return
		}
		work(func() {
			err := app.Pair(ctx, addr, agent, func(s trayapp.SignIn) { go app.ShowCode(ctx, s) })
			if err != nil {
				app.Alert(ctx, err.Error())
				return
			}
			app.Alert(ctx, "This Mac is paired with "+addr+".")
		})
	}

	if _, err := app.FirstRun(); err != nil {
		app.Alert(ctx, "Could not finish setting up: "+err.Error())
	}
	// A galopin left over from a manual run, an old install or a crash would
	// run beside the service: offer to stop it, and any orphaned browser, first.
	if stopped := app.StopStrays(ctx); len(stopped) > 0 {
		log.Printf("stopped stray galopin process(es): %v", stopped)
	}
	if stopped := app.StopOrphanBrowsers(ctx); len(stopped) > 0 {
		log.Printf("stopped orphaned browser process(es): %v", stopped)
	}
	if in := app.Snapshot(ctx, false); in.HasCredentials && !in.ServiceLoaded {
		_ = app.StartService(ctx)
	}
	refresh()

	go func() {
		t := time.NewTicker(3 * time.Second)
		defer t.Stop()
		for range t.C {
			refresh()
		}
	}()
	go func() {
		for {
			select {
			case <-pair.ClickedCh:
				doPair(false)
			case <-pairAgent.ClickedCh:
				doPair(true)
			case <-setup.ClickedCh:
				work(func() {
					app.Alert(ctx, "Setting up the browser can take a few minutes. You will see a message when it is done.")
					if err := app.SetupBrowser(ctx); err != nil {
						app.Alert(ctx, err.Error())
						return
					}
					app.Alert(ctx, "The browser is ready.")
				})
			case <-edit.ClickedCh:
				if err := app.EditConnectors(ctx); err != nil {
					app.Alert(ctx, err.Error())
				} else {
					log.Print(trayapp.EditedNote)
				}
			case <-open.ClickedCh:
				if a, _ := address.Load().(string); a != "" {
					app.OpenURL(ctx, a)
				}
			case <-start.ClickedCh:
				if err := app.StartService(ctx); err != nil {
					app.Alert(ctx, err.Error())
				}
				refresh()
			case <-stop.ClickedCh:
				if err := app.StopService(ctx); err != nil {
					app.Alert(ctx, err.Error())
				}
				refresh()
			case <-login.ClickedCh:
				if err := app.SetLoginItem(!login.Checked()); err != nil {
					app.Alert(ctx, err.Error())
				}
				refresh()
			case <-logs.ClickedCh:
				app.ShowLogs(ctx)
			case <-quit.ClickedCh:
				quitAll()
				return
			}
		}
	}()
}
