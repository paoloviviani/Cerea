package opencode

import (
	"strings"
	"testing"

	"galopin/internal/backend"
)

func TestPromptName(t *testing.T) {
	for in, want := range map[string]string{
		"":                      "",
		"   \n\t ":              "",
		"fix the build":         "fix the build",
		"  fix\n the   build  ": "fix the build",
		"Please refactor the authentication middleware so tokens rotate": "Please refactor the authentication middleware so…",
		"Explain this, please.": "Explain this, please",
		strings.Repeat("a", 60): strings.Repeat("a", 48) + "…",
	} {
		if got := promptName(in); got != want {
			t.Errorf("promptName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNameUntitled(t *testing.T) {
	b := &Backend{overlay: map[string]sessionOverlay{"s1": {Name: "fix the build"}, "c1": {Name: "x"}}}
	cases := []struct {
		in   backend.Session
		want string
	}{
		{backend.Session{ID: "s1"}, "fix the build"},
		{backend.Session{ID: "s1", Title: "Build fix"}, "Build fix"},
		{backend.Session{ID: "s2"}, ""},
		{backend.Session{ID: "c1", ParentID: "s1"}, ""},
	}
	for _, c := range cases {
		s := c.in
		b.nameUntitled(&s)
		if s.Title != c.want {
			t.Errorf("%+v: title %q, want %q", c.in, s.Title, c.want)
		}
	}
}

func TestSubagentTitleWithoutDescription(t *testing.T) {
	if got := subagentTitle("", "p", "general"); got != "(@general subagent)" {
		t.Errorf("got %q", got)
	}
	if got := subagentTitle("Inspect", "p", "general"); got != "Inspect (@general subagent)" {
		t.Errorf("got %q", got)
	}
}
