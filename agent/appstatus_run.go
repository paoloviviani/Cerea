package main

import (
	"context"

	"galopin/internal/appstatus"
	"galopin/internal/link"
)

// startAppStatus keeps <stateDir>/app-status.json current for the menu-bar app
// until ctx ends (see internal/appstatus). No secrets go in it.
func startAppStatus(ctx context.Context, stateDir, mode, cerea string, lnk *link.Link) {
	go appstatus.Publish(ctx, stateDir, appstatus.Interval, func() appstatus.Status {
		s := appstatus.Status{Link: appstatus.LinkConnecting, Paired: lnk.Paired(), Cerea: cerea, Mode: mode, Browser: browserState(stateDir)}
		if lnk.Connected() {
			s.Link = appstatus.LinkConnected
		}
		return s
	})
}

// browserState is "ready" when `galopin browser setup` has run here: the runtime
// is written and the check recorded in browser.json.
func browserState(stateDir string) string {
	p := pathsFor(stateDir)
	if _, err := readBrowserInfo(p); err != nil || !fileExists(p.bundle) {
		return appstatus.BrowserNotSetUp
	}
	return appstatus.BrowserReady
}
