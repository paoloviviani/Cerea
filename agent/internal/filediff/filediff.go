// Package filediff is galopin's own record of what an agent's edit tool calls
// changed, independent of the engine that ran them (ADR 0108 item 1).
//
// When an edit-class tool call starts, the files it names are snapshotted;
// when it finishes they are read again, and the difference becomes a
// backend.FileDiff, the shape session.diff already carries. An engine that
// reports its own diffs (opencode) keeps them; this is the source for engines
// whose events have none (ACP), and the fallback for a workspace git cannot
// describe.
//
// Bounds: text files up to MaxTextBytes, MaxFilesPerCall files per call,
// MaxSessionFiles per session. Binary and oversize files are reported as
// changed with a marker instead of content. A path the machine protects (the
// credential stores, galopin's own state, .env files) is never read: its
// change is detected from its size and modification time alone and shown
// without content.
//
// Per-call snapshots live until the turn ends (EndTurn) and are never written
// to disk. The session's record (the first before and the latest after, per
// file) is held in memory and dropped with the session (Forget).
package filediff

import (
	"bytes"
	"crypto/sha256"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"galopin/internal/backend"
	"galopin/internal/checkout"
)

// Limits.
const (
	MaxTextBytes    = 1 << 20
	MaxFilesPerCall = 20
	MaxSessionFiles = 50
)

// Markers shown in place of content, in the same style the checkout pane uses.
const (
	MarkerBinary    = "(binary file)"
	MarkerOversize  = "(file too large to show)"
	MarkerProtected = "(content not shown)"
)

// Protect reports whether a file's content must never be read into a diff.
// workspace is the session's workspace; path is absolute.
type Protect func(workspace, path string) bool

type snap struct {
	exists    bool
	kind      snapKind
	text      string
	hash      [sha256.Size]byte
	size      int64
	mtimeNano int64
}

type snapKind int

const (
	kindText snapKind = iota
	kindBinary
	kindOversize
	kindProtected
)

func (s snap) same(o snap) bool {
	if s.exists != o.exists {
		return false
	}
	if !s.exists {
		return true
	}
	if s.kind != o.kind {
		return false
	}
	switch s.kind {
	case kindText:
		return s.text == o.text
	case kindBinary:
		return s.hash == o.hash
	default: // oversize, protected: never hashed, so size and time decide
		return s.size == o.size && s.mtimeNano == o.mtimeNano
	}
}

func take(workspace, path string, protect Protect) snap {
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return snap{}
	}
	s := snap{exists: true, size: fi.Size(), mtimeNano: fi.ModTime().UnixNano()}
	if protect != nil && protect(workspace, path) {
		s.kind = kindProtected
		return s
	}
	if fi.Size() > MaxTextBytes {
		s.kind = kindOversize
		return s
	}
	f, err := os.Open(path)
	if err != nil {
		return snap{}
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, MaxTextBytes+1))
	if err != nil {
		return snap{}
	}
	if len(data) > MaxTextBytes {
		s.kind = kindOversize
		return s
	}
	if bytes.IndexByte(data, 0) >= 0 {
		s.kind = kindBinary
		s.hash = sha256.Sum256(data)
		return s
	}
	s.text = string(data)
	return s
}

type fileRec struct {
	base, last snap
	seq        int
}

type call struct {
	workspace string
	before    map[string]snap
}

type sessionRec struct {
	workspace string
	calls     map[string]*call
	files     map[string]*fileRec
	seq       int
}

// Tracker records edits per session. The zero value is not usable; use New.
type Tracker struct {
	protect Protect
	mu      sync.Mutex
	sess    map[string]*sessionRec
}

// New returns a Tracker; protect may be nil (nothing protected).
func New(protect Protect) *Tracker {
	return &Tracker{protect: protect, sess: map[string]*sessionRec{}}
}

func (t *Tracker) rec(sessionID string) *sessionRec {
	r := t.sess[sessionID]
	if r == nil {
		r = &sessionRec{calls: map[string]*call{}, files: map[string]*fileRec{}}
		t.sess[sessionID] = r
	}
	return r
}

// Begin snapshots paths (resolved against workspace, `~/` against home) for
// the call callID, before it runs. A second Begin for the same call and path
// keeps the first snapshot.
func (t *Tracker) Begin(sessionID, callID, workspace string, paths []string) {
	if t == nil || sessionID == "" || callID == "" {
		return
	}
	abs := Resolve(workspace, paths)
	if len(abs) == 0 {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	r := t.rec(sessionID)
	r.workspace = workspace
	c := r.calls[callID]
	if c == nil {
		c = &call{workspace: workspace, before: map[string]snap{}}
		r.calls[callID] = c
	}
	for _, p := range abs {
		if _, ok := c.before[p]; ok || len(c.before) >= MaxFilesPerCall {
			continue
		}
		c.before[p] = take(workspace, p, t.protect)
	}
}

// End reads the call's files again and records what changed. A call that was
// never begun (or whose turn already ended) records nothing.
func (t *Tracker) End(sessionID, callID string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	r := t.sess[sessionID]
	if r == nil {
		return
	}
	c := r.calls[callID]
	if c == nil {
		return
	}
	delete(r.calls, callID)
	for p, before := range c.before {
		after := take(c.workspace, p, t.protect)
		fr := r.files[p]
		if fr == nil {
			if before.same(after) {
				continue
			}
			if len(r.files) >= MaxSessionFiles {
				continue
			}
			r.seq++
			fr = &fileRec{base: before, seq: r.seq}
			r.files[p] = fr
		}
		fr.last = after
	}
}

// EndTurn drops the session's unfinished per-call snapshots.
func (t *Tracker) EndTurn(sessionID string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if r := t.sess[sessionID]; r != nil {
		r.calls = map[string]*call{}
	}
}

// Forget drops everything held for the session.
func (t *Tracker) Forget(sessionID string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	delete(t.sess, sessionID)
	t.mu.Unlock()
}

// Diffs is the session's changed files, oldest change first. A file edited and
// then restored is not listed. Paths are relative to the workspace when they
// are inside it, absolute otherwise.
func (t *Tracker) Diffs(sessionID string) []backend.FileDiff {
	out := []backend.FileDiff{}
	if t == nil {
		return out
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	r := t.sess[sessionID]
	if r == nil {
		return out
	}
	type item struct {
		seq int
		fd  backend.FileDiff
	}
	var items []item
	for p, fr := range r.files {
		if fr.base.same(fr.last) {
			continue
		}
		items = append(items, item{fr.seq, render(r.workspace, p, fr.base, fr.last)})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].seq < items[j].seq })
	for _, it := range items {
		out = append(out, it.fd)
	}
	return out
}

func display(workspace, abs string) string {
	if workspace != "" {
		if rel, err := filepath.Rel(workspace, abs); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return filepath.ToSlash(rel)
		}
	}
	return abs
}

func shown(s snap) string {
	switch s.kind {
	case kindBinary:
		return MarkerBinary
	case kindOversize:
		return MarkerOversize
	case kindProtected:
		return MarkerProtected
	}
	return s.text
}

func render(workspace, abs string, before, after snap) backend.FileDiff {
	fd := backend.FileDiff{Path: display(workspace, abs), Status: backend.FileModified}
	switch {
	case !before.exists:
		fd.Status = backend.FileAdded
	case !after.exists:
		fd.Status = backend.FileDeleted
	}
	if before.exists {
		fd.Before = shown(before)
	}
	if after.exists {
		fd.After = shown(after)
	}
	if before.kind == kindText && after.kind == kindText || (!before.exists && after.kind == kindText) || (!after.exists && before.kind == kindText) {
		fd.Additions, fd.Deletions = checkout.LineDelta(fd.Before, fd.After)
	}
	return fd
}

// Resolve makes paths absolute the way a permission request's patterns are
// read: `~/x` against the home directory, a relative path against workspace.
// Empty and duplicate paths are dropped; at most MaxFilesPerCall are kept.
func Resolve(workspace string, paths []string) []string {
	home, _ := os.UserHomeDir()
	seen := map[string]bool{}
	var out []string
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		switch {
		case p == "~" || strings.HasPrefix(p, "~/"):
			if home == "" {
				continue
			}
			p = filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(p, "~"), "/"))
		case !filepath.IsAbs(p):
			if workspace == "" {
				continue
			}
			p = filepath.Join(workspace, p)
		}
		p = filepath.Clean(p)
		if seen[p] || len(out) >= MaxFilesPerCall {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	return out
}
