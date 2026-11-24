package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// setupDir points galopin's install dir at a temp one and returns it.
func setupDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("GALOPIN_INSTALL_DIR", dir)
	return dir
}

func TestSetupInstallsALaunchCommandAndIsIdempotent(t *testing.T) {
	dir := setupDir(t)
	var out bytes.Buffer
	if err := setupLaunch(&out, "claude", false, false); err != nil {
		t.Fatal(err)
	}
	cmd := filepath.Join(dir, "claude-galopin")
	body, err := os.ReadFile(cmd)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), " launch claude \"$@\"") || !strings.Contains(string(body), setupMarker) {
		t.Errorf("script:\n%s", body)
	}
	if fi, _ := os.Stat(cmd); fi.Mode()&0o111 == 0 {
		t.Errorf("not executable: %v", fi.Mode())
	}
	if _, err := os.Stat(filepath.Join(dir, setupShimsDirName)); err == nil {
		t.Error("a shims directory appeared without --default")
	}
	if !strings.Contains(out.String(), "claude --default") {
		t.Errorf("no pointer to --default:\n%s", out.String())
	}
	out.Reset()
	if err := setupLaunch(&out, "claude", false, false); err != nil || !strings.Contains(out.String(), "already in place") {
		t.Errorf("second run: %v\n%s", err, out.String())
	}
}

func TestSetupDefaultShimPrintsThePathLineAndNeverTouchesRcFiles(t *testing.T) {
	dir := setupDir(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	rc := filepath.Join(home, ".bashrc")
	if err := os.WriteFile(rc, []byte("# mine\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := setupLaunch(&out, "opencode", true, false); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(dir, setupShimsDirName, "opencode")
	if _, err := os.Stat(shim); err != nil {
		t.Fatal(err)
	}
	want := `export PATH="` + filepath.Join(dir, setupShimsDirName) + `:$PATH"`
	if !strings.Contains(out.String(), want) {
		t.Errorf("no exact PATH line %q:\n%s", want, out.String())
	}
	if b, _ := os.ReadFile(rc); string(b) != "# mine\n" {
		t.Errorf("a shell file changed: %q", b)
	}
	if ents, _ := os.ReadDir(home); len(ents) != 1 {
		t.Errorf("files appeared in HOME: %v", ents)
	}
}

func TestSetupRefusesToOverwriteAForeignFile(t *testing.T) {
	dir := setupDir(t)
	foreign := filepath.Join(dir, "claude-galopin")
	if err := os.WriteFile(foreign, []byte("#!/bin/sh\necho mine\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := setupLaunch(&out, "claude", false, false)
	if err == nil || !strings.Contains(err.Error(), "not written by galopin") {
		t.Fatalf("err = %v", err)
	}
	if b, _ := os.ReadFile(foreign); !strings.Contains(string(b), "echo mine") {
		t.Errorf("foreign file changed: %q", b)
	}
	// and --default writes neither when the shim slot is foreign
	if err := os.Remove(foreign); err != nil {
		t.Fatal(err)
	}
	shims := filepath.Join(dir, setupShimsDirName)
	if err := os.MkdirAll(shims, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(shims, "claude"), []byte("#!/bin/sh\necho theirs\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := setupLaunch(&out, "claude", true, false); err == nil {
		t.Fatal("overwrote a foreign shim")
	}
	if _, err := os.Stat(filepath.Join(dir, "claude-galopin")); err == nil {
		t.Error("the command was written although the shim could not be")
	}
}

func TestSetupRemoveDeletesOnlyWhatSetupCreated(t *testing.T) {
	dir := setupDir(t)
	var out bytes.Buffer
	if err := setupLaunch(&out, "vibe", true, false); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(dir, "galopin-shims", "mine")
	if err := os.WriteFile(other, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := setupLaunch(&out, "vibe", false, true); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{filepath.Join(dir, "vibe-galopin"), filepath.Join(dir, setupShimsDirName, "vibe")} {
		if _, err := os.Stat(p); err == nil {
			t.Errorf("%s still there", p)
		}
	}
	if _, err := os.Stat(other); err != nil {
		t.Errorf("a foreign file was removed: %v", err)
	}
	// a foreign file under our names is left in place and reported
	if err := os.WriteFile(filepath.Join(dir, "goose-galopin"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := setupLaunch(&out, "goose", false, true); err == nil {
		t.Error("removed or ignored a foreign file silently")
	}
	if _, err := os.Stat(filepath.Join(dir, "goose-galopin")); err != nil {
		t.Errorf("foreign file removed: %v", err)
	}
	// nothing to remove is not an error
	out.Reset()
	if err := setupLaunch(&out, "opencode", false, true); err != nil || !strings.Contains(out.String(), "nothing to remove") {
		t.Errorf("%v %q", err, out.String())
	}
}

func TestSetupRemoveDropsAnEmptyShimsDirectory(t *testing.T) {
	dir := setupDir(t)
	var out bytes.Buffer
	_ = setupLaunch(&out, "claude", true, false)
	_ = setupLaunch(&out, "claude", false, true)
	if _, err := os.Stat(filepath.Join(dir, setupShimsDirName)); err == nil {
		t.Error("empty shims directory left")
	}
}

// The shim runs 'galopin launch TOOL' with the user's arguments, spaces intact.
func TestSetupCommandExecsGalopinLaunch(t *testing.T) {
	dir := setupDir(t)
	rec := filepath.Join(t.TempDir(), "rec")
	fake := filepath.Join(dir, "galopin")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nprintf '%s|' \"$@\" > "+rec+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := setupLaunch(&out, "claude", true, false); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{filepath.Join(dir, "claude-galopin"), filepath.Join(dir, setupShimsDirName, "claude")} {
		if err := exec.Command(p, "-p", "hello world").Run(); err != nil {
			t.Fatal(err)
		}
		b, _ := os.ReadFile(rec)
		if string(b) != "launch|claude|-p|hello world|" {
			t.Errorf("%s ran galopin with %q", p, b)
		}
	}
}

// launch must not find its own shim when it looks for the real tool.
func TestLaunchPathLeavesOutTheShimsDirectory(t *testing.T) {
	dir := setupDir(t)
	shims := filepath.Join(dir, setupShimsDirName)
	t.Setenv("PATH", shims+string(os.PathListSeparator)+"/usr/bin"+string(os.PathListSeparator)+"/bin")
	stripShimsFromPath()
	if got := os.Getenv("PATH"); got != "/usr/bin:/bin" {
		t.Errorf("PATH = %q", got)
	}
}

func TestSetupDesktopRefusals(t *testing.T) {
	setupDir(t)
	err := setupDesktop("claude", false, false, false, "", "")
	if err == nil || !strings.Contains(err.Error(), "no desktop provider") {
		t.Errorf("claude: %v", err)
	}
	for _, tool := range []string{"opencode", "vibe"} {
		if err := setupDesktop(tool, false, false, false, "", ""); err == nil || !strings.Contains(err.Error(), "not wired") && !strings.Contains(err.Error(), "yet") {
			t.Errorf("%s: %v", tool, err)
		}
	}
}

func TestSetupArgumentChecks(t *testing.T) {
	setupDir(t)
	if err := runSetup([]string{"emacs"}); err == nil || !strings.Contains(err.Error(), "unknown tool") {
		t.Errorf("%v", err)
	}
	if err := runSetup([]string{"claude", "--no-connectors"}); err == nil {
		t.Error("--no-connectors accepted without --desktop")
	}
	if err := runSetup([]string{"claude", "--remove", "--default"}); err == nil {
		t.Error("--remove --default accepted")
	}
}
