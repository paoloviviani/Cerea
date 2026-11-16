package files

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// uploadAll runs a whole chunked upload with the given chunk size.
func uploadAll(t *testing.T, s *Service, root, dir, rel string, body []byte, chunk int, overwrite, mkdirs bool) (Entry, error) {
	t.Helper()
	id, err := s.UploadBegin(root, dir, rel, int64(len(body)), overwrite, mkdirs)
	if err != nil {
		return Entry{}, err
	}
	for off := 0; off < len(body) || off == 0; off += chunk {
		end := off + chunk
		if end > len(body) {
			end = len(body)
		}
		if _, err := s.UploadChunk(id, int64(off), b64(body[off:end])); err != nil {
			return Entry{}, err
		}
		if end == len(body) {
			break
		}
	}
	return s.UploadCommit(id)
}

func TestChunkedUploadRoundTripsBinaryBytes(t *testing.T) {
	root := t.TempDir()
	write(t, root, "docs/readme.txt", "x")
	body := make([]byte, 5000)
	for i := range body {
		body[i] = byte(i * 13)
	}
	s := New(nil)
	if _, err := uploadAll(t, s, root, "docs", "blob.bin", body, 1024, false, false); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "docs", "blob.bin")); !bytes.Equal(got, body) {
		t.Error("the bytes did not round-trip")
	}
	// An empty file, and the root folder.
	if _, err := uploadAll(t, s, root, ".", "empty", nil, 1024, false, false); err != nil {
		t.Fatal(err)
	}
	// No temp file is left behind.
	ents, _ := os.ReadDir(filepath.Join(root, "docs"))
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("leftover %s", e.Name())
		}
	}
	if s.OpenUploads() != 0 {
		t.Error("uploads left open")
	}
}

func TestChunkOrderingAndSizeChecks(t *testing.T) {
	root := t.TempDir()
	s := New(nil)
	id, err := s.UploadBegin(root, ".", "a.bin", 10, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.UploadChunk(id, 4, b64([]byte("xxxx"))); !errors.Is(err, ErrInvalid) {
		t.Errorf("out-of-order chunk: %v, want invalid", err)
	}
	if _, err := s.UploadChunk(id, 0, b64([]byte("abcd"))); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UploadCommit(id); !errors.Is(err, ErrInvalid) {
		t.Errorf("commit with 4 of 10 bytes: %v, want invalid", err)
	}
	if _, err := os.Stat(filepath.Join(root, "a.bin")); err == nil {
		t.Error("a short upload was put in place")
	}
	// Past the declared size aborts and removes the partial file.
	id, _ = s.UploadBegin(root, ".", "b.bin", 3, false, false)
	if _, err := s.UploadChunk(id, 0, b64([]byte("abcd"))); !errors.Is(err, ErrInvalid) {
		t.Errorf("chunk past the size: %v", err)
	}
	if s.OpenUploads() != 0 || leftovers(root) != 0 {
		t.Errorf("open=%d leftovers=%d, want none", s.OpenUploads(), leftovers(root))
	}
	if _, err := s.UploadChunk("nope", 0, ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown upload: %v", err)
	}
}

func leftovers(root string) int {
	n := 0
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err == nil && strings.HasSuffix(d.Name(), ".tmp") {
			n++
		}
		return nil
	})
	return n
}

func TestUploadCapAbortAndIdleCleanup(t *testing.T) {
	root := t.TempDir()
	s := New(nil)
	if _, err := s.UploadBegin(root, ".", "big.bin", MaxUploadBytes+1, false, false); !errors.Is(err, ErrTooLarge) {
		t.Errorf("over the cap: %v, want too_large", err)
	}
	if id, err := s.UploadBegin(root, ".", "max.bin", MaxUploadBytes, false, false); err != nil {
		t.Errorf("exactly the cap: %v", err)
	} else {
		s.UploadAbort(id)
	}
	id, _ := s.UploadBegin(root, ".", "c.bin", 4, false, false)
	_, _ = s.UploadChunk(id, 0, b64([]byte("ab")))
	if leftovers(root) != 1 {
		t.Fatal("expected one partial file")
	}
	s.UploadAbort(id)
	if leftovers(root) != 0 || s.OpenUploads() != 0 {
		t.Error("abort left the partial file")
	}
	// An idle upload is dropped by its timer.
	old := uploadIdle
	uploadIdle = 50 * time.Millisecond
	defer func() { uploadIdle = old }()
	if _, err := s.UploadBegin(root, ".", "idle.bin", 4, false, false); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for s.OpenUploads() != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if s.OpenUploads() != 0 || leftovers(root) != 0 {
		t.Error("an idle upload was not cleaned up")
	}
}

func TestUploadConflictAtStartAndBeforeRename(t *testing.T) {
	root := t.TempDir()
	write(t, root, "a.txt", "old")
	s := New(nil)
	_, err := s.UploadBegin(root, ".", "a.txt", 3, false, false)
	var c *ConflictError
	if !errors.As(err, &c) || c.Revision == nil {
		t.Fatalf("existing without overwrite: %v, want a conflict", err)
	}
	// With overwrite, a change between the start and the commit is a conflict.
	id, err := s.UploadBegin(root, ".", "a.txt", 3, true, false)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = s.UploadChunk(id, 0, b64([]byte("new")))
	time.Sleep(10 * time.Millisecond)
	write(t, root, "a.txt", "changed meanwhile!")
	if _, err := s.UploadCommit(id); !errors.As(err, &c) {
		t.Fatalf("commit after a change: %v, want a conflict", err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "a.txt")); string(got) != "changed meanwhile!" {
		t.Errorf("file = %q, want the concurrent change kept", got)
	}
	// A file appearing after a no-overwrite start is a conflict too.
	id, _ = s.UploadBegin(root, ".", "new.txt", 1, false, false)
	_, _ = s.UploadChunk(id, 0, b64([]byte("x")))
	write(t, root, "new.txt", "appeared")
	if _, err := s.UploadCommit(id); !errors.As(err, &c) {
		t.Fatalf("commit onto a file that appeared: %v", err)
	}
	// Overwrite and commit atomically keeps the mode.
	if err := os.Chmod(filepath.Join(root, "a.txt"), 0o750); err != nil {
		t.Fatal(err)
	}
	if _, err := uploadAll(t, s, root, ".", "a.txt", []byte("final"), 2, true, false); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(filepath.Join(root, "a.txt"))
	if got, _ := os.ReadFile(filepath.Join(root, "a.txt")); string(got) != "final" || info.Mode().Perm() != 0o750 {
		t.Errorf("file = %q mode %v", got, info.Mode().Perm())
	}
}

func TestUploadMkdirConfinementDenyAndNames(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	write(t, root, ".git/config", "x")
	s := New([]string{"*.pem", "secrets"})
	body := []byte("x")
	// mkdir -p inside the workspace.
	if _, err := uploadAll(t, s, root, ".", "a/b/c.txt", body, 8, false, true); err != nil {
		t.Fatalf("nested: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "a", "b", "c.txt")); err != nil {
		t.Error("the nested file was not created")
	}
	// Without mkdirs a missing folder is not_found.
	if _, err := s.UploadBegin(root, ".", "x/y.txt", 1, false, false); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing folder: %v", err)
	}
	for _, rel := range []string{"", ".", "..", "a/../b", "/abs", "a//b", "a\\b", "x\x00y", "a/", ".."} {
		if _, err := s.UploadBegin(root, ".", rel, 1, true, true); !errors.Is(err, ErrInvalid) {
			t.Errorf("name %q: %v, want invalid", rel, err)
		}
	}
	if _, err := s.UploadBegin(root, "..", "x", 1, true, true); !errors.Is(err, ErrInvalid) {
		t.Errorf("dir ..: %v", err)
	}
	// The deny list applies to the file and to every folder on the way.
	if _, err := s.UploadBegin(root, ".", "key.pem", 1, true, true); !errors.Is(err, ErrForbidden) {
		t.Errorf("deny-listed file: %v", err)
	}
	if _, err := s.UploadBegin(root, ".", "secrets/ok.txt", 1, true, true); !errors.Is(err, ErrForbidden) {
		t.Errorf("deny-listed folder: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "secrets")); err == nil {
		t.Error("a denied folder was created")
	}
	if _, err := s.UploadBegin(root, ".", ".git/hook", 1, true, true); !errors.Is(err, ErrForbidden) {
		t.Errorf(".git: %v", err)
	}
	// A symlinked folder pointing out is never written through, nor made through.
	if err := os.Symlink(outside, filepath.Join(root, "outdir")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UploadBegin(root, ".", "outdir/x.txt", 1, true, true); err == nil {
		t.Error("an upload through a symlinked folder must be refused")
	}
	if _, err := s.UploadBegin(root, "outdir", "x.txt", 1, true, true); err == nil {
		t.Error("an upload into a symlinked folder must be refused")
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Errorf("something was written outside the workspace: %v", entries)
	}
	if err := os.Symlink(filepath.Join(outside, "t.txt"), filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UploadBegin(root, ".", "link.txt", 1, true, false); err == nil {
		t.Error("a symlink must never be written through")
	}
}

func TestZipRoundTripsTheStructureAndSkipsWhatItShould(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	write(t, root, "proj/a.txt", "alpha")
	write(t, root, "proj/sub/b.bin", "\x00")
	write(t, root, "proj/.env.local", "dotfile kept")
	write(t, root, "proj/id_rsa", "PRIVATE")
	write(t, root, "proj/secret/key.pem", "PRIVATE")
	write(t, root, "proj/.git/config", "x")
	if err := os.WriteFile(filepath.Join(outside, "t.txt"), []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "t.txt"), filepath.Join(root, "proj", "link.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "proj", "outdir")); err != nil {
		t.Fatal(err)
	}
	s := New([]string{"id_rsa*", "*.pem"})
	info, err := s.ZipBegin(root, "proj")
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != "proj" || info.Files != 3 || info.Skipped != 5 {
		t.Errorf("info = %+v, want proj, 3 files, 5 skipped", info)
	}
	var buf bytes.Buffer
	for {
		ch, err := s.ZipRead(info.ID, 100) // tiny chunks: the stream is sequential
		if err != nil {
			t.Fatal(err)
		}
		dec, _ := base64.StdEncoding.DecodeString(ch.Content)
		buf.Write(dec)
		if ch.EOF {
			break
		}
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		got[f.Name] = string(b)
	}
	for name, want := range map[string]string{
		"proj/a.txt": "alpha", "proj/sub/b.bin": "\x00", "proj/.env.local": "dotfile kept",
	} {
		if got[name] != want {
			t.Errorf("%s = %q, want %q", name, got[name], want)
		}
	}
	for name := range got {
		if strings.Contains(name, "id_rsa") || strings.Contains(name, "key.pem") || strings.Contains(name, "link.txt") || strings.Contains(name, ".git/") || strings.Contains(name, "outdir") {
			if name != "proj/SKIPPED.txt" {
				t.Errorf("%s must not be in the zip", name)
			}
		}
	}
	skipped := got["proj/SKIPPED.txt"]
	for _, want := range []string{"id_rsa (hidden", "secret/key.pem (hidden", "link.txt (symlink", "outdir (symlink", ".git (git"} {
		if !strings.Contains(skipped, want) {
			t.Errorf("SKIPPED.txt lacks %q: %s", want, skipped)
		}
	}
	if strings.Contains(skipped, "PRIVATE") || strings.Contains(string(buf.Bytes()), "outside") {
		t.Error("content of a skipped file leaked")
	}
	if s.OpenZips() != 0 {
		t.Error("the zip was not forgotten at its end")
	}
}

func TestZipCapsConfinementAndAbort(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "outdir")); err != nil {
		t.Fatal(err)
	}
	write(t, root, "d/f.txt", "x")
	s := New([]string{"id_rsa*"})
	for _, tc := range []struct {
		rel  string
		want error
	}{{"../x", ErrInvalid}, {"/etc", ErrInvalid}, {"outdir", ErrInvalid}, {".git", ErrForbidden}, {"nope", ErrNotFound}, {"d/f.txt", ErrInvalid}} {
		if _, err := s.ZipBegin(root, tc.rel); !errors.Is(err, tc.want) {
			t.Errorf("%q: %v, want %v", tc.rel, err, tc.want)
		}
	}
	// The file-count cap is checked by the pre-walk, before anything streams.
	big := t.TempDir()
	for i := 0; i <= MaxZipFiles; i++ {
		if err := os.WriteFile(filepath.Join(big, "f"+itoa(i)), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.ZipBegin(big, "."); !errors.Is(err, ErrTooLarge) {
		t.Errorf("over the file cap: %v, want too_large", err)
	}
	if s.OpenZips() != 0 {
		t.Error("a refused zip is open")
	}
	// Abort stops the builder.
	info, err := s.ZipBegin(root, "d")
	if err != nil {
		t.Fatal(err)
	}
	s.ZipAbort(info.ID)
	if _, err := s.ZipRead(info.ID, 10); !errors.Is(err, ErrNotFound) {
		t.Errorf("read after abort: %v", err)
	}
}

func itoa(i int) string { return strconv.Itoa(i) }

// The byte cap is checked by the same pre-walk, from the files' sizes (a
// sparse file costs no disk).
func TestZipByteCap(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 2; i++ {
		f, err := os.Create(filepath.Join(root, string(rune('a'+i))+".bin"))
		if err != nil {
			t.Fatal(err)
		}
		if err := f.Truncate(MaxZipBytes/2 + 1); err != nil {
			t.Fatal(err)
		}
		f.Close()
	}
	if _, err := New(nil).ZipBegin(root, "."); !errors.Is(err, ErrTooLarge) {
		t.Errorf("over the byte cap: %v, want too_large", err)
	}
}

// heapGrowth runs fn and reports how much live heap grew, after a GC.
func heapGrowth(fn func()) uint64 {
	var a, b runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&a)
	fn()
	runtime.GC()
	runtime.ReadMemStats(&b)
	if b.HeapAlloc < a.HeapAlloc {
		return 0
	}
	return b.HeapAlloc - a.HeapAlloc
}

// A 500 MB download is read in 1 MiB chunks: the file is never held whole.
func TestDownloadOfAHalfGigabyteStreamsWithoutBuffering(t *testing.T) {
	root := t.TempDir()
	f, err := os.Create(filepath.Join(root, "big.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(MaxDownloadBytes); err != nil { // sparse
		t.Fatal(err)
	}
	f.Close()
	s := New(nil)
	var total int64
	var peak uint64
	var ms runtime.MemStats
	for off := int64(0); ; {
		res, err := s.ReadBytes(root, "big.bin", off, 0)
		if err != nil {
			t.Fatal(err)
		}
		total += res.Length
		off += res.Length
		if (off/MaxDownloadChunk)%64 == 0 {
			runtime.GC()
			runtime.ReadMemStats(&ms)
			if ms.HeapAlloc > peak {
				peak = ms.HeapAlloc
			}
		}
		if res.EOF {
			break
		}
	}
	if total != MaxDownloadBytes {
		t.Fatalf("read %d, want %d", total, int64(MaxDownloadBytes))
	}
	if peak > 128<<20 {
		t.Errorf("live heap peaked at %d MiB reading a 500 MiB file: it is being buffered", peak>>20)
	}
	f2, _ := os.OpenFile(filepath.Join(root, "big.bin"), os.O_WRONLY, 0)
	_ = f2.Truncate(MaxDownloadBytes + 1)
	f2.Close()
	if _, err := s.ReadBytes(root, "big.bin", 0, 0); !errors.Is(err, ErrTooLarge) {
		t.Errorf("over the cap: %v", err)
	}
}

// A big tree is zipped without holding it: 40 files of 8 MiB (sparse, so the
// zip is small) stream through a 1 MiB chunk loop.
func TestZipOfABigTreeStreams(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 40; i++ {
		f, err := os.Create(filepath.Join(root, "f"+itoa(i)))
		if err != nil {
			t.Fatal(err)
		}
		_ = f.Truncate(8 << 20)
		f.Close()
	}
	s := New(nil)
	info, err := s.ZipBegin(root, ".")
	if err != nil {
		t.Fatal(err)
	}
	var out int64
	var peak uint64
	var ms runtime.MemStats
	for n := 0; ; n++ {
		ch, err := s.ZipRead(info.ID, 0)
		if err != nil {
			t.Fatal(err)
		}
		out += ch.Length
		if n%16 == 0 {
			runtime.GC()
			runtime.ReadMemStats(&ms)
			if ms.HeapAlloc > peak {
				peak = ms.HeapAlloc
			}
		}
		if ch.EOF {
			break
		}
	}
	if info.Bytes != 40*(8<<20) || out == 0 {
		t.Errorf("bytes=%d out=%d", info.Bytes, out)
	}
	if peak > 128<<20 {
		t.Errorf("heap peaked at %d MiB zipping %d MiB", peak>>20, info.Bytes>>20)
	}
}

func TestReadBytesRoundTripsBinaryInChunks(t *testing.T) {
	root := t.TempDir()
	body := make([]byte, 0, 2*MaxDownloadChunk+17)
	for i := 0; i < 2*MaxDownloadChunk+17; i++ {
		body = append(body, byte(i*7))
	}
	if err := os.WriteFile(filepath.Join(root, "a.bin"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	// A PNG-named file too big for an image view, and a non-UTF-8 "text" file.
	if err := os.WriteFile(filepath.Join(root, "latin.txt"), []byte{'c', 'a', 'f', 0xe9}, 0o644); err != nil {
		t.Fatal(err)
	}
	s := New(nil)
	var got []byte
	for off := int64(0); ; {
		res, err := s.ReadBytes(root, "a.bin", off, 0)
		if err != nil {
			t.Fatal(err)
		}
		chunk, err := base64.StdEncoding.DecodeString(res.Content)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, chunk...)
		off += res.Length
		if res.EOF {
			break
		}
	}
	if !bytes.Equal(got, body) {
		t.Error("the chunks did not rebuild the file")
	}
	res, err := s.ReadBytes(root, "latin.txt", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if dec, _ := base64.StdEncoding.DecodeString(res.Content); !bytes.Equal(dec, []byte{'c', 'a', 'f', 0xe9}) {
		t.Errorf("non-UTF-8 text was altered: %v", dec)
	}
}

func TestReadBytesDenyConfinementAndCap(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	write(t, root, "id_rsa", "KEY")
	write(t, root, ".git/config", "x")
	if err := os.WriteFile(filepath.Join(outside, "t.txt"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "t.txt"), filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "outdir")); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(filepath.Join(root, "huge.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(MaxDownloadBytes + 1); err != nil {
		t.Fatal(err)
	}
	f.Close()
	s := New([]string{"id_rsa*"})
	for _, tc := range []struct {
		rel  string
		want error
	}{
		{"id_rsa", ErrForbidden}, {".git/config", ErrInvalid}, {"../x", ErrInvalid},
		{"/etc/passwd", ErrInvalid}, {"link.txt", ErrForbidden}, {"outdir/t.txt", ErrForbidden},
		{"huge.bin", ErrTooLarge}, {"missing", ErrNotFound}, {".", ErrInvalid},
	} {
		if _, err := s.ReadBytes(root, tc.rel, 0, 0); !errors.Is(err, tc.want) {
			t.Errorf("%q: %v, want %v", tc.rel, err, tc.want)
		}
	}
}
