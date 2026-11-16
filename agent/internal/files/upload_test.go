package files

import (
	"bytes"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestUploadRoundTripsBinaryBytes(t *testing.T) {
	root := t.TempDir()
	write(t, root, "docs/readme.txt", "x")
	body := make([]byte, 0, 512)
	for i := 0; i < 512; i++ {
		body = append(body, byte(i%256))
	}
	s := New(nil)
	entry, err := s.Upload(root, "docs", "blob.bin", body, false)
	if err != nil {
		t.Fatal(err)
	}
	if entry.Revision == "" {
		t.Error("no revision in the entry")
	}
	got, _ := os.ReadFile(filepath.Join(root, "docs", "blob.bin"))
	if !bytes.Equal(got, body) {
		t.Error("the bytes did not round-trip")
	}
	// The folder itself: "." uploads at the root.
	if _, err := s.Upload(root, ".", "top.bin", body, false); err != nil {
		t.Fatal(err)
	}
	dec, err := DecodeUpload(base64.StdEncoding.EncodeToString(body))
	if err != nil || !bytes.Equal(dec, body) {
		t.Errorf("DecodeUpload = %v", err)
	}
}

func TestUploadSizeCap(t *testing.T) {
	root := t.TempDir()
	s := New(nil)
	if _, err := s.Upload(root, ".", "big.bin", make([]byte, MaxUploadBytes), false); err != nil {
		t.Fatalf("exactly the cap: %v", err)
	}
	if _, err := s.Upload(root, ".", "big2.bin", make([]byte, MaxUploadBytes+1), false); !errors.Is(err, ErrTooLarge) {
		t.Errorf("over the cap: %v, want too_large", err)
	}
	huge := base64.StdEncoding.EncodeToString(make([]byte, MaxUploadBytes+1024))
	if _, err := DecodeUpload(huge); !errors.Is(err, ErrTooLarge) {
		t.Errorf("DecodeUpload over the cap: %v", err)
	}
	// The text save keeps its own 1 MiB cap.
	if _, err := s.Write(root, "t.txt", make([]byte, MaxWriteBytes+1), nil); !errors.Is(err, ErrTooLarge) {
		t.Errorf("write over 1 MiB: %v", err)
	}
}

func TestUploadOverwriteAndConflict(t *testing.T) {
	root := t.TempDir()
	write(t, root, "a.txt", "old")
	s := New(nil)
	_, err := s.Upload(root, ".", "a.txt", []byte("new"), false)
	var c *ConflictError
	if !errors.As(err, &c) || c.Revision == nil {
		t.Fatalf("existing without overwrite: %v, want a conflict with its revision", err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "a.txt")); string(got) != "old" {
		t.Errorf("file = %q, want untouched", got)
	}
	if _, err := s.Upload(root, ".", "a.txt", []byte("new"), true); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "a.txt")); string(got) != "new" {
		t.Errorf("file = %q, want replaced", got)
	}
}

func TestUploadRefusesBadNamesDenyAndEscapes(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	write(t, root, ".git/config", "x")
	s := New([]string{"*.pem", "id_rsa*"})
	for _, name := range []string{"", ".", "..", "a/b", "../x", "a\\b", "x\x00y"} {
		if _, err := s.Upload(root, ".", name, []byte("x"), true); !errors.Is(err, ErrInvalid) {
			t.Errorf("name %q: %v, want invalid", name, err)
		}
	}
	if _, err := s.Upload(root, "..", "x.txt", []byte("x"), true); !errors.Is(err, ErrInvalid) {
		t.Errorf("dir ..: %v", err)
	}
	if _, err := s.Upload(root, "/etc", "x.txt", []byte("x"), true); !errors.Is(err, ErrInvalid) {
		t.Errorf("absolute dir: %v", err)
	}
	if _, err := s.Upload(root, ".", "key.pem", []byte("x"), true); !errors.Is(err, ErrForbidden) {
		t.Errorf("deny-listed name: %v, want forbidden", err)
	}
	if _, err := s.Upload(root, ".git", "hook", []byte("x"), true); !errors.Is(err, ErrForbidden) {
		t.Errorf(".git: %v, want forbidden", err)
	}
	if _, err := s.Upload(root, "missing", "x.txt", []byte("x"), false); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing folder: %v, want not_found", err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "outdir")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Upload(root, "outdir", "x.txt", []byte("pwned"), true); !errors.Is(err, ErrForbidden) {
		t.Errorf("through an escaping symlinked folder: %v, want forbidden", err)
	}
	if err := os.Symlink(filepath.Join(outside, "t.txt"), filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Upload(root, ".", "link.txt", []byte("pwned"), true); err == nil {
		t.Error("a symlink must never be written through")
	}
	if _, err := os.Stat(filepath.Join(outside, "t.txt")); err == nil {
		t.Error("the file outside the workspace was created")
	}
}
