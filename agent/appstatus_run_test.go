package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"galopin/internal/appstatus"
	"galopin/internal/link"
)

func TestBrowserState(t *testing.T) {
	dir := t.TempDir()
	if browserState(dir) != appstatus.BrowserNotSetUp {
		t.Fatal("empty dir should be not set up")
	}
	p := pathsFor(dir)
	os.MkdirAll(p.runtime, 0o700)
	os.WriteFile(p.bundle, []byte("x"), 0o600)
	if browserState(dir) != appstatus.BrowserNotSetUp {
		t.Fatal("runtime without a checked browser is not ready")
	}
	os.WriteFile(p.info, []byte(`{"node":"/n","browser":"chrome"}`), 0o600)
	if browserState(dir) != appstatus.BrowserReady {
		t.Fatal("setup done should be ready")
	}
}

func TestStartAppStatusReportsConnecting(t *testing.T) {
	appStatusEnabled = true
	defer func() { appStatusEnabled = runtime.GOOS == "darwin" }()
	dir := t.TempDir()
	lnk := link.New(link.Config{CereaOrigin: "https://c.example"})
	if lnk.Connected() {
		t.Fatal("a new link is not connected")
	}
	ctx, cancel := context.WithCancel(context.Background())
	startAppStatus(ctx, dir, "connectors", "https://c.example", lnk)
	deadline := time.Now().Add(2 * time.Second)
	for {
		s, err := appstatus.Read(dir)
		if err == nil {
			if s.Link != appstatus.LinkConnecting || s.Mode != "connectors" || s.Cerea != "https://c.example" || s.Paired {
				t.Fatalf("%+v", s)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no status file")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if st, _ := os.Stat(filepath.Join(dir, appstatus.FileName)); st.Mode().Perm() != 0o600 {
		t.Fatal("mode")
	}
	cancel()
}
