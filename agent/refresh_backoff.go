package main

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"time"
)

// A refresh the sign-in server answered with "try later" (temporarily_unavailable,
// 429, 5xx) is not a dead credential, but retrying it every 30 seconds drains
// the server's rate-limit bucket and keeps it limited. The shim waits instead:
// the server's Retry-After when it sent one, else exponential backoff with
// jitter, reset on the first success. The wait lives in the shim, the one
// token source the link and the proxy share, so neither retries on its own.
const (
	refreshBackoffMin = 30 * time.Second
	refreshBackoffMax = 10 * time.Minute
	// A Retry-After beyond this is clamped: the credential may well be
	// refreshable sooner, and an absurd value must not park the shim for ever.
	refreshRetryAfterMax = time.Hour
)

// retryRefreshError is a refresh the server asked us to try again later.
// RetryAfter is the server's own wait, zero when it named none.
type retryRefreshError struct {
	msg        string
	retryAfter time.Duration
}

func (e *retryRefreshError) Error() string { return e.msg }

// refreshBackoff is the shim's wait state. Guarded by the shim's mutex.
type refreshBackoff struct {
	step  time.Duration // the next exponential wait
	until time.Time     // no IdP call before this
	last  string        // the failure that set it
	// rand01 is the jitter source in [0,1); replaced in tests.
	rand01 func() float64
}

// waiting reports how long until the next IdP call is allowed (0 when now).
func (b *refreshBackoff) waiting(now time.Time) time.Duration {
	if d := b.until.Sub(now); d > 0 {
		return d
	}
	return 0
}

// fail records a retryable failure and returns the wait it sets.
func (b *refreshBackoff) fail(now time.Time, serverWait time.Duration, cause string) time.Duration {
	var wait time.Duration
	if serverWait > 0 {
		wait = min(serverWait, refreshRetryAfterMax)
	} else {
		if b.step < refreshBackoffMin {
			b.step = refreshBackoffMin
		}
		r := rand.Float64
		if b.rand01 != nil {
			r = b.rand01
		}
		// +/- 20%, so machines behind one NAT do not retry in step.
		wait = time.Duration(float64(b.step) * (0.8 + 0.4*r()))
		wait = min(wait, refreshBackoffMax)
		b.step = min(b.step*2, refreshBackoffMax)
	}
	b.until = now.Add(wait)
	b.last = cause
	return wait
}

// reset forgets the backoff: a refresh worked, or a new credential arrived.
func (b *refreshBackoff) reset() {
	b.step, b.until, b.last = 0, time.Time{}, ""
}

// refreshWaitError is what a caller gets while the shim is waiting out a
// backoff: no IdP call was made. RetryAfter lets the link wait the same time
// instead of re-asking every 30 seconds.
type refreshWaitError struct {
	wait  time.Duration
	cause string
}

func (e *refreshWaitError) Error() string {
	return fmt.Sprintf("the sign-in server is rate-limiting; retrying in %s (%s)", humanWait(e.wait), e.cause)
}

// RetryAfter is how long to wait before asking for a token again.
func (e *refreshWaitError) RetryAfter() time.Duration { return e.wait }

// retryAfterOf is the wait an error asks for, zero when it names none.
func retryAfterOf(err error) time.Duration {
	var ra interface{ RetryAfter() time.Duration }
	if errors.As(err, &ra) {
		return ra.RetryAfter()
	}
	return 0
}

// humanWait renders a wait for a log line: "45s", "4m", "1h".
func humanWait(d time.Duration) string {
	d = d.Round(time.Second)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", max(int(d/time.Second), 1))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int((d+30*time.Second)/time.Minute))
	default:
		return fmt.Sprintf("%dh", int((d+30*time.Minute)/time.Hour))
	}
}
