//go:build unix

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestInstanceLockRefusesASecondAndReleases(t *testing.T) {
	creds := filepath.Join(t.TempDir(), "credentials.json")
	unlock, err := lockInstance(creds)
	if err != nil {
		t.Fatal(err)
	}
	_, err = lockInstance(creds)
	var busy *alreadyRunningError
	if !errors.As(err, &busy) || busy.pid != os.Getpid() {
		t.Fatalf("second lock: %v, want alreadyRunningError for PID %d", err, os.Getpid())
	}
	msg := err.Error()
	if !strings.Contains(msg, "another galopin is already running with this pairing (PID "+strconv.Itoa(os.Getpid())+")") ||
		!strings.Contains(msg, "Stop it first") {
		t.Fatalf("message: %s", msg)
	}
	unlock()
	again, err := lockInstance(creds)
	if err != nil {
		t.Fatalf("not released: %v", err)
	}
	again()
}

func TestInstanceLockIsPerPairing(t *testing.T) {
	a, err := lockInstance(filepath.Join(t.TempDir(), "credentials.json"))
	if err != nil {
		t.Fatal(err)
	}
	defer a()
	b, err := lockInstance(filepath.Join(t.TempDir(), "credentials.json"))
	if err != nil {
		t.Fatalf("a different pairing must not be blocked: %v", err)
	}
	b()
}

// A second process is refused while the first lives, and the lock goes with
// the first process however it ends (here: killed, as a crash would).
func TestInstanceLockReleasedWhenTheHolderDies(t *testing.T) {
	if os.Getenv("GALOPIN_LOCK_HOLDER") != "" {
		unlock, err := lockInstance(os.Getenv("GALOPIN_LOCK_HOLDER"))
		if err != nil {
			os.Exit(3)
		}
		_ = unlock
		os.Stdout.WriteString("held\n")
		time.Sleep(time.Minute)
		return
	}
	creds := filepath.Join(t.TempDir(), "credentials.json")
	cmd := exec.Command(os.Args[0], "-test.run=^TestInstanceLockReleasedWhenTheHolderDies$")
	cmd.Env = append(os.Environ(), "GALOPIN_LOCK_HOLDER="+creds)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 5)
	if _, err := out.Read(buf); err != nil || string(buf) != "held\n" {
		t.Fatalf("holder did not take the lock: %q %v", buf, err)
	}
	_, err = lockInstance(creds)
	var busy *alreadyRunningError
	if !errors.As(err, &busy) || busy.pid != cmd.Process.Pid {
		t.Fatalf("while the holder lives: %v (want PID %d)", err, cmd.Process.Pid)
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	unlock, err := lockInstance(creds)
	if err != nil {
		t.Fatalf("a dead holder left the lock behind: %v", err)
	}
	unlock()
}

func TestEnrollRefusesUnderARunningAgent(t *testing.T) {
	creds := filepath.Join(t.TempDir(), "credentials.json")
	unlock, err := lockInstance(creds)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	err = runEnroll([]string{"--creds", creds, "--issuer", "https://idp.invalid", "--gateway", "https://gw.invalid", "--yes"})
	if err == nil || !strings.Contains(err.Error(), "another galopin is already running with this pairing") || !strings.Contains(err.Error(), "stop the agent first") {
		t.Fatalf("enroll under a running agent: %v", err)
	}
}
