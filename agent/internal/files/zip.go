package files

import (
	"archive/zip"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Folder download limits (PROTOCOL.md §9.3 files.zip.*).
const (
	// MaxZipBytes caps the uncompressed bytes of the files in one zip.
	MaxZipBytes = 2 << 30
	// MaxZipFiles caps the files in one zip.
	MaxZipFiles = 20000
	// MaxZipChunk is the most one files.zip.read returns.
	MaxZipChunk = 1 << 20
	maxOpenZips = 4
	// maxSkippedListed bounds the lines of SKIPPED.txt.
	maxSkippedListed = 1000
)

// zipIdle is how long a zip may sit unread before it is dropped. A variable so
// a test can shorten it.
var zipIdle = 10 * time.Minute

type zipSessions struct {
	mu   sync.Mutex
	byID map[string]*zipSession
}

type zipSession struct {
	pr    *io.PipeReader
	timer *time.Timer
}

// ZipInfo is what files.zip.begin answers.
type ZipInfo struct {
	ID string `json:"zipId"`
	// Name is the folder's name, which names the zip and its top folder.
	Name string `json:"name"`
	// Files and Bytes are what the zip will hold (uncompressed).
	Files int   `json:"files"`
	Bytes int64 `json:"bytes"`
	// Skipped counts what is left out (deny-listed files, symlinks, .git); the
	// zip lists them in SKIPPED.txt.
	Skipped int `json:"skipped"`
}

// ZipChunk is one files.zip.read answer: the next bytes of the zip, in order.
type ZipChunk struct {
	Length  int64  `json:"length"`
	EOF     bool   `json:"eof"`
	Content string `json:"content"`
}

type zipItem struct {
	rel  string
	size int64
	mode fs.FileMode
	mod  time.Time
}

type zipSkip struct{ rel, why string }

// walkZip lists what a folder's zip holds, and what it leaves out. Symlinks
// are never followed (the link itself is left out), deny-listed files and
// folders are left out, .git is left out, and nothing outside the workspace
// root is reachable: every read goes through os.Root. It stops with too_large
// as soon as a cap is passed.
func (s *Service) walkZip(r *os.Root, dir string) (items []zipItem, skipped []zipSkip, total int64, err error) {
	var walk func(d string) error
	walk = func(d string) error {
		f, err := r.Open(d)
		if err != nil {
			return mapFSErr(err)
		}
		ents, err := f.ReadDir(-1)
		f.Close()
		if err != nil {
			return err
		}
		sort.Slice(ents, func(i, j int) bool { return ents[i].Name() < ents[j].Name() })
		for _, e := range ents {
			rel := path.Join(d, e.Name())
			switch {
			case e.Name() == ".git":
				skipped = append(skipped, zipSkip{rel, "git internals are never shown"})
			case s.Redacted(rel):
				skipped = append(skipped, zipSkip{rel, "hidden by this machine's policy"})
			case e.Type()&fs.ModeSymlink != 0:
				skipped = append(skipped, zipSkip{rel, "symlink, not followed"})
			case e.IsDir():
				if err := walk(rel); err != nil {
					return err
				}
			case e.Type().IsRegular():
				info, err := e.Info()
				if err != nil {
					return mapFSErr(err)
				}
				if len(items)+1 > MaxZipFiles {
					return fmt.Errorf("%w: a folder is downloaded up to %d files", ErrTooLarge, MaxZipFiles)
				}
				total += info.Size()
				if total > MaxZipBytes {
					return fmt.Errorf("%w: a folder is downloaded up to %d bytes", ErrTooLarge, int64(MaxZipBytes))
				}
				items = append(items, zipItem{rel, info.Size(), info.Mode().Perm(), info.ModTime()})
			default:
				skipped = append(skipped, zipSkip{rel, "not a regular file"})
			}
		}
		return nil
	}
	err = walk(dir)
	return
}

// ZipBegin checks a folder against the caps (a pre-walk, before any byte is
// produced) and starts building its zip, streaming: the archive is written
// into a pipe that files.zip.read drains in order, so neither the archive nor
// the folder is ever held whole in memory or on disk.
func (s *Service) ZipBegin(root, rel string) (ZipInfo, error) {
	rel, err := CleanRel(rel)
	if err != nil {
		return ZipInfo{}, err
	}
	if isGitDir(rel) {
		return ZipInfo{}, fmt.Errorf("%w: .git is not shown", ErrForbidden)
	}
	if rel != "." && s.Redacted(rel) {
		return ZipInfo{}, fmt.Errorf("%w: hidden by this machine's policy", ErrForbidden)
	}
	r, err := openRoot(root)
	if err != nil {
		return ZipInfo{}, err
	}
	if rel != "." {
		info, err := r.Lstat(rel)
		if err != nil {
			r.Close()
			return ZipInfo{}, mapFSErr(err)
		}
		if info.Mode()&fs.ModeSymlink != 0 {
			r.Close()
			return ZipInfo{}, fmt.Errorf("%w: a symlink is not followed", ErrInvalid)
		}
		if !info.IsDir() {
			r.Close()
			return ZipInfo{}, fmt.Errorf("%w: not a folder", ErrInvalid)
		}
	}
	s.zips.mu.Lock()
	n := len(s.zips.byID)
	s.zips.mu.Unlock()
	if n >= maxOpenZips {
		r.Close()
		return ZipInfo{}, fmt.Errorf("%w: too many folder downloads at once", ErrInvalid)
	}
	items, skipped, total, err := s.walkZip(r, rel)
	if err != nil {
		r.Close()
		return ZipInfo{}, err
	}
	name := path.Base(rel)
	if rel == "." {
		name = filepath.Base(root)
	}
	id, err := newUploadID()
	if err != nil {
		r.Close()
		return ZipInfo{}, err
	}
	pr, pw := io.Pipe()
	go func() {
		defer r.Close()
		pw.CloseWithError(writeZip(r, pw, name, rel, items, skipped))
	}()
	sess := &zipSession{pr: pr}
	s.zips.mu.Lock()
	if s.zips.byID == nil {
		s.zips.byID = map[string]*zipSession{}
	}
	s.zips.byID[id] = sess
	sess.timer = time.AfterFunc(zipIdle, func() { s.ZipAbort(id) })
	s.zips.mu.Unlock()
	return ZipInfo{ID: id, Name: name, Files: len(items), Bytes: total, Skipped: len(skipped)}, nil
}

// writeZip streams the archive: the folder's files under `<name>/`, then
// SKIPPED.txt when anything was left out. SKIPPED.txt lists the skipped paths
// (a capped list, with the reason): they are names the file browser already
// shows the owner (a hidden file is listed there, locked), so the list tells
// them nothing new, and it is what lets them see why a file is missing. Never
// a file's content.
func writeZip(r *os.Root, w io.Writer, name, base string, items []zipItem, skipped []zipSkip) error {
	zw := zip.NewWriter(w)
	for _, it := range items {
		hdr := &zip.FileHeader{Name: path.Join(name, under(base, it.rel)), Method: zip.Deflate, Modified: it.mod}
		hdr.SetMode(it.mode)
		fw, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		f, err := r.Open(it.rel)
		if err != nil {
			return mapFSErr(err)
		}
		// Only what was counted: a file that grew meanwhile is cut at its
		// size, so the caps hold.
		_, err = io.Copy(fw, io.LimitReader(f, it.size))
		f.Close()
		if err != nil {
			return err
		}
	}
	if len(skipped) > 0 {
		fw, err := zw.Create(path.Join(name, "SKIPPED.txt"))
		if err != nil {
			return err
		}
		var b strings.Builder
		b.WriteString("These were left out of the zip:\n")
		for i, sk := range skipped {
			if i == maxSkippedListed {
				fmt.Fprintf(&b, "... and %d more\n", len(skipped)-i)
				break
			}
			fmt.Fprintf(&b, "%s (%s)\n", under(base, sk.rel), sk.why)
		}
		if _, err := io.WriteString(fw, b.String()); err != nil {
			return err
		}
	}
	return zw.Close()
}

// ZipRead returns the next bytes of the zip, up to length (at most
// MaxZipChunk). The reads are strictly sequential: the zip is produced as it
// is read. EOF ends the zip and forgets it.
func (s *Service) ZipRead(id string, length int64) (ZipChunk, error) {
	s.zips.mu.Lock()
	sess := s.zips.byID[id]
	s.zips.mu.Unlock()
	if sess == nil {
		return ZipChunk{}, fmt.Errorf("%w: no such download (it may have timed out)", ErrNotFound)
	}
	if length <= 0 || length > MaxZipChunk {
		length = MaxZipChunk
	}
	sess.timer.Reset(zipIdle)
	buf := make([]byte, length)
	n, err := io.ReadFull(sess.pr, buf)
	eof := errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
	if err != nil && !eof {
		s.ZipAbort(id)
		return ZipChunk{}, mapFSErr(err)
	}
	if eof {
		s.ZipAbort(id)
	}
	return ZipChunk{Length: int64(n), EOF: eof, Content: base64.StdEncoding.EncodeToString(buf[:n])}, nil
}

// ZipAbort drops a zip and stops its builder.
func (s *Service) ZipAbort(id string) {
	s.zips.mu.Lock()
	sess := s.zips.byID[id]
	delete(s.zips.byID, id)
	s.zips.mu.Unlock()
	if sess != nil {
		sess.timer.Stop()
		sess.pr.CloseWithError(errors.New("download stopped"))
	}
}

// AbortAllZips drops every zip (the link went away).
func (s *Service) AbortAllZips() {
	s.zips.mu.Lock()
	all := s.zips.byID
	s.zips.byID = nil
	s.zips.mu.Unlock()
	for _, z := range all {
		z.timer.Stop()
		z.pr.CloseWithError(errors.New("download stopped"))
	}
}

// OpenZips is how many zips are open (tests).
func (s *Service) OpenZips() int {
	s.zips.mu.Lock()
	defer s.zips.mu.Unlock()
	return len(s.zips.byID)
}

// under is rel relative to the folder base ("." is the workspace root).
func under(base, rel string) string {
	if base == "." {
		return rel
	}
	return strings.TrimPrefix(rel, base+"/")
}
