package files

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"strings"
)

// MaxUploadBytes is files.upload's cap on the decoded content (PROTOCOL.md
// §9.3), the same 30 MiB Cerea allows an attachment.
const MaxUploadBytes = 30 << 20

// DecodeUpload decodes an upload's base64 content, refusing one over the cap
// before it is decoded.
func DecodeUpload(content string) ([]byte, error) {
	if base64.StdEncoding.DecodedLen(len(content)) > MaxUploadBytes+2 {
		return nil, fmt.Errorf("%w: a file is uploaded up to %d bytes", ErrTooLarge, MaxUploadBytes)
	}
	body, err := base64.StdEncoding.DecodeString(content)
	if err != nil {
		return nil, fmt.Errorf("%w: content is not valid base64", ErrInvalid)
	}
	if len(body) > MaxUploadBytes {
		return nil, fmt.Errorf("%w: a file is uploaded up to %d bytes", ErrTooLarge, MaxUploadBytes)
	}
	return body, nil
}

// cleanUploadName refuses a name that is not one plain file name.
func cleanUploadName(name string) (string, error) {
	switch {
	case name == "" || name == "." || name == "..":
		return "", fmt.Errorf("%w: the file needs a name", ErrInvalid)
	case strings.ContainsAny(name, "/\\\x00"):
		return "", fmt.Errorf("%w: a file name has no path separators", ErrInvalid)
	case len(name) > 255:
		return "", fmt.Errorf("%w: the file name is too long", ErrInvalid)
	}
	return name, nil
}

// Upload stores body (any bytes) as the file `name` in the workspace folder
// `dir`, atomically, with every rule of Write: confined to the root through
// os.Root (no `..`, no symlink followed), .git and deny-listed paths are
// forbidden, the folder must exist. An existing file is replaced only when
// overwrite is set; otherwise (or when it changes meanwhile) the answer is a
// *ConflictError carrying its revision.
func (s *Service) Upload(root, dir, name string, body []byte, overwrite bool) (Entry, error) {
	name, err := cleanUploadName(name)
	if err != nil {
		return Entry{}, err
	}
	dir, err = CleanRel(dir)
	if err != nil {
		return Entry{}, err
	}
	rel := path.Join(dir, name)
	if isGitDir(rel) {
		return Entry{}, fmt.Errorf("%w: .git is not shown", ErrForbidden)
	}
	if s.Redacted(rel) {
		return Entry{}, fmt.Errorf("%w: hidden by this machine's policy", ErrForbidden)
	}
	if len(body) > MaxUploadBytes {
		return Entry{}, fmt.Errorf("%w: a file is uploaded up to %d bytes", ErrTooLarge, MaxUploadBytes)
	}
	r, err := openRoot(root)
	if err != nil {
		return Entry{}, err
	}
	dirRoot, err := r.OpenRoot(dir)
	if err != nil {
		r.Close()
		return Entry{}, mapFSErr(err)
	}
	info, err := dirRoot.Lstat(name)
	dirRoot.Close()
	r.Close()
	var base *string
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return Entry{}, mapFSErr(err)
	case !info.Mode().IsRegular():
		// A symlink or a folder is never replaced; write names which.
		return s.write(root, rel, body, nil, MaxUploadBytes)
	default:
		cur := revisionOf(info)
		if !overwrite {
			return Entry{}, &ConflictError{Revision: &cur}
		}
		base = &cur
	}
	return s.write(root, rel, body, base, MaxUploadBytes)
}
