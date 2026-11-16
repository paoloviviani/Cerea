package files

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
)

// Download limits (PROTOCOL.md §9.3 files.download): a file is read in chunks
// of at most MaxDownloadChunk bytes, up to MaxDownloadBytes in all.
const (
	MaxDownloadChunk = 1 << 20
	MaxDownloadBytes = 100 << 20
)

// ReadBytes reads up to length raw bytes of one file from offset, whatever
// its kind: the binary-safe read a download is made of (Read answers text as
// UTF-8 and caps an image at 8 MiB). The same confinement as Read: through
// os.Root, .git and deny-listed paths forbidden, regular files only. A file
// over MaxDownloadBytes is too_large, answered on the first chunk.
func (s *Service) ReadBytes(root, rel string, offset, length int64) (ReadResult, error) {
	rel, err := CleanRel(rel)
	if err != nil {
		return ReadResult{}, err
	}
	if rel == "." || isGitDir(rel) {
		return ReadResult{}, fmt.Errorf("%w: not a readable file", ErrInvalid)
	}
	if s.Redacted(rel) {
		return ReadResult{}, fmt.Errorf("%w: hidden by this machine's policy", ErrForbidden)
	}
	if offset < 0 {
		return ReadResult{}, fmt.Errorf("%w: offset must not be negative", ErrInvalid)
	}
	if length <= 0 || length > MaxDownloadChunk {
		length = MaxDownloadChunk
	}
	r, err := openRoot(root)
	if err != nil {
		return ReadResult{}, err
	}
	defer r.Close()
	f, err := r.Open(rel)
	if err != nil {
		return ReadResult{}, mapFSErr(err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return ReadResult{}, mapFSErr(err)
	}
	if !info.Mode().IsRegular() {
		return ReadResult{}, fmt.Errorf("%w: not a regular file", ErrInvalid)
	}
	if info.Size() > MaxDownloadBytes {
		return ReadResult{}, fmt.Errorf("%w: a file is downloaded up to %d bytes", ErrTooLarge, MaxDownloadBytes)
	}
	out := ReadResult{Path: rel, Revision: revisionOf(info), Size: info.Size(), Offset: offset,
		Kind: "binary", Mime: mimeOf(rel, "binary"), Encoding: "base64"}
	buf := make([]byte, length)
	n, err := f.ReadAt(buf, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return ReadResult{}, err
	}
	out.Content = base64.StdEncoding.EncodeToString(buf[:n])
	out.Length = int64(n)
	out.EOF = offset+out.Length >= info.Size()
	return out, nil
}
