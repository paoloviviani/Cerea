package appstatus

import (
	"context"
	"os"
	"runtime"
	"testing"
	"time"
)

func TestWriteReadRoundTripMode0600(t *testing.T) {
	dir := t.TempDir()
	if err := Write(dir, Status{Link: LinkConnected, Paired: true, Cerea: "https://c.example", Mode: "connectors", Browser: BrowserReady}); err != nil {
		t.Fatal(err)
	}
	got, err := Read(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.Link != LinkConnected || !got.Paired || got.Cerea != "https://c.example" || got.Version != 1 || got.PID != os.Getpid() {
		t.Fatalf("round trip: %+v", got)
	}
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(Path(dir))
		if st.Mode().Perm() != 0o600 {
			t.Fatalf("mode %v", st.Mode().Perm())
		}
	}
}

func TestFresh(t *testing.T) {
	now := time.Now()
	if (Status{}).Fresh(now) {
		t.Fatal("zero status is fresh")
	}
	if !(Status{UpdatedAt: now.Add(-5 * time.Second)}).Fresh(now) {
		t.Fatal("5s old should be fresh")
	}
	if (Status{UpdatedAt: now.Add(-time.Minute)}).Fresh(now) {
		t.Fatal("1m old should be stale")
	}
}

func TestPublishWritesThenRemovesOnStop(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	n := 0
	done := make(chan struct{})
	go func() {
		Publish(ctx, dir, 10*time.Millisecond, func() Status { n++; return Status{Link: LinkConnecting} })
		close(done)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if s, err := Read(dir); err == nil && s.Link == LinkConnecting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no status written")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if _, err := os.Stat(Path(dir)); !os.IsNotExist(err) {
		t.Fatalf("file should be gone after stop: %v", err)
	}
}
