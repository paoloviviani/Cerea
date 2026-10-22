// Package protofix loads the shared wire fixtures (agent/protocol-fixtures)
// for galopin's tests. Cerea's server specs read the same files, so a frame
// either implementation stops accepting fails on both sides. Test support
// only: nothing outside *_test.go imports it.
package protofix

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
)

// Fixture is one file: the frame, and what the file says about it.
type Fixture struct {
	// File is the path relative to the fixtures root, slash-separated.
	File string
	Meta Meta
	// Frame is the frame exactly as it travels the wire.
	Frame json.RawMessage
}

// Meta is a fixture's _meta object.
type Meta struct {
	Spec      string `json:"spec"`
	Direction string `json:"direction"` // "M→C" | "C→M"
	Op        string `json:"op"`
	Variant   string `json:"variant"`
	Note      string `json:"note"`
	// EmittedByCurrentGo false marks a shape only an older galopin (or a
	// newer Cerea) produces: it must decode, but is not expected to
	// re-marshal from today's structs.
	EmittedByCurrentGo *bool `json:"emittedByCurrentGo"`
	// RoundTrip false: decode only (a null that Go emits but re-marshals
	// differently, say).
	RoundTrip *bool  `json:"roundTrip"`
	ErrorCode string `json:"errorCode"`
	// Null marks a frame that carries a JSON null somewhere on purpose.
	Null bool `json:"null"`
}

// Emitted reports whether current galopin can produce this frame.
func (m Meta) Emitted() bool { return m.EmittedByCurrentGo == nil || *m.EmittedByCurrentGo }

// Rounds reports whether decode-then-marshal must reproduce the frame.
func (m Meta) Rounds() bool { return m.Emitted() && (m.RoundTrip == nil || *m.RoundTrip) }

// Header is the part of every frame the dispatching needs.
type Header struct {
	Type string `json:"type"`
	OK   *bool  `json:"ok"`
	Op   string `json:"op"`
}

// Head decodes the frame's header.
func (f Fixture) Head(t testing.TB) Header {
	t.Helper()
	var h Header
	if err := json.Unmarshal(f.Frame, &h); err != nil {
		t.Fatalf("%s: %v", f.File, err)
	}
	return h
}

// Dir is the fixtures directory.
func Dir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "protocol-fixtures")
}

// Load reads every fixture, sorted by path.
func Load(t testing.TB) []Fixture {
	t.Helper()
	root := Dir()
	var out []Fixture
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".json") {
			return err
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var raw struct {
			Meta  Meta            `json:"_meta"`
			Frame json.RawMessage `json:"frame"`
		}
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&raw); err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		rel, _ := filepath.Rel(root, path)
		out = append(out, Fixture{File: filepath.ToSlash(rel), Meta: raw.Meta, Frame: raw.Frame})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(out) == 0 {
		t.Fatalf("no fixtures under %s", root)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].File < out[j].File })
	return out
}

// DecodeStrict unmarshals raw into v, refusing any field v does not name.
func DecodeStrict(raw []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return fmt.Errorf("trailing data after the value")
	}
	return nil
}

// Same reports whether two JSON documents are semantically equal (key order
// and number formatting aside), with a readable diff when they are not.
func Same(want, got []byte) error {
	var w, g any
	if err := json.Unmarshal(want, &w); err != nil {
		return err
	}
	if err := json.Unmarshal(got, &g); err != nil {
		return err
	}
	if reflect.DeepEqual(w, g) {
		return nil
	}
	wp, _ := json.MarshalIndent(w, "", " ")
	gp, _ := json.MarshalIndent(g, "", " ")
	return fmt.Errorf("differ\nfixture:\n%s\nre-marshalled:\n%s", wp, gp)
}

// Strip returns the frame with the named top-level keys removed.
func Strip(raw []byte, keys ...string) []byte {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return raw
	}
	for _, k := range keys {
		delete(m, k)
	}
	out, _ := json.Marshal(m)
	return out
}

// Field returns one top-level field of a JSON object.
func Field(raw []byte, key string) json.RawMessage {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	return m[key]
}

// ContainsNull reports whether a JSON document has a null anywhere.
func ContainsNull(raw []byte) bool {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return false
	}
	var walk func(any) bool
	walk = func(v any) bool {
		switch x := v.(type) {
		case nil:
			return true
		case map[string]any:
			for _, e := range x {
				if walk(e) {
					return true
				}
			}
		case []any:
			for _, e := range x {
				if walk(e) {
					return true
				}
			}
		}
		return false
	}
	return walk(v)
}
