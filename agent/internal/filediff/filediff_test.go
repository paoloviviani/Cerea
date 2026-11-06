package filediff

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/internal/backend"
)

func write(t *testing.T, p string, data []byte) {
	t.Helper()
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func run(t *testing.T, tr *Tracker, dir, call string, paths []string, act func()) {
	t.Helper()
	tr.Begin("s", call, dir, paths)
	act()
	tr.End("s", call)
}

func only(t *testing.T, tr *Tracker) backend.FileDiff {
	t.Helper()
	d := tr.Diffs("s")
	if len(d) != 1 {
		t.Fatalf("diffs = %+v, want exactly one", d)
	}
	return d[0]
}

func TestEditAddDelete(t *testing.T) {
	dir := t.TempDir()
	a, n, g := filepath.Join(dir, "a.txt"), filepath.Join(dir, "sub", "n.txt"), filepath.Join(dir, "g.txt")
	write(t, a, []byte("x\ny\n"))
	write(t, g, []byte("bye\n"))
	_ = os.Mkdir(filepath.Join(dir, "sub"), 0o755)
	tr := New(nil)
	run(t, tr, dir, "1", []string{"a.txt", "sub/n.txt", g}, func() {
		write(t, a, []byte("x\nz\n"))
		write(t, n, []byte("new\n"))
		_ = os.Remove(g)
	})
	got := map[string]backend.FileDiff{}
	for _, f := range tr.Diffs("s") {
		got[f.Path] = f
	}
	if f := got["a.txt"]; f.Status != backend.FileModified || f.Before != "x\ny\n" || f.After != "x\nz\n" || f.Additions != 1 || f.Deletions != 1 {
		t.Errorf("a = %+v", f)
	}
	if f := got["sub/n.txt"]; f.Status != backend.FileAdded || f.After != "new\n" || f.Additions != 1 {
		t.Errorf("n = %+v", f)
	}
	if f := got["g.txt"]; f.Status != backend.FileDeleted || f.Before != "bye\n" || f.After != "" || f.Deletions != 1 {
		t.Errorf("g = %+v", f)
	}
}

func TestSessionKeepsFirstBeforeAndDropsRestoredFiles(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.txt")
	write(t, a, []byte("v1\n"))
	tr := New(nil)
	run(t, tr, dir, "1", []string{a}, func() { write(t, a, []byte("v2\n")) })
	run(t, tr, dir, "2", []string{a}, func() { write(t, a, []byte("v3\n")) })
	if f := only(t, tr); f.Before != "v1\n" || f.After != "v3\n" {
		t.Errorf("diff = %+v, want v1 -> v3", f)
	}
	run(t, tr, dir, "3", []string{a}, func() { write(t, a, []byte("v1\n")) })
	if d := tr.Diffs("s"); len(d) != 0 {
		t.Errorf("restored file still listed: %+v", d)
	}
}

func TestUnchangedCallRecordsNothing(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.txt")
	write(t, a, []byte("v1\n"))
	tr := New(nil)
	run(t, tr, dir, "1", []string{a}, func() {})
	if d := tr.Diffs("s"); len(d) != 0 {
		t.Errorf("diffs = %+v", d)
	}
}

func TestBinaryAndOversize(t *testing.T) {
	dir := t.TempDir()
	bin, big := filepath.Join(dir, "x.bin"), filepath.Join(dir, "big.txt")
	write(t, bin, []byte{0, 1, 2})
	write(t, big, bytes.Repeat([]byte("a"), MaxTextBytes+10))
	tr := New(nil)
	run(t, tr, dir, "1", []string{bin, big}, func() {
		write(t, bin, []byte{0, 9, 9})
		write(t, big, append(bytes.Repeat([]byte("a"), MaxTextBytes+10), 'b'))
	})
	got := map[string]backend.FileDiff{}
	for _, f := range tr.Diffs("s") {
		got[f.Path] = f
	}
	if f := got["x.bin"]; f.Before != MarkerBinary || f.After != MarkerBinary || f.Status != backend.FileModified || f.Additions != 0 {
		t.Errorf("bin = %+v", f)
	}
	if f := got["big.txt"]; f.Before != MarkerOversize || f.After != MarkerOversize {
		t.Errorf("big = %+v", f.Path)
	}
}

func TestProtectedPathIsNeverRead(t *testing.T) {
	dir := t.TempDir()
	s := filepath.Join(dir, "secrets.env")
	write(t, s, []byte("TOKEN=abc\n"))
	tr := New(func(_, p string) bool { return strings.HasSuffix(p, ".env") })
	run(t, tr, dir, "1", []string{s}, func() { write(t, s, []byte("TOKEN=abcdef\n")) })
	f := only(t, tr)
	if f.Before != MarkerProtected || f.After != MarkerProtected || strings.Contains(f.Before+f.After, "TOKEN") {
		t.Errorf("protected diff = %+v", f)
	}
	// an untouched protected file is not reported
	tr2 := New(func(_, p string) bool { return true })
	run(t, tr2, dir, "1", []string{s}, func() {})
	if d := tr2.Diffs("s"); len(d) != 0 {
		t.Errorf("unchanged protected file listed: %+v", d)
	}
}

func TestCleanupAtTurnEndAndForget(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.txt")
	write(t, a, []byte("1\n"))
	tr := New(nil)
	tr.Begin("s", "c", dir, []string{a})
	tr.EndTurn("s")
	write(t, a, []byte("2\n"))
	tr.End("s", "c") // its snapshot is gone: nothing to compare
	if d := tr.Diffs("s"); len(d) != 0 {
		t.Errorf("diffs after turn end = %+v", d)
	}
	if n := len(tr.sess["s"].calls); n != 0 {
		t.Errorf("%d call snapshots left", n)
	}
	run(t, tr, dir, "d", []string{a}, func() { write(t, a, []byte("3\n")) })
	tr.Forget("s")
	if d := tr.Diffs("s"); len(d) != 0 || len(tr.sess) != 0 {
		t.Errorf("session not forgotten")
	}
}

func TestCaps(t *testing.T) {
	dir := t.TempDir()
	var paths []string
	for i := 0; i < MaxFilesPerCall+5; i++ {
		p := filepath.Join(dir, string(rune('a'+i))+".txt")
		write(t, p, []byte("x"))
		paths = append(paths, p)
	}
	tr := New(nil)
	run(t, tr, dir, "1", paths, func() {
		for _, p := range paths {
			write(t, p, []byte("y"))
		}
	})
	if n := len(tr.Diffs("s")); n != MaxFilesPerCall {
		t.Errorf("%d files, want the per-call cap %d", n, MaxFilesPerCall)
	}
}

func TestInputPaths(t *testing.T) {
	got := InputPaths(map[string]any{
		"filePath":  "a.go",
		"patchText": "*** Begin Patch\n*** Update File: b.go\n*** Add File: c/d.go\n*** Delete File: e.go\n*** End Patch",
	})
	if strings.Join(got, ",") != "a.go,b.go,c/d.go,e.go" {
		t.Errorf("paths = %v", got)
	}
	if !EditTool("Write") || EditTool("read") {
		t.Error("EditTool")
	}
}
