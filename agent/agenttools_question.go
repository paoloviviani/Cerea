package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"galopin/internal/backend"
)

// ask_user: the MCP route's question tool for an agent with no native one (the ACP
// engines: Vibe, goose). It raises the same question card opencode's own question tool
// does (question.asked, answered with question.reply) and hands the person's answers back
// to the agent as the tool's result. opencode keeps its native tool; this is not
// installed there.

const (
	askMaxQuestions = 4
	askMaxOptions   = 8
	askMaxText      = 600
	askMaxHeader    = 30
	askMaxLabel     = 100
	askMaxDesc      = 300
)

func askClip(s string, n int) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// parseAskUser reads and bounds the tool's arguments.
func parseAskUser(raw []byte) ([]backend.QuestionItem, error) {
	var a struct {
		Questions []struct {
			Question string `json:"question"`
			Header   string `json:"header"`
			Options  []struct {
				Label       string `json:"label"`
				Description string `json:"description"`
			} `json:"options"`
			Multiple bool `json:"multiple"`
		} `json:"questions"`
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, refuse("questions must be a list of {question, header, options, multiple}")
	}
	if len(a.Questions) == 0 || len(a.Questions) > askMaxQuestions {
		return nil, refuse("ask one to %d questions", askMaxQuestions)
	}
	out := make([]backend.QuestionItem, 0, len(a.Questions))
	for i, q := range a.Questions {
		text := askClip(q.Question, askMaxText)
		if text == "" {
			return nil, refuse("question %d has no text", i+1)
		}
		if len(q.Options) > askMaxOptions {
			return nil, refuse("question %d has more than %d options", i+1, askMaxOptions)
		}
		item := backend.QuestionItem{Question: text, Header: askClip(q.Header, askMaxHeader), MultiSelect: q.Multiple, Options: []backend.QuestionOption{}}
		for _, o := range q.Options {
			label := askClip(o.Label, askMaxLabel)
			if label == "" {
				return nil, refuse("an option of question %d has no label", i+1)
			}
			item.Options = append(item.Options, backend.QuestionOption{Label: label, Description: askClip(o.Description, askMaxDesc)})
		}
		out = append(out, item)
	}
	return out, nil
}

// askUser implements ask_user: it holds the call until the person answers or dismisses.
func (at *agentTools) askUser(ctx context.Context, tc *toolCaller, call backend.ToolCall) (string, error) {
	host, ok := at.mc.back.(backend.QuestionHost)
	if !ok {
		return "", refuse("this agent cannot ask the person questions through galopin")
	}
	qs, err := parseAskUser(call.Args)
	if err != nil {
		return "", err
	}
	answers, err := host.AskQuestions(ctx, tc.dir, tc.session.ID, qs)
	if err != nil {
		if errors.Is(err, backend.ErrQuestionTimeout) {
			return "", refuse("not answered yet: the person did not reply in time and the question was withdrawn; ask again if you still need it, or go on with the safest reading")
		}
		if errors.Is(err, backend.ErrQuestionPending) {
			return "", refuse("a question of yours is already waiting for the person; wait for it to be answered before asking another")
		}
		if errors.Is(err, backend.ErrQuestionDismissed) {
			return "", refuse("the person dismissed the question without answering; go on with the safest reading, or stop and say what you need")
		}
		return "", err
	}
	return formatAskAnswers(qs, answers), nil
}

// formatAskAnswers is the tool's result: each question with the answer given.
func formatAskAnswers(qs []backend.QuestionItem, answers [][]string) string {
	var b strings.Builder
	b.WriteString("The person answered:\n")
	for i, q := range qs {
		var given []string
		if i < len(answers) {
			given = answers[i]
		}
		ans := strings.Join(given, "; ")
		if ans == "" {
			ans = "(no answer)"
		}
		fmt.Fprintf(&b, "%d. %s -> %s\n", i+1, q.Question, ans)
	}
	return b.String()
}
