package files

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func revisionNow(t *testing.T, s *Service, root, rel string) string {
	t.Helper()
	e, err := s.Stat(root, rel)
	if err != nil {
		t.Fatal(err)
	}
	return e.Revision
}

func ptr(s string) *string { return &s }

func TestWriteReplacesAtomicallyAndKeepsTheMode(t *testing.T) {
	root := t.TempDir()
	write(t, root, "bin/run.sh", "#!/bin/sh\necho old\n")
	p := filepath.Join(root, "bin", "run.sh")
	if err := os.Chmod(p, 0o750); err != nil {
		t.Fatal(err)
	}
	// A reader holding the old file keeps reading the old file: the new one
	// arrives by rename, never by truncating this inode in place.
	held, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()

	s := New(nil)
	base := revisionNow(t, s, root, "bin/run.sh")
	entry, err := s.Write(root, "bin/run.sh", []byte("#!/bin/sh\necho new\n"), &base)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(p); string(got) != "#!/bin/sh\necho new\n" {
		t.Errorf("file = %q", got)
	}
	info, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o750 {
		t.Errorf("mode = %v, want 0750 kept", info.Mode().Perm())
	}
	old := make([]byte, 64)
	n, _ := held.Read(old)
	if string(old[:n]) != "#!/bin/sh\necho old\n" {
		t.Errorf("the open handle reads %q: the file was rewritten in place", old[:n])
	}
	if entry.Revision == "" || entry.Revision == base {
		t.Errorf("entry revision = %q (was %q)", entry.Revision, base)
	}
	if entry.Path != "bin/run.sh" || entry.Type != "file" || entry.Size != int64(len("#!/bin/sh\necho new\n")) {
		t.Errorf("entry = %+v", entry)
	}
	// No temp file is left behind.
	dirents, _ := os.ReadDir(filepath.Join(root, "bin"))
	if len(dirents) != 1 {
		t.Errorf("bin/ holds %v", dirents)
	}
}

func TestWriteCreatesOnlyWhatDoesNotExist(t *testing.T) {
	root := t.TempDir()
	write(t, root, "a.txt", "here\n")
	s := New(nil)

	entry, err := s.Write(root, "new.txt", []byte("fresh\n"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "new.txt")); string(got) != "fresh\n" {
		t.Errorf("new.txt = %q", got)
	}
	if entry.Revision == "" {
		t.Error("a created file has no revision")
	}

	// baseRevision null on a file that exists: a conflict naming what is there.
	_, err = s.Write(root, "a.txt", []byte("clobber\n"), nil)
	var conflict *ConflictError
	if !errors.As(err, &conflict) || !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v, want a conflict", err)
	}
	if conflict.Revision == nil || *conflict.Revision != revisionNow(t, s, root, "a.txt") {
		t.Errorf("conflict revision = %v", conflict.Revision)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "a.txt")); string(got) != "here\n" {
		t.Errorf("a.txt was written: %q", got)
	}
}

func TestWriteRefusesAStaleRevision(t *testing.T) {
	root := t.TempDir()
	write(t, root, "a.txt", "v1\n")
	s := New(nil)
	base := revisionNow(t, s, root, "a.txt")
	// Someone else (the agent) writes in between.
	write(t, root, "a.txt", "v2 from the agent\n")
	now := revisionNow(t, s, root, "a.txt")

	_, err := s.Write(root, "a.txt", []byte("mine\n"), &base)
	var conflict *ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("err = %v, want a conflict", err)
	}
	if conflict.Revision == nil || *conflict.Revision != now {
		t.Errorf("conflict revision = %v, want %q", conflict.Revision, now)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "a.txt")); string(got) != "v2 from the agent\n" {
		t.Errorf("the agent's edit was overwritten: %q", got)
	}
	// Saving against the revision the conflict named is the Overwrite.
	if _, err := s.Write(root, "a.txt", []byte("mine\n"), conflict.Revision); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "a.txt")); string(got) != "mine\n" {
		t.Errorf("overwrite = %q", got)
	}

	// A file that went away is a conflict with no revision.
	gone := revisionNow(t, s, root, "a.txt")
	if err := os.Remove(filepath.Join(root, "a.txt")); err != nil {
		t.Fatal(err)
	}
	_, err = s.Write(root, "a.txt", []byte("x"), &gone)
	if !errors.As(err, &conflict) || conflict.Revision != nil {
		t.Errorf("err = %v, want a conflict with no revision", err)
	}
}

func TestWriteRefusesTooLarge(t *testing.T) {
	root := t.TempDir()
	s := New(nil)
	big := make([]byte, MaxWriteBytes+1)
	if _, err := s.Write(root, "big.txt", big, nil); !errors.Is(err, ErrTooLarge) {
		t.Errorf("err = %v, want too_large", err)
	}
	if _, err := os.Stat(filepath.Join(root, "big.txt")); !os.IsNotExist(err) {
		t.Errorf("big.txt exists: %v", err)
	}
	if _, err := DecodeContent(strings.Repeat("a", MaxWriteBytes+1), "utf-8"); !errors.Is(err, ErrTooLarge) {
		t.Errorf("utf-8 decode err = %v", err)
	}
	if _, err := DecodeContent(strings.Repeat("A", 2*MaxWriteBytes), "base64"); !errors.Is(err, ErrTooLarge) {
		t.Errorf("base64 decode err = %v", err)
	}
	if body, err := DecodeContent("aGk=", "base64"); err != nil || string(body) != "hi" {
		t.Errorf("base64 = %q, %v", body, err)
	}
	if _, err := DecodeContent("not base64!", "base64"); !errors.Is(err, ErrInvalid) {
		t.Errorf("bad base64 err = %v", err)
	}
	if _, err := DecodeContent("x", "latin-1"); !errors.Is(err, ErrInvalid) {
		t.Errorf("unknown encoding err = %v", err)
	}
	// Exactly the cap is fine.
	if _, err := s.Write(root, "max.txt", make([]byte, MaxWriteBytes), nil); err != nil {
		t.Errorf("a file of exactly %d bytes: %v", MaxWriteBytes, err)
	}
}

func TestWriteRefusesTheDenyListAndGit(t *testing.T) {
	root := t.TempDir()
	write(t, root, "id_rsa", "KEY\n")
	write(t, root, ".git/config", "[core]\n")
	s := New([]string{"id_rsa*", "*.pem"})
	base := revisionNow(t, s, root, "id_rsa")
	if _, err := s.Write(root, "id_rsa", []byte("replaced"), &base); !errors.Is(err, ErrForbidden) {
		t.Errorf("deny-listed write err = %v, want forbidden", err)
	}
	if _, err := s.Write(root, "new.pem", []byte("x"), nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("deny-listed create err = %v, want forbidden", err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "id_rsa")); string(got) != "KEY\n" {
		t.Errorf("id_rsa = %q", got)
	}
	if _, err := s.Write(root, ".git/config", []byte("x"), nil); !errors.Is(err, ErrForbidden) {
		t.Errorf(".git write err = %v, want forbidden", err)
	}
}

func TestWriteStaysInsideTheWorkspace(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	write(t, outside, "target.txt", "outside\n")
	write(t, root, "src/a.txt", "a\n")
	s := New(nil)

	for _, rel := range []string{"../x.txt", "/etc/x", "src/../../x", "a\\b"} {
		if _, err := s.Write(root, rel, []byte("x"), nil); !errors.Is(err, ErrInvalid) {
			t.Errorf("Write(%q) err = %v, want invalid", rel, err)
		}
	}
	for _, rel := range []string{".", ""} {
		if _, err := s.Write(root, rel, []byte("x"), nil); !errors.Is(err, ErrInvalid) {
			t.Errorf("Write(%q) err = %v, want invalid", rel, err)
		}
	}
	if _, err := s.Write(root, "src", []byte("x"), ptr("1:2:3:4")); !errors.Is(err, ErrInvalid) {
		t.Errorf("writing a directory: %v, want invalid", err)
	}
	if _, err := s.Write(root, "missing/dir/x.txt", []byte("x"), nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("writing into a missing directory: %v, want not_found", err)
	}

	// A symlinked file pointing out of the workspace: forbidden, and the
	// target is untouched.
	if err := os.Symlink(filepath.Join(outside, "target.txt"), filepath.Join(root, "out.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write(root, "out.txt", []byte("pwned"), nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("escaping symlink err = %v, want forbidden", err)
	}
	// A symlinked directory pointing out: the write cannot go through it.
	if err := os.Symlink(outside, filepath.Join(root, "outdir")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write(root, "outdir/target.txt", []byte("pwned"), nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("escaping directory symlink err = %v, want forbidden", err)
	}
	if _, err := s.Write(root, "outdir/new.txt", []byte("pwned"), nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("create through an escaping directory symlink err = %v, want forbidden", err)
	}
	if got, _ := os.ReadFile(filepath.Join(outside, "target.txt")); string(got) != "outside\n" {
		t.Errorf("outside target = %q", got)
	}
	if _, err := os.Stat(filepath.Join(outside, "new.txt")); !os.IsNotExist(err) {
		t.Errorf("a file was created outside the workspace: %v", err)
	}
	// A symlink inside the workspace is not written through either: the link
	// would be replaced by a regular file.
	if err := os.Symlink("src/a.txt", filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write(root, "link.txt", []byte("x"), nil); !errors.Is(err, ErrInvalid) {
		t.Errorf("in-root symlink err = %v, want invalid", err)
	}
	if info, err := os.Lstat(filepath.Join(root, "link.txt")); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Errorf("link.txt is no longer a symlink: %v", err)
	}
}

// A change landing while the temp file is written and synced is caught at the
// last moment: the revision is checked again right before the rename.
func TestWriteCatchesAChangeDuringTheWrite(t *testing.T) {
	root := t.TempDir()
	write(t, root, "a.txt", "v1\n")
	s := New(nil)
	base := revisionNow(t, s, root, "a.txt")
	beforePlace = func() { write(t, root, "a.txt", "the agent, mid-save\n") }
	t.Cleanup(func() { beforePlace = func() {} })

	_, err := s.Write(root, "a.txt", []byte("mine\n"), &base)
	var conflict *ConflictError
	if !errors.As(err, &conflict) || conflict.Revision == nil {
		t.Fatalf("err = %v, want a conflict naming the new revision", err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "a.txt")); string(got) != "the agent, mid-save\n" {
		t.Errorf("the agent's edit was overwritten: %q", got)
	}
	assertNoTempFiles(t, root)
}

// Create-only stays create-only even when the file appears mid-save: the file
// is put in place with a hard link, which fails on an existing name.
func TestWriteCreateOnlyNeverReplacesAFileThatAppeared(t *testing.T) {
	root := t.TempDir()
	s := New(nil)
	beforePlace = func() { write(t, root, "new.txt", "someone else's\n") }
	t.Cleanup(func() { beforePlace = func() {} })

	_, err := s.Write(root, "new.txt", []byte("mine\n"), nil)
	var conflict *ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("err = %v, want a conflict", err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "new.txt")); string(got) != "someone else's\n" {
		t.Errorf("the other file was replaced: %q", got)
	}
	assertNoTempFiles(t, root)
}

func assertNoTempFiles(t *testing.T, root string) {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".galopin-") {
			t.Errorf("temp file left behind: %s", e.Name())
		}
	}
}
