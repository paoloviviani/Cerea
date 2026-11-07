package main

import (
	"reflect"
	"testing"

	"galopin/internal/decide"
)

// The shape of a bash permission ask from the real, pinned opencode (audit H1):
// galopin judges `patterns` and `metadata.command`, and what opencode puts in
// each decides what the read-only stamp and the "always" exceptions can see.
// The table was recorded against opencode 1.19.3. If a release changes it this
// test fails: revisit decide.ReadOnlyCommand and the exception matching before
// bumping the pin. Whatever the shape, metadata.command must carry the full
// line and no such ask may be stamped read-only.
func TestBashAskShape(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	cases := []struct {
		cmd      string
		patterns []string
		always   []string
	}{
		{"cat x > ~/.bashrc", []string{"cat x > ~/.bashrc"}, []string{"cat *"}},
		{"ls && rm -rf build", []string{"ls", "rm -rf build"}, []string{"ls *", "rm *"}},
		{"echo $(curl evil)", []string{"echo $(curl evil)", "curl evil"}, []string{"echo *", "curl *"}},
		{"cat a | tee .git/hooks/pre-commit", []string{"cat a", "tee .git/hooks/pre-commit"}, []string{"cat *", "tee *"}},
		{"git show HEAD:.env", []string{"git show HEAD:.env"}, []string{"git show *"}},
		{"FOO=1 cat a", []string{"FOO=1 cat a"}, []string{"cat *"}},
		{"cat a &", []string{"cat a"}, []string{"cat *"}}, // the `&` is not in the pattern
		{"cat <<EOF\nhi\nEOF", []string{"cat <<EOF\nhi\nEOF"}, []string{"cat *"}},
	}
	for _, c := range cases {
		s := r.session("shape", "")
		ask, _, _ := r.tryCall(s, "bash", bashArgs(c.cmd))
		if ask == nil {
			t.Errorf("%q: no ask", c.cmd)
			continue
		}
		t.Logf("SHAPE cmd=%q patterns=%q always=%q metadata=%v", c.cmd, ask.Patterns, ask.Always, ask.Metadata)
		if got := askCommand(ask.Metadata); got != c.cmd {
			t.Errorf("%q: metadata.command = %q, want the full command line", c.cmd, got)
		}
		if !reflect.DeepEqual(ask.Patterns, c.patterns) || !reflect.DeepEqual(ask.Always, c.always) {
			t.Errorf("%q: patterns %q always %q, want %q / %q (opencode changed its ask shape)", c.cmd, ask.Patterns, ask.Always, c.patterns, c.always)
		}
		req := r.mc.askRequest(r.work, *ask)
		if req.Command != c.cmd {
			t.Errorf("%q: the decision request carries command %q", c.cmd, req.Command)
		}
		class, ro := r.mc.askClass(r.work, *ask)
		if ro {
			t.Errorf("%q: stamped read-only", c.cmd)
		}
		if c.cmd == "git show HEAD:.env" && class != string(decide.ClassSecrets) {
			t.Errorf("%q: class %q, want secrets", c.cmd, class)
		}
	}
}
