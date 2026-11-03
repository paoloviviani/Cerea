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
)

// MaxWriteBytes is files.write's cap on the decoded content (PROTOCOL.md §9.3).
const MaxWriteBytes = 1 << 20

// ErrConflict is files.write's revision mismatch. The error carrying it is a
// *ConflictError, which also says what the file's revision is now.
var ErrConflict = errors.New("conflict")

// ConflictError is a revision mismatch: the file changed on disk since the
// caller read it, or exists when it was expected not to (or the reverse).
// Revision is what is on disk now, nil when there is no file.
type ConflictError struct {
	Revision *string
}

func (e *ConflictError) Error() string {
	if e.Revision == nil {
		return "conflict: the file no longer exists on disk"
	}
	return "conflict: the file changed on disk since it was read"
}

// Is makes errors.Is(err, ErrConflict) hold.
func (e *ConflictError) Is(target error) bool { return target == ErrConflict }

// DecodeContent turns files.write's content into bytes: "utf-8" (the default)
// is the string itself, "base64" is decoded. Anything past MaxWriteBytes is
// too_large, checked before decoding as well so a huge string is not decoded
// for nothing.
func DecodeContent(content, encoding string) ([]byte, error) {
	switch encoding {
	case "", "utf-8":
		if len(content) > MaxWriteBytes {
			return nil, fmt.Errorf("%w: a file is saved up to %d bytes", ErrTooLarge, MaxWriteBytes)
		}
		return []byte(content), nil
	case "base64":
		if base64.StdEncoding.DecodedLen(len(content)) > MaxWriteBytes+2 {
			return nil, fmt.Errorf("%w: a file is saved up to %d bytes", ErrTooLarge, MaxWriteBytes)
		}
		body, err := base64.StdEncoding.DecodeString(content)
		if err != nil {
			return nil, fmt.Errorf("%w: content is not valid base64", ErrInvalid)
		}
		if len(body) > MaxWriteBytes {
			return nil, fmt.Errorf("%w: a file is saved up to %d bytes", ErrTooLarge, MaxWriteBytes)
		}
		return body, nil
	default:
		return nil, fmt.Errorf("%w: encoding must be utf-8 or base64", ErrInvalid)
	}
}

// Write replaces (or creates) one file with body, atomically: the bytes go to
// a temp file in the same directory, are synced, and are renamed over the
// target, so a reader (the agent, an editor, a build) sees the old file or
// the new one, never half of it. An existing file keeps its mode.
//
// baseRevision is the revision the caller read: the write happens only while
// the file is still at it, and answers a *ConflictError otherwise. nil means
// the file must not exist yet. The same confinement as reads applies: the
// path is workspace-relative and resolved through os.Root, a symlink (inside
// the root or out of it) is never written through, .git is never touched,
// and a path on the deny list is forbidden. The directory must exist.
func (s *Service) Write(root, rel string, body []byte, baseRevision *string) (Entry, error) {
	rel, err := CleanRel(rel)
	if err != nil {
		return Entry{}, err
	}
	if rel == "." {
		return Entry{}, fmt.Errorf("%w: not a writable file", ErrInvalid)
	}
	if isGitDir(rel) {
		return Entry{}, fmt.Errorf("%w: .git is not shown", ErrForbidden)
	}
	if s.Redacted(rel) {
		return Entry{}, fmt.Errorf("%w: hidden by this machine's policy", ErrForbidden)
	}
	if len(body) > MaxWriteBytes {
		return Entry{}, fmt.Errorf("%w: a file is saved up to %d bytes", ErrTooLarge, MaxWriteBytes)
	}
	r, err := openRoot(root)
	if err != nil {
		return Entry{}, err
	}
	defer r.Close()

	dirRel, base := path.Dir(rel), path.Base(rel)
	// Every step below works on the directory's own handle, opened once
	// through the workspace root: a directory swapped for a symlink after
	// this point cannot redirect the write elsewhere.
	dirRoot, err := r.OpenRoot(dirRel)
	if err != nil {
		return Entry{}, mapFSErr(err)
	}
	defer dirRoot.Close()

	mode := fs.FileMode(0o666) // the umask applies, as for any new file
	info, err := dirRoot.Lstat(base)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if baseRevision != nil {
			return Entry{}, &ConflictError{}
		}
	case err != nil:
		return Entry{}, mapFSErr(err)
	case info.Mode()&fs.ModeSymlink != 0:
		if _, statErr := r.Stat(rel); statErr != nil && isEscape(statErr) {
			return Entry{}, fmt.Errorf("%w: the path leaves the workspace", ErrForbidden)
		}
		return Entry{}, fmt.Errorf("%w: a symlink is not written through; open its target instead", ErrInvalid)
	case !info.Mode().IsRegular():
		return Entry{}, fmt.Errorf("%w: not a regular file", ErrInvalid)
	default:
		current := revisionOf(info)
		if baseRevision == nil || *baseRevision != current {
			return Entry{}, &ConflictError{Revision: &current}
		}
		mode = info.Mode() & (fs.ModePerm | fs.ModeSetuid | fs.ModeSetgid | fs.ModeSticky)
	}

	tmpName, err := tempName(base)
	if err != nil {
		return Entry{}, err
	}
	// A new file gets the mode a plain create would give it (0666 less the
	// umask); an existing one's mode is set on the temp file before the rename.
	createPerm := fs.FileMode(0o600)
	if info == nil {
		createPerm = mode
	}
	tmp, err := dirRoot.OpenFile(tmpName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, createPerm)
	if err != nil {
		return Entry{}, mapFSErr(err)
	}
	renamed := false
	defer func() {
		if !renamed {
			_ = dirRoot.Remove(tmpName)
		}
	}()
	if _, err := tmp.Write(body); err != nil {
		_ = tmp.Close()
		return Entry{}, err
	}
	if info != nil {
		if err := tmp.Chmod(mode); err != nil {
			_ = tmp.Close()
			return Entry{}, err
		}
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return Entry{}, err
	}
	if err := tmp.Close(); err != nil {
		return Entry{}, err
	}
	if err := renameIn(dirRoot, tmpName, base); err != nil {
		return Entry{}, err
	}
	renamed = true

	written, err := dirRoot.Lstat(base)
	if err != nil {
		return Entry{}, mapFSErr(err)
	}
	return s.entryFor(r, root, rel, written), nil
}

// tempName is a fresh hidden name next to the target, for the write's temp file.
func tempName(base string) (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	name := "." + base + ".galopin-" + hex.EncodeToString(b[:]) + ".tmp"
	if len(name) > 255 {
		name = ".galopin-" + hex.EncodeToString(b[:]) + ".tmp"
	}
	return name, nil
}

func isEscape(err error) bool {
	return err != nil && errors.Is(mapFSErr(err), ErrForbidden)
}
