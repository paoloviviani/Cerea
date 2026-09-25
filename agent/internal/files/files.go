// Package files serves a workspace's files, read-only, to the /code
// explorer (PROTOCOL.md §9, ADR 0090): list, stat, read and git status.
//
// Every access goes through os.Root for the workspace directory, which is
// openat-based: "..", absolute paths and symlinks that escape the root are
// refused by the kernel-level resolution, not by string checks racing the
// filesystem. A symlink is listed with where it points; one that escapes
// the root is never followed or read.
//
// A deny list (the machine policy's fileDeny) redacts secrets: such entries
// are listed with redacted: true and refused on read. It prevents accidental
// exposure (screen sharing, content flowing through Cerea's logs); it is not
// a boundary against the agent or a terminal, which can read the file anyway.
package files

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// Errors a caller maps to the wire's error codes.
var (
	ErrInvalid   = errors.New("invalid")
	ErrForbidden = errors.New("forbidden")
	ErrNotFound  = errors.New("not_found")
	ErrTooLarge  = errors.New("too_large")
)

// Limits (PROTOCOL.md §9.3).
const (
	MaxListEntries   = 5000
	MaxReadLength    = 1 << 20
	MaxImageBytes    = 8 << 20
	MaxStatusEntries = 10000
	sniffBytes       = 8 << 10
	gitTimeout       = 5 * time.Second
	statusCacheTTL   = time.Second
)

// Entry is one listed file or directory (PROTOCOL.md §9.3 Entry).
type Entry struct {
	Name     string   `json:"name"`
	Path     string   `json:"path"`
	Type     string   `json:"type"` // file | dir | symlink | other
	Size     int64    `json:"size"`
	Mtime    string   `json:"mtime"`
	Revision string   `json:"revision,omitempty"`
	Hidden   bool     `json:"hidden"`
	Ignored  bool     `json:"ignored"`
	Redacted bool     `json:"redacted"`
	Symlink  *Symlink `json:"symlink,omitempty"`
}

// Symlink says where a symlink points, and whether that stays inside the root.
type Symlink struct {
	Target   string `json:"target"`
	Escapes  bool   `json:"escapes"`
	Dangling bool   `json:"dangling"`
}

// ListResult is files.list's answer.
type ListResult struct {
	Path      string  `json:"path"`
	Entries   []Entry `json:"entries"`
	Truncated bool    `json:"truncated"`
}

// ReadResult is files.read's answer.
type ReadResult struct {
	Path     string `json:"path"`
	Revision string `json:"revision"`
	Size     int64  `json:"size"`
	Offset   int64  `json:"offset"`
	Length   int64  `json:"length"`
	EOF      bool   `json:"eof"`
	Kind     string `json:"kind"`     // text | binary | image
	Mime     string `json:"mime"`     //
	Encoding string `json:"encoding"` // utf-8 | base64 | none
	Content  string `json:"content,omitempty"`
}

// StatusEntry is one porcelain-v2 line (PROTOCOL.md §9.3 files.status).
type StatusEntry struct {
	Path     string `json:"path"`
	X        string `json:"x"`
	Y        string `json:"y"`
	OrigPath string `json:"origPath,omitempty"`
}

// StatusResult is files.status's answer.
type StatusResult struct {
	IsGitRepo bool          `json:"isGitRepo"`
	Branch    string        `json:"branch,omitempty"`
	Head      string        `json:"head,omitempty"`
	Entries   []StatusEntry `json:"entries"`
	Truncated bool          `json:"truncated"`
}

// Service answers the files.* ops for any workspace root.
type Service struct {
	deny []string

	mu          sync.Mutex
	statusCache map[string]cachedStatus
}

type cachedStatus struct {
	at     time.Time
	result StatusResult
}

// New builds a Service redacting entries that match deny (globs).
func New(deny []string) *Service {
	return &Service{deny: deny, statusCache: map[string]cachedStatus{}}
}

// CleanRel validates a workspace-relative path: "/"-separated, no leading
// "/", no ".." segment, no NUL. "" and "." are the root.
func CleanRel(rel string) (string, error) {
	if rel == "" || rel == "." {
		return ".", nil
	}
	if strings.ContainsRune(rel, 0) || strings.HasPrefix(rel, "/") || strings.Contains(rel, "\\") {
		return "", fmt.Errorf("%w: path must be workspace-relative", ErrInvalid)
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == ".." {
			return "", fmt.Errorf("%w: path must not contain ..", ErrInvalid)
		}
	}
	return path.Clean(rel), nil
}

func joinRel(dir, name string) string {
	if dir == "." {
		return name
	}
	return dir + "/" + name
}

// isGitDir reports whether any segment of rel is ".git": the repository's
// own internals are never shown.
func isGitDir(rel string) bool {
	for _, seg := range strings.Split(rel, "/") {
		if seg == ".git" {
			return true
		}
	}
	return false
}

// Redacted reports whether rel matches the deny list. A pattern without "/"
// matches the base name; one with "/" matches the path's tail.
func (s *Service) Redacted(rel string) bool {
	return MatchDeny(s.deny, rel)
}

// MatchDeny is Redacted for an explicit list. A "!pattern" entry exempts
// names the earlier entries matched (the default list's .env.example).
func MatchDeny(deny []string, rel string) bool {
	base := path.Base(rel)
	matched := false
	for _, pattern := range deny {
		negate := strings.HasPrefix(pattern, "!")
		p := strings.TrimPrefix(pattern, "!")
		var hit bool
		if strings.Contains(p, "/") {
			hit = rel == p || strings.HasSuffix(rel, "/"+p)
			if !hit {
				if ok, _ := path.Match(p, rel); ok {
					hit = true
				}
			}
		} else if ok, _ := path.Match(p, base); ok {
			hit = true
		}
		if hit {
			matched = !negate
		}
	}
	return matched
}

func openRoot(root string) (*os.Root, error) {
	r, err := os.OpenRoot(root)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("%w: the workspace directory is gone", ErrNotFound)
		}
		return nil, err
	}
	return r, nil
}

// mapFSErr turns an os.Root error into the package's own.
func mapFSErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, fs.ErrNotExist):
		return fmt.Errorf("%w: no such path", ErrNotFound)
	case strings.Contains(err.Error(), "path escapes from parent"):
		return fmt.Errorf("%w: the path leaves the workspace", ErrForbidden)
	default:
		return err
	}
}

func (s *Service) entryFor(r *os.Root, root, rel string, info fs.FileInfo) Entry {
	e := Entry{
		Name:     path.Base(rel),
		Path:     rel,
		Size:     info.Size(),
		Mtime:    info.ModTime().UTC().Format(time.RFC3339Nano),
		Hidden:   strings.HasPrefix(path.Base(rel), "."),
		Redacted: s.Redacted(rel),
	}
	switch mode := info.Mode(); {
	case mode&fs.ModeSymlink != 0:
		e.Type = "symlink"
		target, _ := os.Readlink(filepath.Join(root, filepath.FromSlash(rel)))
		link := &Symlink{Target: target}
		if _, err := r.Stat(rel); err != nil {
			if strings.Contains(err.Error(), "path escapes from parent") {
				link.Escapes = true
			} else {
				link.Dangling = true
			}
		}
		e.Symlink = link
	case mode.IsDir():
		e.Type = "dir"
	case mode.IsRegular():
		e.Type = "file"
		e.Revision = revisionOf(info)
	default:
		e.Type = "other"
	}
	return e
}

// List lists one directory: directories first, then a natural sort of names.
func (s *Service) List(ctx context.Context, root, rel string, withIgnored bool) (ListResult, error) {
	rel, err := CleanRel(rel)
	if err != nil {
		return ListResult{}, err
	}
	if isGitDir(rel) {
		return ListResult{}, fmt.Errorf("%w: .git is not shown", ErrForbidden)
	}
	r, err := openRoot(root)
	if err != nil {
		return ListResult{}, err
	}
	defer r.Close()
	dir, err := r.Open(rel)
	if err != nil {
		return ListResult{}, mapFSErr(err)
	}
	defer dir.Close()
	info, err := dir.Stat()
	if err != nil {
		return ListResult{}, mapFSErr(err)
	}
	if !info.IsDir() {
		return ListResult{}, fmt.Errorf("%w: not a directory", ErrInvalid)
	}
	dirents, err := dir.ReadDir(-1)
	if err != nil {
		return ListResult{}, mapFSErr(err)
	}
	out := ListResult{Path: rel, Entries: []Entry{}}
	for _, d := range dirents {
		if d.Name() == ".git" {
			continue
		}
		childRel := joinRel(rel, d.Name())
		childInfo, err := r.Lstat(childRel)
		if err != nil {
			continue
		}
		out.Entries = append(out.Entries, s.entryFor(r, root, childRel, childInfo))
	}
	sort.SliceStable(out.Entries, func(i, j int) bool {
		a, b := out.Entries[i], out.Entries[j]
		if (a.Type == "dir") != (b.Type == "dir") {
			return a.Type == "dir"
		}
		return naturalLess(a.Name, b.Name)
	})
	if len(out.Entries) > MaxListEntries {
		out.Entries = out.Entries[:MaxListEntries]
		out.Truncated = true
	}
	if withIgnored {
		markIgnored(ctx, root, out.Entries)
	}
	return out, nil
}

// Stat describes one path.
func (s *Service) Stat(root, rel string) (Entry, error) {
	rel, err := CleanRel(rel)
	if err != nil {
		return Entry{}, err
	}
	if isGitDir(rel) {
		return Entry{}, fmt.Errorf("%w: .git is not shown", ErrForbidden)
	}
	r, err := openRoot(root)
	if err != nil {
		return Entry{}, err
	}
	defer r.Close()
	info, err := r.Lstat(rel)
	if err != nil {
		return Entry{}, mapFSErr(err)
	}
	return s.entryFor(r, root, rel, info), nil
}

var imageExt = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp",
}

func mimeOf(rel string, kind string) string {
	if m, ok := imageExt[strings.ToLower(path.Ext(rel))]; ok {
		return m
	}
	if kind == "text" {
		if m := mime.TypeByExtension(path.Ext(rel)); strings.HasPrefix(m, "text/") {
			return m
		}
		return "text/plain; charset=utf-8"
	}
	if m := mime.TypeByExtension(path.Ext(rel)); m != "" {
		return m
	}
	return "application/octet-stream"
}

// looksBinary is the 8 KiB sniff: a NUL, or bytes that are not UTF-8 once
// a rune cut short at the sniff's own end is set aside.
func looksBinary(head []byte) bool {
	if bytes.IndexByte(head, 0) >= 0 {
		return true
	}
	return !utf8.Valid(trimIncompleteTail(head))
}

// trimIncompleteTail drops a rune cut short at the end of b.
func trimIncompleteTail(b []byte) []byte {
	for i := 1; i <= utf8.UTFMax && i <= len(b); i++ {
		c := b[len(b)-i]
		if c < 0x80 {
			return b // ASCII: the tail is whole
		}
		if utf8.RuneStart(c) {
			if !utf8.FullRune(b[len(b)-i:]) {
				return b[:len(b)-i]
			}
			return b
		}
	}
	return b
}

// Read returns one range of a file. Text is trimmed to a UTF-8 boundary at
// the end; binary carries content only as base64 on request; an image comes
// whole, as base64, up to MaxImageBytes.
func (s *Service) Read(root, rel string, offset, length int64, as string) (ReadResult, error) {
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
	if length <= 0 || length > MaxReadLength {
		length = MaxReadLength
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
	out := ReadResult{Path: rel, Revision: revisionOf(info), Size: info.Size(), Offset: offset}

	if _, isImage := imageExt[strings.ToLower(path.Ext(rel))]; isImage {
		if info.Size() > MaxImageBytes {
			return ReadResult{}, fmt.Errorf("%w: images are shown up to %d bytes", ErrTooLarge, MaxImageBytes)
		}
		body, err := io.ReadAll(f)
		if err != nil {
			return ReadResult{}, err
		}
		out.Kind, out.Mime, out.Encoding = "image", mimeOf(rel, "image"), "base64"
		out.Offset, out.Length, out.EOF = 0, int64(len(body)), true
		out.Content = base64.StdEncoding.EncodeToString(body)
		return out, nil
	}

	head := make([]byte, sniffBytes)
	n, _ := io.ReadFull(f, head)
	head = head[:n]
	kind := "text"
	if looksBinary(head) {
		kind = "binary"
	}
	out.Kind, out.Mime = kind, mimeOf(rel, kind)

	if kind == "binary" && as != "base64" {
		out.Encoding = "none"
		out.Length, out.EOF = 0, offset >= info.Size()
		return out, nil
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return ReadResult{}, err
	}
	buf := make([]byte, length)
	n, err = io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return ReadResult{}, err
	}
	buf = buf[:n]
	if kind == "text" {
		if offset+int64(n) < info.Size() {
			buf = trimIncompleteTail(buf)
		}
		out.Encoding = "utf-8"
		out.Content = string(buf)
	} else {
		out.Encoding = "base64"
		out.Content = base64.StdEncoding.EncodeToString(buf)
	}
	out.Length = int64(len(buf))
	out.EOF = offset+out.Length >= info.Size()
	return out, nil
}

func gitCmd(ctx context.Context, root string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", root}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C")
	return cmd
}

func isGitRepo(ctx context.Context, root string) bool {
	out, err := gitCmd(ctx, root, "rev-parse", "--is-inside-work-tree").Output()
	return err == nil && strings.TrimSpace(string(out)) == "true"
}

// markIgnored sets Ignored from one `git check-ignore` over the entries.
func markIgnored(ctx context.Context, root string, entries []Entry) {
	if len(entries) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	if !isGitRepo(ctx, root) {
		return
	}
	var in bytes.Buffer
	for _, e := range entries {
		in.WriteString(e.Path)
		in.WriteByte(0)
	}
	cmd := gitCmd(ctx, root, "check-ignore", "-z", "--stdin")
	cmd.Stdin = &in
	out, _ := cmd.Output() // exit 1 means "none ignored"
	ignored := map[string]bool{}
	for _, p := range strings.Split(string(out), "\x00") {
		if p != "" {
			ignored[p] = true
		}
	}
	for i := range entries {
		entries[i].Ignored = ignored[entries[i].Path]
	}
}

// Status is `git status --porcelain=v2`, cached per root for a second.
func (s *Service) Status(ctx context.Context, root string) (StatusResult, error) {
	s.mu.Lock()
	if c, ok := s.statusCache[root]; ok && time.Since(c.at) < statusCacheTTL {
		s.mu.Unlock()
		return c.result, nil
	}
	s.mu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	result := StatusResult{Entries: []StatusEntry{}}
	if isGitRepo(ctx, root) {
		result.IsGitRepo = true
		out, err := gitCmd(ctx, root, "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all").Output()
		if err != nil {
			return StatusResult{}, fmt.Errorf("git status: %w", err)
		}
		result = parsePorcelainV2(out)
		result.IsGitRepo = true
	}
	s.mu.Lock()
	s.statusCache[root] = cachedStatus{at: time.Now(), result: result}
	s.mu.Unlock()
	return result, nil
}

// parsePorcelainV2 reads `git status --porcelain=v2 -z --branch` output.
func parsePorcelainV2(out []byte) StatusResult {
	res := StatusResult{Entries: []StatusEntry{}}
	fields := strings.Split(string(out), "\x00")
	for i := 0; i < len(fields); i++ {
		line := fields[i]
		switch {
		case strings.HasPrefix(line, "# branch.head "):
			res.Branch = strings.TrimPrefix(line, "# branch.head ")
		case strings.HasPrefix(line, "# branch.oid "):
			res.Head = strings.TrimPrefix(line, "# branch.oid ")
		case strings.HasPrefix(line, "1 "):
			// 1 XY sub mH mI mW hH hI path
			parts := strings.SplitN(line, " ", 9)
			if len(parts) == 9 && len(parts[1]) == 2 {
				res.Entries = append(res.Entries, StatusEntry{Path: parts[8], X: parts[1][:1], Y: parts[1][1:]})
			}
		case strings.HasPrefix(line, "2 "):
			// 2 XY sub mH mI mW hH hI Xscore path, then origPath as the next field
			parts := strings.SplitN(line, " ", 10)
			if len(parts) == 10 && len(parts[1]) == 2 {
				e := StatusEntry{Path: parts[9], X: parts[1][:1], Y: parts[1][1:]}
				if i+1 < len(fields) {
					e.OrigPath = fields[i+1]
					i++
				}
				res.Entries = append(res.Entries, e)
			}
		case strings.HasPrefix(line, "u "):
			parts := strings.SplitN(line, " ", 11)
			if len(parts) == 11 && len(parts[1]) == 2 {
				res.Entries = append(res.Entries, StatusEntry{Path: parts[10], X: parts[1][:1], Y: parts[1][1:]})
			}
		case strings.HasPrefix(line, "? "):
			res.Entries = append(res.Entries, StatusEntry{Path: strings.TrimPrefix(line, "? "), X: "?", Y: "?"})
		}
		if len(res.Entries) >= MaxStatusEntries {
			res.Truncated = true
			break
		}
	}
	return res
}

// naturalLess orders names case-insensitively, with digit runs compared as
// numbers ("file2" before "file10").
func naturalLess(a, b string) bool {
	ar, br := []rune(strings.ToLower(a)), []rune(strings.ToLower(b))
	i, j := 0, 0
	for i < len(ar) && j < len(br) {
		if unicode.IsDigit(ar[i]) && unicode.IsDigit(br[j]) {
			si := i
			for i < len(ar) && unicode.IsDigit(ar[i]) {
				i++
			}
			sj := j
			for j < len(br) && unicode.IsDigit(br[j]) {
				j++
			}
			na := strings.TrimLeft(string(ar[si:i]), "0")
			nb := strings.TrimLeft(string(br[sj:j]), "0")
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			if na != nb {
				return na < nb
			}
			continue
		}
		if ar[i] != br[j] {
			return ar[i] < br[j]
		}
		i++
		j++
	}
	if len(ar)-i != len(br)-j {
		return len(ar)-i < len(br)-j
	}
	return a < b
}
