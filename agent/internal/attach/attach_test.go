package attach

import (
	"bytes"
	"testing"
)

func TestPutGetDedupAndOwnership(t *testing.T) {
	s := New(1 << 20)
	img := bytes.Repeat([]byte{7}, 100)
	a, ok := s.Put("s1", Ref{Mime: "image/png"}, img)
	if !ok || a.SHA256 != Sum(img) || a.Size != 100 {
		t.Fatalf("put: %+v %v", a, ok)
	}
	s.Put("s2", Ref{Mime: "image/png"}, img)
	if s.used != 100 {
		t.Fatalf("identical bytes must dedupe, used=%d", s.used)
	}
	if _, data, ok := s.Get("s1", a.SHA256); !ok || !bytes.Equal(data, img) {
		t.Fatal("owner must read its image")
	}
	if _, _, ok := s.Get("s3", a.SHA256); ok {
		t.Fatal("a session that never produced the sha must not read it (the sha is not a capability)")
	}
}

func TestEvictionKeepsRef(t *testing.T) {
	s := New(250)
	var shas []string
	for i := 0; i < 4; i++ {
		r, _ := s.Put("s", Ref{Mime: "image/png", CallID: "c"}, bytes.Repeat([]byte{byte(i + 1)}, 100))
		shas = append(shas, r.SHA256)
	}
	if _, _, ok := s.Get("s", shas[0]); ok {
		t.Fatal("oldest image must be evicted over the cap")
	}
	r, ok := s.Ref("s", shas[0])
	if !ok || r.CallID != "c" {
		t.Fatalf("an evicted image keeps its reference for a re-read: %+v %v", r, ok)
	}
	if _, _, ok := s.Get("s", shas[3]); !ok {
		t.Fatal("newest image must remain")
	}
}

func TestOversizeAndEmptyRefused(t *testing.T) {
	s := New(0)
	if _, ok := s.Put("s", Ref{}, nil); ok {
		t.Fatal("empty kept")
	}
	if _, ok := s.Put("s", Ref{}, make([]byte, MaxImageBytes+1)); ok {
		t.Fatal("oversize kept")
	}
}

func TestForget(t *testing.T) {
	s := New(0)
	r, _ := s.Put("s", Ref{}, []byte("x"))
	s.Forget("s")
	if _, ok := s.Ref("s", r.SHA256); ok {
		t.Fatal("forgotten session keeps refs")
	}
}
