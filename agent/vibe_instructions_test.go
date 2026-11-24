package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeInstr(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestWorkspaceInstructionsPrefersAgentsMDThenClaudeMD(t *testing.T) {
	d := t.TempDir()
	writeInstr(t, filepath.Join(d, "CLAUDE.md"), "claude rules")
	if got := workspaceInstructions(d, nil); !strings.Contains(got, "claude rules") {
		t.Fatalf("CLAUDE.md is the fallback: %q", got)
	}
	writeInstr(t, filepath.Join(d, "AGENTS.md"), "agents rules")
	got := workspaceInstructions(d, nil)
	if !strings.Contains(got, "agents rules") || strings.Contains(got, "claude rules") {
		t.Fatalf("AGENTS.md wins over CLAUDE.md: %q", got)
	}
}

func TestWorkspaceInstructionsWalksToRepoRootOutermostFirst(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeInstr(t, filepath.Join(root, "AGENTS.md"), "root rules")
	writeInstr(t, filepath.Join(root, "pkg", "AGENTS.md"), "pkg rules")
	// a file above the repository root is not read
	writeInstr(t, filepath.Join(filepath.Dir(root), "AGENTS.md"), "above the repo")
	t.Cleanup(func() { _ = os.Remove(filepath.Join(filepath.Dir(root), "AGENTS.md")) })
	got := workspaceInstructions(filepath.Join(root, "pkg"), nil)
	if i, j := strings.Index(got, "root rules"), strings.Index(got, "pkg rules"); i < 0 || j < 0 || i > j {
		t.Fatalf("want root then pkg: %q", got)
	}
	if strings.Contains(got, "above the repo") {
		t.Fatalf("read above the repository root: %q", got)
	}
}

func TestWorkspaceInstructionsWithoutRepoReadsOnlyTheWorkspace(t *testing.T) {
	parent := t.TempDir()
	writeInstr(t, filepath.Join(parent, "AGENTS.md"), "parent rules")
	child := filepath.Join(parent, "child")
	if err := os.Mkdir(child, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := workspaceInstructions(child, nil); got != "" {
		t.Fatalf("no repository: only the workspace's own file counts, got %q", got)
	}
}

func TestWorkspaceInstructionsRefusesSymlinksAndProtectedPaths(t *testing.T) {
	d := t.TempDir()
	secret := filepath.Join(t.TempDir(), "secret.txt")
	writeInstr(t, secret, "do not leak")
	if err := os.Symlink(secret, filepath.Join(d, "AGENTS.md")); err != nil {
		t.Skip("no symlinks")
	}
	if got := workspaceInstructions(d, nil); got != "" {
		t.Fatalf("a symlinked AGENTS.md was read: %q", got)
	}
	d2 := t.TempDir()
	writeInstr(t, filepath.Join(d2, "AGENTS.md"), "protected")
	if got := workspaceInstructions(d2, func(_, p string) bool { return strings.HasSuffix(p, "AGENTS.md") }); got != "" {
		t.Fatalf("a protected path was read: %q", got)
	}
}

func TestWorkspaceInstructionsAreCapped(t *testing.T) {
	d := t.TempDir()
	writeInstr(t, filepath.Join(d, "AGENTS.md"), strings.Repeat("x", vibeInstructionsMax*2))
	got := workspaceInstructions(d, nil)
	if len(got) > vibeInstructionsMax+200 || !strings.Contains(got, "[cut:") {
		t.Fatalf("not capped: %d bytes", len(got))
	}
}

func TestVibeBeforeSessionWritesAndRemoves(t *testing.T) {
	home, ws := t.TempDir(), t.TempDir()
	writeInstr(t, filepath.Join(ws, "AGENTS.md"), "ws rules")
	file := filepath.Join(home, "AGENTS.md")
	logf := func(string, ...any) {}

	vibeBeforeSession(home, true, nil, logf)(ws)
	if b, err := os.ReadFile(file); err != nil || !strings.Contains(string(b), "ws rules") {
		t.Fatalf("not written: %v %q", err, b)
	}
	if fi, _ := os.Stat(file); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", fi.Mode().Perm())
	}
	// a workspace with none clears the previous one's text
	vibeBeforeSession(home, true, nil, logf)(t.TempDir())
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("one workspace's text stayed for the next session: %v", err)
	}
	// project config denied: never written
	vibeBeforeSession(home, false, nil, logf)(ws)
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("written although project config is denied: %v", err)
	}
}
