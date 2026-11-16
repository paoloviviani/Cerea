package files

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"strings"
	"sync"
	"time"
)

// Upload limits (PROTOCOL.md §9.3 files.upload.*).
const (
	// MaxUploadBytes is the cap on one uploaded file.
	MaxUploadBytes = 200 << 20
	// MaxUploadChunk is the cap on one chunk's decoded bytes.
	MaxUploadChunk = 16 << 20
	// maxOpenUploads bounds the uploads in flight at once.
	maxOpenUploads = 8
)

// uploadIdle is how long an upload may sit without a chunk before its partial
// file is deleted. A variable so a test can shorten it.
var uploadIdle = 10 * time.Minute

// cleanUploadPath validates the relative path an upload names, under the
// open folder: "/"-separated plain segments, none empty, "." or "..".
func cleanUploadPath(rel string) ([]string, error) {
	if rel == "" || strings.ContainsAny(rel, "\\\x00") || strings.HasPrefix(rel, "/") {
		return nil, fmt.Errorf("%w: the file needs a plain relative name", ErrInvalid)
	}
	segs := strings.Split(rel, "/")
	for _, seg := range segs {
		if seg == "" || seg == "." || seg == ".." {
			return nil, fmt.Errorf("%w: a file name has no empty, . or .. parts", ErrInvalid)
		}
		if len(seg) > 255 {
			return nil, fmt.Errorf("%w: a file name is too long", ErrInvalid)
		}
	}
	return segs, nil
}

// upload is one in-flight chunked upload: a hidden temp file next to the
// target, kept open until the commit renames it into place.
type upload struct {
	id        string
	rel       string // the target, workspace-relative
	dirRel    string
	base      string
	root      string
	size      int64
	received  int64
	overwrite bool
	baseRev   *string // the revision the target had at the start (nil: absent)
	tmpName   string
	tmp       *os.File
	dirRoot   *os.Root
	r         *os.Root
	timer     *time.Timer
	closed    bool
}

// uploads is the Service's table of in-flight uploads.
type uploads struct {
	mu   sync.Mutex
	byID map[string]*upload
}

// release closes the files and deletes the partial temp file. Caller holds no lock
// on the upload; it must have been removed from the table.
func (u *upload) release(removeTemp bool) {
	if u.closed {
		return
	}
	u.closed = true
	if u.timer != nil {
		u.timer.Stop()
	}
	if u.tmp != nil {
		_ = u.tmp.Close()
	}
	if removeTemp && u.dirRoot != nil {
		_ = u.dirRoot.Remove(u.tmpName)
	}
	if u.dirRoot != nil {
		_ = u.dirRoot.Close()
	}
	if u.r != nil {
		_ = u.r.Close()
	}
}

// UploadBegin starts a chunked upload of `size` bytes as the file `rel` under
// the workspace folder `dir` (rel may hold "/" for a folder upload; the folders
// are created when mkdirs). Every rule of Write applies: confinement through
// os.Root (no `..`, no symlink followed), .git and deny-listed paths (the file
// and every folder on the way) forbidden. An existing file is replaced only
// with overwrite; otherwise a *ConflictError carries its revision. It returns
// the upload id.
func (s *Service) UploadBegin(root, dir, rel string, size int64, overwrite, mkdirs bool) (string, error) {
	dir, err := CleanRel(dir)
	if err != nil {
		return "", err
	}
	segs, err := cleanUploadPath(rel)
	if err != nil {
		return "", err
	}
	if size < 0 {
		return "", fmt.Errorf("%w: size must not be negative", ErrInvalid)
	}
	if size > MaxUploadBytes {
		return "", fmt.Errorf("%w: a file is uploaded up to %d bytes", ErrTooLarge, MaxUploadBytes)
	}
	// Every folder on the way, and the file, are checked against .git and the
	// deny list before anything is touched.
	prefix := dir
	var folders []string
	for i, seg := range segs {
		prefix = path.Join(prefix, seg)
		if isGitDir(prefix) {
			return "", fmt.Errorf("%w: .git is not shown", ErrForbidden)
		}
		if s.Redacted(prefix) {
			return "", fmt.Errorf("%w: hidden by this machine's policy", ErrForbidden)
		}
		if i < len(segs)-1 {
			folders = append(folders, prefix)
		}
	}
	if isGitDir(dir) {
		return "", fmt.Errorf("%w: .git is not shown", ErrForbidden)
	}
	full := prefix
	dirRel, base := path.Split(full)
	dirRel = strings.TrimSuffix(dirRel, "/")
	if dirRel == "" {
		dirRel = "."
	}

	s.up.mu.Lock()
	if len(s.up.byID) >= maxOpenUploads {
		s.up.mu.Unlock()
		return "", fmt.Errorf("%w: too many uploads at once", ErrInvalid)
	}
	s.up.mu.Unlock()

	r, err := openRoot(root)
	if err != nil {
		return "", err
	}
	ok := false
	defer func() {
		if !ok {
			r.Close()
		}
	}()
	// The open folder itself must exist; the folders below it are made on
	// demand, one os.Root step at a time (a symlink is never followed).
	if dir != "." {
		if info, err := r.Lstat(dir); err != nil {
			return "", mapFSErr(err)
		} else if !info.IsDir() {
			return "", fmt.Errorf("%w: not a folder", ErrInvalid)
		}
	}
	for _, f := range folders {
		info, err := r.Lstat(f)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			if !mkdirs {
				return "", fmt.Errorf("%w: no such folder", ErrNotFound)
			}
			if err := r.Mkdir(f, 0o777); err != nil {
				return "", mapFSErr(err)
			}
		case err != nil:
			return "", mapFSErr(err)
		case info.Mode()&fs.ModeSymlink != 0:
			return "", fmt.Errorf("%w: a symlink is never written through", ErrInvalid)
		case !info.IsDir():
			return "", fmt.Errorf("%w: %s is not a folder", ErrInvalid, f)
		}
	}
	dirRoot, err := r.OpenRoot(dirRel)
	if err != nil {
		return "", mapFSErr(err)
	}
	defer func() {
		if !ok {
			dirRoot.Close()
		}
	}()
	var baseRev *string
	info, err := dirRoot.Lstat(base)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return "", mapFSErr(err)
	case info.Mode()&fs.ModeSymlink != 0:
		return "", fmt.Errorf("%w: a symlink is not written through", ErrInvalid)
	case !info.Mode().IsRegular():
		return "", fmt.Errorf("%w: not a regular file", ErrInvalid)
	default:
		cur := revisionOf(info)
		if !overwrite {
			return "", &ConflictError{Revision: &cur}
		}
		baseRev = &cur
	}
	tmpName, err := tempName(base)
	if err != nil {
		return "", err
	}
	// A new file gets the mode a plain create would (0666 less the umask); a
	// replaced one's mode is set on the temp file at the commit.
	createPerm := fs.FileMode(0o600)
	if baseRev == nil {
		createPerm = 0o666
	}
	tmp, err := dirRoot.OpenFile(tmpName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, createPerm)
	if err != nil {
		return "", mapFSErr(err)
	}
	id, err := newUploadID()
	if err != nil {
		_ = tmp.Close()
		_ = dirRoot.Remove(tmpName)
		return "", err
	}
	u := &upload{id: id, rel: full, dirRel: dirRel, base: base, root: root, size: size,
		overwrite: overwrite, baseRev: baseRev, tmpName: tmpName, tmp: tmp, dirRoot: dirRoot, r: r}
	s.up.mu.Lock()
	if s.up.byID == nil {
		s.up.byID = map[string]*upload{}
	}
	s.up.byID[id] = u
	u.timer = time.AfterFunc(uploadIdle, func() { s.UploadAbort(id) })
	s.up.mu.Unlock()
	ok = true
	return id, nil
}

// take returns the upload, or not_found (an idle one was already cleaned up).
func (s *Service) takeUpload(id string) (*upload, error) {
	s.up.mu.Lock()
	defer s.up.mu.Unlock()
	u := s.up.byID[id]
	if u == nil {
		return nil, fmt.Errorf("%w: no such upload (it may have timed out)", ErrNotFound)
	}
	return u, nil
}

// UploadChunk appends one chunk (base64) at `offset`, which must be exactly
// the bytes received so far: chunks arrive in order. It answers the bytes
// received. A chunk that would pass the declared size is refused, and the
// upload is aborted.
func (s *Service) UploadChunk(id string, offset int64, content string) (int64, error) {
	u, err := s.takeUpload(id)
	if err != nil {
		return 0, err
	}
	if base64.StdEncoding.DecodedLen(len(content)) > MaxUploadChunk+2 {
		s.UploadAbort(id)
		return 0, fmt.Errorf("%w: a chunk is at most %d bytes", ErrTooLarge, MaxUploadChunk)
	}
	body, err := base64.StdEncoding.DecodeString(content)
	if err != nil {
		s.UploadAbort(id)
		return 0, fmt.Errorf("%w: content is not valid base64", ErrInvalid)
	}
	s.up.mu.Lock()
	defer s.up.mu.Unlock()
	if u.closed {
		return 0, fmt.Errorf("%w: no such upload (it may have timed out)", ErrNotFound)
	}
	if offset != u.received {
		return u.received, fmt.Errorf("%w: chunk offset %d, expected %d", ErrInvalid, offset, u.received)
	}
	if u.received+int64(len(body)) > u.size {
		delete(s.up.byID, id)
		u.release(true)
		return 0, fmt.Errorf("%w: more bytes than the %d declared", ErrInvalid, u.size)
	}
	if _, err := u.tmp.Write(body); err != nil {
		delete(s.up.byID, id)
		u.release(true)
		return 0, err
	}
	u.received += int64(len(body))
	u.timer.Reset(uploadIdle)
	return u.received, nil
}

// UploadCommit finishes the upload: the bytes received must be exactly the
// size declared. The target is checked again right before the rename (a file
// that appeared, or changed, since the start is a *ConflictError and nothing is
// replaced), then the temp file replaces it atomically, keeping an existing
// file's mode.
func (s *Service) UploadCommit(id string) (Entry, error) {
	s.up.mu.Lock()
	u := s.up.byID[id]
	if u == nil {
		s.up.mu.Unlock()
		return Entry{}, fmt.Errorf("%w: no such upload (it may have timed out)", ErrNotFound)
	}
	delete(s.up.byID, id)
	s.up.mu.Unlock()
	defer u.release(true)

	if u.received != u.size {
		return Entry{}, fmt.Errorf("%w: %d of %d bytes received", ErrInvalid, u.received, u.size)
	}
	var mode fs.FileMode
	info, err := u.dirRoot.Lstat(u.base)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if u.baseRev != nil {
			return Entry{}, &ConflictError{}
		}
	case err != nil:
		return Entry{}, mapFSErr(err)
	case !info.Mode().IsRegular():
		return Entry{}, fmt.Errorf("%w: not a regular file", ErrInvalid)
	default:
		cur := revisionOf(info)
		if u.baseRev == nil || *u.baseRev != cur {
			return Entry{}, &ConflictError{Revision: &cur}
		}
		mode = info.Mode() & (fs.ModePerm | fs.ModeSetuid | fs.ModeSetgid | fs.ModeSticky)
	}
	if info != nil {
		if err := u.tmp.Chmod(mode); err != nil {
			return Entry{}, err
		}
	}
	if err := u.tmp.Sync(); err != nil {
		return Entry{}, err
	}
	if err := u.tmp.Close(); err != nil {
		return Entry{}, err
	}
	u.tmp = nil
	if info == nil {
		if err := createIn(u.dirRoot, u.tmpName, u.base); err != nil {
			if errors.Is(err, fs.ErrExist) {
				return Entry{}, &ConflictError{}
			}
			return Entry{}, mapFSErr(err)
		}
	} else {
		if err := renameIn(u.dirRoot, u.tmpName, u.base); err != nil {
			return Entry{}, err
		}
	}
	written, err := u.dirRoot.Lstat(u.base)
	if err != nil {
		return Entry{}, mapFSErr(err)
	}
	return s.entryFor(u.r, u.root, u.rel, written), nil
}

// UploadAbort drops an upload and deletes its partial file. Unknown ids are
// ignored: abort is also what the idle timer and a closed link call.
func (s *Service) UploadAbort(id string) {
	s.up.mu.Lock()
	u := s.up.byID[id]
	delete(s.up.byID, id)
	s.up.mu.Unlock()
	if u != nil {
		u.release(true)
	}
}

// AbortAllUploads deletes every partial file (the link went away).
func (s *Service) AbortAllUploads() {
	s.up.mu.Lock()
	all := s.up.byID
	s.up.byID = nil
	s.up.mu.Unlock()
	for _, u := range all {
		u.release(true)
	}
}

// OpenUploads is how many uploads are in flight (tests, diagnostics).
func (s *Service) OpenUploads() int {
	s.up.mu.Lock()
	defer s.up.mu.Unlock()
	return len(s.up.byID)
}

func newUploadID() (string, error) {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
