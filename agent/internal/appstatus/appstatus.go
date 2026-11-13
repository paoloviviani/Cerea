// Package appstatus is the small file `galopin run` keeps up to date for the
// macOS menu-bar app (and anything else local that wants to know): is the link
// to Cerea up, is the machine paired, which Cerea, is the browser set up.
//
// It holds no secrets (no token, no key, no machine id) and is written in the
// state directory with mode 0600. A reader treats a file that has not been
// refreshed for StaleAfter as "not running".
package appstatus

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"galopin/internal/fsutil"
)

// FileName is the status file's name inside the state directory.
const FileName = "app-status.json"

// StaleAfter is how old a file may be before its writer is taken to be gone.
// The publisher refreshes it every Interval, so a few missed writes still pass.
const StaleAfter = 20 * time.Second

// Interval is how often the publisher rewrites the file.
const Interval = 5 * time.Second

// Link values.
const (
	LinkConnected  = "connected"
	LinkConnecting = "connecting"
)

// Browser values.
const (
	BrowserReady    = "ready"
	BrowserNotSetUp = "not_set_up"
)

// Status is the file's content.
type Status struct {
	Version   int       `json:"version"`
	PID       int       `json:"pid"`
	UpdatedAt time.Time `json:"updatedAt"`
	// Link is LinkConnected once Cerea has welcomed this machine, else LinkConnecting.
	Link string `json:"link"`
	// Paired: Cerea confirmed the pairing (the welcome said "paired").
	Paired bool `json:"paired"`
	// Cerea is the origin run dials.
	Cerea string `json:"cerea"`
	// Mode is "connectors" (no coding agent) or "agent".
	Mode string `json:"mode"`
	// Browser is BrowserReady or BrowserNotSetUp.
	Browser string `json:"browser"`
}

// Path is where the status file lives for a state directory.
func Path(stateDir string) string { return filepath.Join(stateDir, FileName) }

// Write stores s atomically with mode 0600, stamping Version, PID and UpdatedAt.
func Write(stateDir string, s Status) error {
	s.Version = 1
	s.PID = os.Getpid()
	s.UpdatedAt = time.Now().UTC()
	body, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return fsutil.WriteFileAtomic(Path(stateDir), append(body, '\n'), 0o600)
}

// Read loads the file; an error (usually not-exist) means nothing is running.
func Read(stateDir string) (Status, error) {
	var s Status
	body, err := os.ReadFile(Path(stateDir))
	if err != nil {
		return s, err
	}
	err = json.Unmarshal(body, &s)
	return s, err
}

// Fresh reports whether the file was refreshed recently enough to trust.
func (s Status) Fresh(now time.Time) bool {
	return !s.UpdatedAt.IsZero() && now.Sub(s.UpdatedAt) <= StaleAfter
}

// Publish writes snapshot() now and every interval until ctx ends, then removes
// the file so a clean stop reads as "not running" at once. Write errors are
// ignored: the status is a convenience and must never stop run.
func Publish(ctx context.Context, stateDir string, interval time.Duration, snapshot func() Status) {
	_ = Write(stateDir, snapshot())
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = os.Remove(Path(stateDir))
			return
		case <-t.C:
			_ = Write(stateDir, snapshot())
		}
	}
}
