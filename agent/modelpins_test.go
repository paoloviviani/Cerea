package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The pin scanner (A2): every config source opencode merges — the JSON(C)
// files and both agent-directory spellings, in the user's config dir and
// under OPENCODE_CONFIG_DIR — with .md frontmatter newly parsed. A pin is
// flagged unless its provider is pystino (or opencode when free models are
// allowed).

func writePinFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestScanModelPinDirs(t *testing.T) {
	root := t.TempDir()
	cfg := filepath.Join(root, "opencode")
	writePinFile(t, filepath.Join(cfg, "opencode.json"), `{
		// a comment, to prove the JSONC reader runs
		"model": "cortecs/some-model",
		"small_model": "pystino/small",
		"agent": {"build": {"model": "other/thing"}, "plan": {"model": "pystino/plan"}},
	}`)
	writePinFile(t, filepath.Join(cfg, "agents", "build.md"), "---\nmodel: cortecs/deepseek-v4-flash-0731\n---\n\nYou build.\n")
	writePinFile(t, filepath.Join(cfg, "agent", "plan.md"), "---\nmodel: cortecs/glm-5.3\n---\n\nYou plan.\n")
	writePinFile(t, filepath.Join(cfg, "agents", "ok.md"), "---\nmodel: pystino/coder\n---\n\nFine.\n")
	writePinFile(t, filepath.Join(cfg, "agents", "plain.md"), "No frontmatter at all.\n")

	pins := scanModelPinDirs([]string{cfg}, false)
	got := map[string]string{}
	for _, p := range pins {
		got[p.Key] = p.Model
		if !strings.Contains(p.Warning(), p.File) || !strings.Contains(p.Warning(), p.Model) {
			t.Errorf("warning names neither file nor model: %q", p.Warning())
		}
	}
	want := []string{"model", "agent.build.model"}
	for _, k := range want {
		if _, ok := got[k]; !ok {
			t.Errorf("missing pin for %s (got %v)", k, got)
		}
	}
	if len(pins) != 4 { // top-level model, agent.build.model, agents/build.md, agent/plan.md
		t.Errorf("pins = %v, want exactly the 4 outside Pystino", pins)
	}
	for _, p := range pins {
		if p.File == "" || p.Key == "" || p.Model == "" {
			t.Errorf("pin lacks file/key/model: %+v", p)
		}
	}
	// Pystino pins, the bare file and the missing frontmatter stay quiet.
	for _, p := range pins {
		if strings.HasPrefix(p.Model, "pystino/") {
			t.Errorf("a Pystino pin is flagged: %+v", p)
		}
	}

	// With free models allowed, the opencode provider's own models pass and
	// third providers still do not.
	writePinFile(t, filepath.Join(cfg, "opencode.jsonc"), `{"model": "opencode/free-model"}`)
	if pins := scanModelPinDirs([]string{cfg}, true); len(pins) != 4 {
		t.Errorf("free models allowed: pins = %v, want the opencode pin dropped and nothing else changed", pins)
	}
	if pins := scanModelPinDirs([]string{cfg}, false); len(pins) != 5 {
		t.Errorf("free models off: pins = %v, want the opencode pin flagged too", pins)
	}

	// Missing and broken sources contribute nothing, never an error.
	broken := filepath.Join(root, "broken")
	writePinFile(t, filepath.Join(broken, "opencode.json"), `{"model": `)
	writePinFile(t, filepath.Join(broken, "agents", "x.md"), "---\nmodel: [unclosed\n---\n")
	if pins := scanModelPinDirs([]string{broken, filepath.Join(root, "absent")}, false); len(pins) != 0 {
		t.Errorf("broken sources: pins = %v, want none", pins)
	}
}

func TestFrontmatterModel(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]string{
		"quoted.md":   "---\nmodel: \"cortecs/x\"\n---\n",
		"single.md":   "---\nmodel: 'cortecs/x'\n---\n",
		"spaced.md":   "---\nmodel:   cortecs/x  \n---\n",
		"nested.md":   "---\npermissions:\n  model: cortecs/x\n---\n", // nested: not a pin
		"nofence.md":  "model: cortecs/x\n",
		"nomodel.md":  "---\ndescription: y\n---\n",
		"nounterm.md": "---\nmodel: cortecs/x\n",
	}
	want := map[string]string{
		"quoted.md": "cortecs/x", "single.md": "cortecs/x", "spaced.md": "cortecs/x",
		"nested.md": "", "nofence.md": "", "nomodel.md": "", "nounterm.md": "cortecs/x",
	}
	for name, body := range cases {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		got, err := frontmatterModel(path)
		if err != nil {
			t.Errorf("%s: %v", name, err)
		}
		if got != want[name] {
			t.Errorf("%s = %q, want %q", name, got, want[name])
		}
	}
}

func TestPinProviderAllowed(t *testing.T) {
	for _, tc := range []struct {
		model string
		free  bool
		want  bool
	}{
		{"pystino/coder", false, true},
		{"pystino", false, true},
		{"opencode/free", false, false},
		{"opencode/free", true, true},
		{"opencode", true, true},
		{"cortecs/x", false, false},
		{"cortecs/x", true, false},
	} {
		if got := pinProviderAllowed(tc.model, tc.free); got != tc.want {
			t.Errorf("pinProviderAllowed(%q, free=%v) = %v, want %v", tc.model, tc.free, got, tc.want)
		}
	}
}
