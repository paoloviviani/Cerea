package main

import (
	"testing"
	"time"

	"galopin/internal/appstatus"
)

// An idle galopin runs all day on a laptop: every ticker it keeps while
// nothing happens is a wakeup. These floors keep a "make it more responsive"
// edit from quietly turning the idle agent into a busy one; the link's own
// ping and wake detector are the protocol's liveness and are not here.
// docs/dev/energy.md lists what is left running and why.
func TestIdleTickersAreNotSubSecond(t *testing.T) {
	for name, d := range map[string]time.Duration{
		"policyPollEvery":    policyPollEvery,
		"appstatus.Interval": appstatus.Interval,
		"refreshInterval":    refreshInterval,
	} {
		if d < 5*time.Second {
			t.Errorf("%s = %v: an idle ticker faster than 5s costs wakeups all day", name, d)
		}
	}
	if appstatus.StaleAfter < 2*appstatus.Interval {
		t.Errorf("appstatus.StaleAfter %v must outlast two missed %v writes", appstatus.StaleAfter, appstatus.Interval)
	}
}
