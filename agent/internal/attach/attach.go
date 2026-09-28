// Package attach is galopin's bounded, content-addressed store for the
// images a tool call produced (PROTOCOL.md §7 tool part `attachments`,
// §6 session.attachment). The bytes never ride the event stream: a part
// carries {sha256, mime, size} and Cerea asks for the bytes by sha, one
// image per request, when a person's browser actually needs it.
//
// The store is an LRU keyed by sha256 (identical images dedupe), capped in
// total bytes. Evicting an image keeps its small reference, so a backend that
// still holds the original (opencode's own transcript) can be asked to
// re-read it; one that does not (ACP: memory only) answers "no longer on
// the machine". A reference is per session: the sha in a request is never a
// capability, the session that owns it must have produced it.
package attach

import (
	"container/list"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"sync"
)

const (
	// DefaultMaxBytes bounds the bytes held across all sessions.
	DefaultMaxBytes = 64 << 20
	// MaxImageBytes is the largest single image kept and served, matching
	// files.read's image cap (PROTOCOL.md §9.3).
	MaxImageBytes = 8 << 20
	// MaxPerToolCall caps the attachments listed on one tool part.
	MaxPerToolCall = 8
	// maxRefs bounds the remembered references (a few hundred bytes each).
	maxRefs = 20000
)

// Ref is what a session remembers about one image: enough to list it on the
// wire and, for a backend that can, to find it again after eviction.
type Ref struct {
	SHA256   string
	Mime     string
	Size     int
	Filename string

	// Where the image came from in the backend's own transcript, for a
	// re-read after eviction. Empty for a backend that cannot re-read.
	MessageID string
	PartID    string
	CallID    string
}

type refKey struct{ session, sha string }

type entry struct {
	sha  string
	data []byte
}

// Store is safe for concurrent use.
type Store struct {
	mu       sync.Mutex
	max      int64
	used     int64
	lru      *list.List // of *entry, front = most recent
	items    map[string]*list.Element
	refs     map[refKey]Ref
	refOrder []refKey
}

// New returns a Store holding at most maxBytes (DefaultMaxBytes when <= 0).
func New(maxBytes int64) *Store {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	return &Store{
		max:   maxBytes,
		lru:   list.New(),
		items: map[string]*list.Element{},
		refs:  map[refKey]Ref{},
	}
}

// Sum is the lowercase hex sha256 of data.
func Sum(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

// Put stores data for sessionID and returns its Ref (SHA256 and Size filled
// in). ok is false for an empty or oversized image, which is not kept.
func (s *Store) Put(sessionID string, ref Ref, data []byte) (Ref, bool) {
	if len(data) == 0 || len(data) > MaxImageBytes {
		return Ref{}, false
	}
	ref.SHA256 = Sum(data)
	ref.Size = len(data)
	s.mu.Lock()
	defer s.mu.Unlock()
	if el, ok := s.items[ref.SHA256]; ok {
		s.lru.MoveToFront(el)
	} else {
		s.items[ref.SHA256] = s.lru.PushFront(&entry{sha: ref.SHA256, data: data})
		s.used += int64(len(data))
		for s.used > s.max && s.lru.Len() > 1 {
			back := s.lru.Back()
			e := back.Value.(*entry)
			s.lru.Remove(back)
			delete(s.items, e.sha)
			s.used -= int64(len(e.data))
		}
	}
	k := refKey{sessionID, ref.SHA256}
	if _, ok := s.refs[k]; !ok {
		s.refOrder = append(s.refOrder, k)
		if len(s.refOrder) > maxRefs {
			delete(s.refs, s.refOrder[0])
			s.refOrder = s.refOrder[1:]
		}
	}
	s.refs[k] = ref
	return ref, true
}

// Ref reports what sessionID knows about sha, whether or not the bytes are
// still held.
func (s *Store) Ref(sessionID, sha string) (Ref, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.refs[refKey{sessionID, sha}]
	return r, ok
}

// Get returns the bytes of an image sessionID owns, if still held. A sha the
// session never produced is not found even when another session holds the
// same bytes.
func (s *Store) Get(sessionID, sha string) (Ref, []byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.refs[refKey{sessionID, sha}]
	if !ok {
		return Ref{}, nil, false
	}
	el, ok := s.items[sha]
	if !ok {
		return r, nil, false
	}
	s.lru.MoveToFront(el)
	return r, el.Value.(*entry).data, true
}

// Forget drops sessionID's references (a deleted session). The bytes age out
// of the LRU on their own.
func (s *Store) Forget(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := s.refOrder[:0]
	for _, k := range s.refOrder {
		if k.session == sessionID {
			delete(s.refs, k)
			continue
		}
		kept = append(kept, k)
	}
	s.refOrder = kept
}

// ParseDataURL decodes a base64 data: URL ("data:image/png;base64,…").
// Anything else (no base64, a non-data URL) is not ok.
func ParseDataURL(u string) (mime string, data []byte, ok bool) {
	rest, found := strings.CutPrefix(u, "data:")
	if !found {
		return "", nil, false
	}
	meta, payload, found := strings.Cut(rest, ",")
	if !found {
		return "", nil, false
	}
	parts := strings.Split(meta, ";")
	if len(parts) < 2 || parts[len(parts)-1] != "base64" {
		return "", nil, false
	}
	data, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return "", nil, false
	}
	return strings.ToLower(strings.TrimSpace(parts[0])), data, true
}
