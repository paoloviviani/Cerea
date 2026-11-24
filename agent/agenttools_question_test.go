package main

import (
	"errors"
	"strings"
	"testing"

	"galopin/internal/backend"
)

func TestParseAskUserBoundsTheArguments(t *testing.T) {
	good := `{"questions":[{"question":"  Which?  ","header":"` + strings.Repeat("h", 80) + `","options":[{"label":"a","description":"da"},{"label":"b"}],"multiple":true}]}`
	qs, err := parseAskUser([]byte(good))
	if err != nil {
		t.Fatal(err)
	}
	if len(qs) != 1 || qs[0].Question != "Which?" || !qs[0].MultiSelect || len(qs[0].Options) != 2 || qs[0].Options[0].Description != "da" {
		t.Fatalf("parsed %+v", qs)
	}
	if len([]rune(qs[0].Header)) != askMaxHeader {
		t.Errorf("header not cut to %d: %d", askMaxHeader, len([]rune(qs[0].Header)))
	}
	// no options is fine: the person writes the answer
	if qs, err := parseAskUser([]byte(`{"questions":[{"question":"Name?","options":[]}]}`)); err != nil || qs[0].Options == nil {
		t.Fatalf("a free-text question: %v %+v", err, qs)
	}
	opts := strings.Repeat(`{"label":"x"},`, askMaxOptions+1)
	for name, bad := range map[string]string{
		"not json":      `nope`,
		"none":          `{"questions":[]}`,
		"too many":      `{"questions":[` + strings.Repeat(`{"question":"q","options":[]},`, askMaxQuestions) + `{"question":"q","options":[]}]}`,
		"empty text":    `{"questions":[{"question":"  ","options":[]}]}`,
		"many options":  `{"questions":[{"question":"q","options":[` + strings.TrimSuffix(opts, ",") + `]}]}`,
		"empty label":   `{"questions":[{"question":"q","options":[{"label":" "}]}]}`,
		"wrong q shape": `{"questions":"which?"}`,
	} {
		_, err := parseAskUser([]byte(bad))
		var ref *backend.ToolRefusal
		if err == nil || !errors.As(err, &ref) {
			t.Errorf("%s: want a refusal, got %v", name, err)
		}
	}
}

func TestFormatAskAnswers(t *testing.T) {
	qs := []backend.QuestionItem{{Question: "DB?"}, {Question: "Cache?"}, {Question: "Third?"}}
	got := formatAskAnswers(qs, [][]string{{"postgres"}, {"redis", "memcached"}})
	for _, want := range []string{"The person answered:", "1. DB? -> postgres", "2. Cache? -> redis; memcached", "3. Third? -> (no answer)"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
}

func TestAskUserIsAnMCPToolWithAnObjectSchema(t *testing.T) {
	for _, tl := range mcpTools {
		if tl.Name == "ask_user" {
			if !strings.Contains(string(tl.Schema), `"questions"`) {
				t.Errorf("schema = %s", tl.Schema)
			}
			return
		}
	}
	t.Fatal("ask_user is not in the MCP tools")
}
