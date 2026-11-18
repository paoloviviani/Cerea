package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
)

// These tests cover what the generic adapter does with each stable ACP
// capability, advertised and not (agent/PROTOCOL.md §2), against the scripted
// fake agent (acp_test.go).

func withCaps(f func(caps map[string]any)) func(*fakeAgent) {
	return func(fa *fakeAgent) { fa.capsFn = f }
}

func sessCaps(caps map[string]any) map[string]any {
	return caps["sessionCapabilities"].(map[string]any)
}

func newBackend(t *testing.T, setup ...func(*fakeAgent)) (*Backend, *fakeAgent) {
	t.Helper()
	return newTestBackendCfg(t, false, func(*Config) {}, setup...)
}

// ---- 1. session/list

func TestListSessionsPagesAndFiltersByCwd(t *testing.T) {
	hook := func(fa *fakeAgent, id json.RawMessage, method string, p map[string]any) bool {
		if method != "session/list" {
			return false
		}
		if getStr(p, "cursor") == "" {
			fa.respond(id, map[string]any{"sessions": []any{
				map[string]any{"sessionId": "a", "cwd": "/w", "title": "From the terminal", "updatedAt": "2026-11-01T10:00:00Z"},
				map[string]any{"sessionId": "other", "cwd": "/elsewhere"},
			}, "nextCursor": "page2"})
			return true
		}
		fa.respond(id, map[string]any{"sessions": []any{map[string]any{"sessionId": "b", "cwd": "/w/"}}})
		return true
	}
	b, fa := newBackend(t, func(fa *fakeAgent) { fa.hook = hook })
	got, err := b.ListSessions(context.Background(), "/w")
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]backend.Session{}
	for _, s := range got {
		ids[s.ID] = s
	}
	if len(ids) != 2 || ids["a"].Title != "From the terminal" || ids["b"].ID == "" {
		t.Fatalf("sessions = %+v", got)
	}
	if !ids["a"].UpdatedAt.Equal(time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)) {
		t.Errorf("updatedAt = %v", ids["a"].UpdatedAt)
	}
	calls := fa.called("session/list")
	if len(calls) != 2 || getStr(calls[0], "cwd") != "/w" || getStr(calls[1], "cursor") != "page2" {
		t.Errorf("session/list calls = %v", calls)
	}
}

func TestListSessionsNotAdvertisedUsesTheRegistry(t *testing.T) {
	b, fa := newBackend(t, withCaps(func(c map[string]any) { delete(sessCaps(c), "list") }))
	ctx := context.Background()
	s, err := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{Title: "mine"})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := b.ListSessions(ctx, "/w")
	if len(got) != 1 || got[0].ID != s.ID {
		t.Fatalf("sessions = %+v", got)
	}
	if n := len(fa.called("session/list")); n != 0 {
		t.Errorf("session/list called %d times though not advertised", n)
	}
}

func TestSessionInfoUpdateRetitlesTheSession(t *testing.T) {
	b, fa := newBackend(t)
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{})
	ch, _ := b.Subscribe(ctx)
	fa.update(s.ID, map[string]any{"sessionUpdate": "session_info_update", "title": "Generated title", "updatedAt": "2026-11-02T00:00:00Z"})
	evs := drainEvents(t, ch, s.ID, 3*time.Second, func(e backend.Event) bool { return e.Kind == backend.EventSession })
	if got := evs[len(evs)-1].Session.Title; got != "Generated title" {
		t.Errorf("title = %q", got)
	}
}

// ---- delete / close

func TestDeleteSessionCallsDeleteWhenAdvertisedAndHidesItWhenNot(t *testing.T) {
	list := func(fa *fakeAgent, id json.RawMessage, method string, p map[string]any) bool {
		if method == "session/list" {
			fa.respond(id, map[string]any{"sessions": []any{map[string]any{"sessionId": "old", "cwd": "/w"}}})
			return true
		}
		return false
	}
	// advertised: session/close then session/delete reach the agent
	b, fa := newBackend(t, func(fa *fakeAgent) {
		fa.hook = list
		fa.capsFn = func(c map[string]any) { sessCaps(c)["delete"] = map[string]any{} }
	})
	ctx := context.Background()
	if _, err := b.ListSessions(ctx, "/w"); err != nil {
		t.Fatal(err)
	}
	if err := b.DeleteSession(ctx, "/w", "old"); err != nil {
		t.Fatal(err)
	}
	if len(fa.called("session/delete")) != 1 || len(fa.called("session/close")) != 1 {
		t.Errorf("delete/close calls = %d/%d", len(fa.called("session/delete")), len(fa.called("session/close")))
	}
	// not advertised: no delete call, but the session is not listed again
	b2, fa2 := newBackend(t, func(fa *fakeAgent) { fa.hook = list })
	_, _ = b2.ListSessions(ctx, "/w")
	_ = b2.DeleteSession(ctx, "/w", "old")
	got, _ := b2.ListSessions(ctx, "/w")
	if len(got) != 0 {
		t.Errorf("a deleted session came back: %+v", got)
	}
	if len(fa2.called("session/delete")) != 0 {
		t.Error("session/delete called though not advertised")
	}
}

// ---- 2. load / resume

func TestOpeningAListedSessionUsesLoadForHistory(t *testing.T) {
	b, fa := newBackend(t, func(fa *fakeAgent) {
		fa.replay = []map[string]any{
			{"sessionUpdate": "user_message_chunk", "messageId": "u1", "content": map[string]any{"type": "text", "text": "hi"}},
			{"sessionUpdate": "agent_message_chunk", "messageId": "a1", "content": map[string]any{"type": "text", "text": "hello"}},
		}
	})
	tr, err := b.Transcript(context.Background(), "/w", "ext-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(tr.Messages) != 2 {
		t.Fatalf("messages = %d, want the replayed 2", len(tr.Messages))
	}
	if len(fa.called("session/load")) != 1 || len(fa.called("session/resume")) != 0 {
		t.Errorf("load/resume = %d/%d", len(fa.called("session/load")), len(fa.called("session/resume")))
	}
}

func TestOpeningWithoutLoadFallsBackToResume(t *testing.T) {
	b, fa := newBackend(t, withCaps(func(c map[string]any) { c["loadSession"] = false }))
	tr, err := b.Transcript(context.Background(), "/w", "ext-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(tr.Messages) != 0 {
		t.Errorf("messages = %d, want none (resume replays nothing)", len(tr.Messages))
	}
	if len(fa.called("session/resume")) != 1 || len(fa.called("session/load")) != 0 {
		t.Errorf("resume/load = %d/%d", len(fa.called("session/resume")), len(fa.called("session/load")))
	}
	// a second look is the cached state, not another call
	_, _ = b.Transcript(context.Background(), "/w", "ext-1")
	if len(fa.called("session/resume")) != 1 {
		t.Error("resumed twice")
	}
}

func TestNeitherLoadNorResumeLeavesTheSessionAlone(t *testing.T) {
	b, fa := newBackend(t, withCaps(func(c map[string]any) {
		c["loadSession"] = false
		delete(sessCaps(c), "resume")
	}))
	if _, err := b.Transcript(context.Background(), "/w", "ext-1"); err != nil {
		t.Fatal(err)
	}
	if len(fa.called("session/load"))+len(fa.called("session/resume")) != 0 {
		t.Error("an unadvertised method was called")
	}
}

func TestPromptOnAListedSessionResumesItFirst(t *testing.T) {
	b, fa := newBackend(t)
	ctx := context.Background()
	if err := b.Prompt(ctx, "/w", "ext-1", backend.Prompt{Text: "go on"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-fa.promptReqs:
	case <-time.After(3 * time.Second):
		t.Fatal("no prompt")
	}
	calls := fa.called("session/resume")
	if len(calls) != 1 || getStr(calls[0], "sessionId") != "ext-1" || getStr(calls[0], "cwd") != "/w" {
		t.Fatalf("resume calls = %v", calls)
	}
	if len(fa.called("session/load")) != 0 {
		t.Error("loaded though resume was advertised")
	}
}

func TestPromptOnASessionCreatedHereDoesNotReopenIt(t *testing.T) {
	b, fa := newBackend(t)
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{})
	_ = b.Prompt(ctx, "/w", s.ID, backend.Prompt{Text: "x"})
	<-fa.promptReqs
	if len(fa.called("session/resume"))+len(fa.called("session/load")) != 0 {
		t.Error("reopened a live session")
	}
}

func TestAgentRestartReopensOnNextPrompt(t *testing.T) {
	b, fa := newBackend(t)
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{})
	b.processStarted() // a new agent process: it holds nothing
	_ = b.Prompt(ctx, "/w", s.ID, backend.Prompt{Text: "x"})
	<-fa.promptReqs
	if len(fa.called("session/resume")) != 1 {
		t.Errorf("resume calls = %d, want 1", len(fa.called("session/resume")))
	}
}

// ---- 3. modes, models, config options

func configOptionsResult(mode, model string) map[string]any {
	return map[string]any{"configOptions": []any{
		map[string]any{"id": "perm", "name": "Mode", "category": "mode", "type": "select", "currentValue": mode, "options": []any{
			map[string]any{"value": "default", "name": "Default"}, map[string]any{"value": "plan", "name": "Plan"},
		}},
		map[string]any{"id": "llm", "name": "Model", "category": "model", "type": "select", "currentValue": model, "options": []any{
			map[string]any{"group": "g", "name": "Group", "options": []any{map[string]any{"value": "opus", "name": "Opus"}, map[string]any{"value": "sonnet", "name": "Sonnet"}}},
		}},
		map[string]any{"id": "brave", "name": "Brave", "type": "boolean", "currentValue": false},
	}}
}

func configHook(fa *fakeAgent, id json.RawMessage, method string, p map[string]any) bool {
	switch method {
	case "session/new":
		r := configOptionsResult("default", "opus")
		r["sessionId"] = "cfg-1"
		fa.respond(id, r)
		return true
	case "session/set_config_option":
		fa.respond(id, configOptionsResult(map[bool]string{true: getStr(p, "value"), false: "default"}[getStr(p, "configId") == "perm"],
			map[bool]string{true: getStr(p, "value"), false: "opus"}[getStr(p, "configId") == "llm"]))
		return true
	}
	return false
}

func TestConfigOptionsDriveModesAndModelsByCategory(t *testing.T) {
	b, fa := newBackend(t, func(fa *fakeAgent) { fa.hook = configHook })
	ctx := context.Background()
	s, err := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if s.ModeID != "default" || s.ModelID != "opus" {
		t.Fatalf("session = %+v", s)
	}
	modes, _ := b.Modes(ctx, "/w")
	models, _ := b.Models(ctx, "/w")
	if len(modes) != 2 || modes[1].ID != "plan" || len(models) != 2 || models[1].ID != "sonnet" {
		t.Fatalf("modes=%+v models=%+v (a boolean option must be ignored, groups flattened)", modes, models)
	}
	if !models[0].Images {
		t.Error("models do not carry the agent's image capability")
	}
	got, err := b.SetMode(ctx, "/w", s.ID, "plan")
	if err != nil || got.ModeID != "plan" {
		t.Fatalf("SetMode = %+v, %v", got, err)
	}
	got, err = b.SetModel(ctx, "/w", s.ID, "sonnet")
	if err != nil || got.ModelID != "sonnet" {
		t.Fatalf("SetModel = %+v, %v", got, err)
	}
	cfgCalls := fa.called("session/set_config_option")
	if len(cfgCalls) != 2 || getStr(cfgCalls[0], "configId") != "perm" || getStr(cfgCalls[1], "configId") != "llm" {
		t.Errorf("set_config_option calls = %v", cfgCalls)
	}
	if len(fa.called("session/set_mode"))+len(fa.called("session/set_model")) != 0 {
		t.Error("legacy setters used though config options were advertised")
	}
}

func TestConfigOptionUpdateMovesTheSelectors(t *testing.T) {
	b, fa := newBackend(t, func(fa *fakeAgent) { fa.hook = configHook })
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{})
	ch, _ := b.Subscribe(ctx)
	upd := configOptionsResult("plan", "sonnet")
	upd["sessionUpdate"] = "config_option_update"
	fa.update(s.ID, upd)
	evs := drainEvents(t, ch, s.ID, 3*time.Second, func(e backend.Event) bool { return e.Kind == backend.EventSession })
	if sess := evs[len(evs)-1].Session; sess.ModeID != "plan" || sess.ModelID != "sonnet" {
		t.Errorf("session = %+v", sess)
	}
}

func TestLegacyModesStillUseSetMode(t *testing.T) {
	b, fa := newBackend(t, func(fa *fakeAgent) {
		fa.hook = func(fa *fakeAgent, id json.RawMessage, method string, p map[string]any) bool {
			if method == "session/new" {
				fa.respond(id, map[string]any{"sessionId": "l-1",
					"modes":  map[string]any{"currentModeId": "ask", "availableModes": []any{map[string]any{"id": "ask", "name": "Ask"}, map[string]any{"id": "code", "name": "Code"}}},
					"models": map[string]any{"currentModelId": "m1", "availableModels": []any{map[string]any{"modelId": "m1", "name": "M1"}}}})
				return true
			}
			return false
		}
	})
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{})
	if got, err := b.SetMode(ctx, "/w", s.ID, "code"); err != nil || got.ModeID != "code" {
		t.Fatalf("SetMode = %+v, %v", got, err)
	}
	if len(fa.called("session/set_mode")) != 1 || len(fa.called("session/set_config_option")) != 0 {
		t.Error("legacy mode did not use session/set_mode")
	}
}

// ---- 5. usage

func TestUsageUpdateAndTurnUsageReachTheSession(t *testing.T) {
	b, fa := newBackend(t)
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{})
	ch, _ := b.Subscribe(ctx)
	_ = b.Prompt(ctx, "/w", s.ID, backend.Prompt{Text: "x"})
	pr := <-fa.promptReqs
	fa.update(s.ID, map[string]any{"sessionUpdate": "usage_update", "used": 53000, "size": 200000, "cost": map[string]any{"amount": 0.045, "currency": "USD"}})
	fa.respond(pr.id, map[string]any{"stopReason": "end_turn", "usage": map[string]any{"inputTokens": 35000, "outputTokens": 12000, "thoughtTokens": 5000, "cachedReadTokens": 7}})
	evs := drainEvents(t, ch, s.ID, 3*time.Second, isIdle)
	var last *backend.Usage
	for _, e := range evs {
		if e.Kind == backend.EventUsage {
			last = e.Usage
		}
	}
	if last == nil || last.ContextUsed != 53000 || last.ContextMax == nil || *last.ContextMax != 200000 || last.Cost != 0.045 || last.Input != 35000 || last.Output != 12000 || last.Reasoning != 5000 || last.CacheRead != 7 {
		t.Fatalf("usage = %+v", last)
	}
	if got, _ := b.GetSession(ctx, "/w", s.ID); got.Usage == nil || got.Usage.ContextUsed != 53000 {
		t.Errorf("session usage = %+v", got.Usage)
	}
}

func TestNonUSDCostIsNotCountedAsDollars(t *testing.T) {
	b, fa := newBackend(t)
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{})
	ch, _ := b.Subscribe(ctx)
	fa.update(s.ID, map[string]any{"sessionUpdate": "usage_update", "used": 1, "size": 2, "cost": map[string]any{"amount": 9, "currency": "credits"}})
	evs := drainEvents(t, ch, s.ID, 3*time.Second, func(e backend.Event) bool { return e.Kind == backend.EventUsage })
	if evs[len(evs)-1].Usage.Cost != 0 {
		t.Errorf("cost = %v", evs[len(evs)-1].Usage.Cost)
	}
}

// ---- 6. tool calls

func TestToolCallUpdatesMergeAndAreNeverNameless(t *testing.T) {
	b, fa := newBackend(t)
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{})
	ch, _ := b.Subscribe(ctx)
	_ = b.Prompt(ctx, "/w", s.ID, backend.Prompt{Text: "x"})
	pr := <-fa.promptReqs
	fa.update(s.ID, map[string]any{"sessionUpdate": "tool_call", "toolCallId": "c1", "title": "Reading main.go", "kind": "read",
		"locations": []any{map[string]any{"path": "/w/main.go", "line": 3}}})
	fa.update(s.ID, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed",
		"content": []any{map[string]any{"type": "content", "content": map[string]any{"type": "text", "text": "package main"}}}})
	// no kind, no name: the title names it
	fa.update(s.ID, map[string]any{"sessionUpdate": "tool_call", "toolCallId": "c2", "title": "Do a thing"})
	// nothing at all: a bare update that creates the call
	fa.update(s.ID, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "c3", "status": "in_progress"})
	// kind other: the programmatic name is better than "other"
	fa.update(s.ID, map[string]any{"sessionUpdate": "tool_call", "toolCallId": "c4", "kind": "other", "name": "mcp__x__y", "title": "x"})
	fa.respond(pr.id, map[string]any{"stopReason": "end_turn"})
	drainEvents(t, ch, s.ID, 3*time.Second, isIdle)
	tr, _ := b.Transcript(ctx, "/w", s.ID)
	parts := map[string]backend.Part{}
	for _, m := range tr.Messages {
		for _, p := range m.Parts {
			if p.Type == backend.PartTool {
				parts[p.CallID] = p
			}
		}
	}
	c1 := parts["c1"]
	if c1.Tool != "read" || c1.Title != "Reading main.go" || c1.ToolStatus != backend.ToolCompleted || c1.Output != "package main" || c1.Input["filePath"] != "/w/main.go" {
		t.Errorf("c1 lost data on the bare update: %+v", c1)
	}
	if parts["c2"].Tool != "Do a thing" || parts["c3"].Tool != "tool" || parts["c4"].Tool != "mcp__x__y" {
		t.Errorf("names: c2=%q c3=%q c4=%q", parts["c2"].Tool, parts["c3"].Tool, parts["c4"].Tool)
	}
}

func TestToolCallDiffContentIsNotAnEmptyOutput(t *testing.T) {
	got := toolCallText(map[string]any{"content": []any{map[string]any{"type": "diff", "path": "/w/a.go", "newText": "x"}}})
	if got != "changed /w/a.go" {
		t.Errorf("output = %q", got)
	}
	got = toolCallText(map[string]any{"content": []any{map[string]any{"type": "content", "content": map[string]any{"type": "resource_link", "name": "doc", "uri": "file:///d"}}}})
	if got != "doc file:///d" {
		t.Errorf("output = %q", got)
	}
}

// ---- 7. permission options

func TestPermissionDecisionToOptionKind(t *testing.T) {
	opt := func(kinds ...string) []permissionOption {
		var o []permissionOption
		for _, k := range kinds {
			o = append(o, permissionOption{OptionID: "id-" + k, Kind: k, Name: k})
		}
		return o
	}
	cases := []struct {
		decision backend.Decision
		options  []permissionOption
		want     string
	}{
		{backend.DecisionOnce, opt("allow_once", "allow_always", "reject_once"), "id-allow_once"},
		{backend.DecisionAlways, opt("allow_once", "allow_always", "reject_once"), "id-allow_always"},
		{backend.DecisionAlways, opt("allow_once", "reject_once"), "id-allow_once"},
		{backend.DecisionReject, opt("allow_once", "reject_once", "reject_always"), "id-reject_once"},
		{backend.DecisionReject, opt("allow_always", "reject_always"), "id-reject_always"},
		{backend.DecisionOnce, opt("allow_always", "reject_once"), ""}, // never widened to always
	}
	for i, c := range cases {
		b, fa := newBackend(t)
		ctx := context.Background()
		s, _ := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{})
		ch, _ := b.Subscribe(ctx)
		answer := make(chan string, 1)
		go func() {
			id, _ := fa.requestPermission(ctx, s.ID, fmt.Sprintf("tc%d", i), c.options)
			answer <- id
		}()
		evs := drainEvents(t, ch, s.ID, 3*time.Second, func(e backend.Event) bool { return e.Kind == backend.EventPermissionAsked })
		req := evs[len(evs)-1].Request
		err := b.ReplyPermission(ctx, "/w", s.ID, req.ID, c.decision, "")
		if c.want == "" {
			if err == nil {
				t.Errorf("case %d: expected an error, the decision has no option", i)
			}
			continue
		}
		if err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		if got := <-answer; got != c.want {
			t.Errorf("case %d: answered %q, want %q", i, got, c.want)
		}
	}
}

// ---- 8. prompt content

func TestPromptContentBlocksFollowPromptCapabilities(t *testing.T) {
	png := backend.Attachment{Type: "file", Mime: "image/png", Filename: "a.png", URL: "data:image/png;base64,QUJD"}
	txt := backend.Attachment{Type: "file", Mime: "text/plain", Filename: "n.txt", URL: "data:text/plain;base64,aGk="}
	pdf := backend.Attachment{Type: "file", Mime: "application/pdf", Filename: "d.pdf", URL: "data:application/pdf;base64,JVBERg=="}
	wav := backend.Attachment{Type: "file", Mime: "audio/wav", Filename: "s.wav", URL: "data:audio/wav;base64,UklGRg=="}
	p := backend.Prompt{Text: "look", Attachments: []backend.Attachment{png, txt, pdf, wav}}

	all := promptContentBlocks(p, acpAgentCapabilities{promptImage: true, promptAudio: true, promptEmbedded: true})
	types := []string{}
	for _, bl := range all {
		types = append(types, bl["type"].(string))
	}
	if fmt.Sprint(types) != "[text image resource resource audio]" {
		t.Fatalf("blocks = %v", types)
	}
	if res := all[2]["resource"].(map[string]any); res["text"] != "hi" || res["mimeType"] != "text/plain" || res["uri"] != "attachment:///n.txt" {
		t.Errorf("text resource = %v", res)
	}
	if res := all[3]["resource"].(map[string]any); res["blob"] != "JVBERg==" || res["text"] != nil {
		t.Errorf("pdf resource = %v", res)
	}

	none := promptContentBlocks(p, acpAgentCapabilities{})
	if len(none) != 5 {
		t.Fatalf("blocks = %d, want text + 4 notes", len(none))
	}
	for _, bl := range none[1:] {
		if bl["type"] != "text" {
			t.Errorf("an unsupported attachment was sent as %v", bl["type"])
		}
	}
}

func TestEmbeddedContextTurnsFilesOn(t *testing.T) {
	b, _ := newBackend(t, withCaps(func(c map[string]any) {
		c["promptCapabilities"] = map[string]any{"image": false, "embeddedContext": true}
	}))
	if c := b.Capabilities(); !c.Files || c.Images {
		t.Errorf("caps = %+v", c)
	}
}

// ---- 9. cancellation and stop reasons

func TestRequestCancelledErrorIsAQuietEnd(t *testing.T) {
	b, fa := newBackend(t)
	ctx := context.Background()
	s, _ := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{})
	ch, _ := b.Subscribe(ctx)
	_ = b.Prompt(ctx, "/w", s.ID, backend.Prompt{Text: "x"})
	pr := <-fa.promptReqs
	_ = fa.conn.respond(pr.id, nil, &rpcError{Code: -32800, Message: "Request cancelled"})
	for _, e := range drainEvents(t, ch, s.ID, 3*time.Second, isIdle) {
		if e.Kind == backend.EventError {
			t.Errorf("a cancel produced an error: %+v", e)
		}
	}
}

func TestStopReasonsThatAreNotANormalEndSayWhy(t *testing.T) {
	for reason, wantErr := range map[string]bool{"end_turn": false, "cancelled": false, "refusal": true, "max_tokens": true, "max_turn_requests": true} {
		b, fa := newBackend(t)
		ctx := context.Background()
		s, _ := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{})
		ch, _ := b.Subscribe(ctx)
		_ = b.Prompt(ctx, "/w", s.ID, backend.Prompt{Text: "x"})
		pr := <-fa.promptReqs
		fa.respond(pr.id, map[string]any{"stopReason": reason})
		sawErr := false
		for _, e := range drainEvents(t, ch, s.ID, 3*time.Second, isIdle) {
			sawErr = sawErr || e.Kind == backend.EventError
		}
		if sawErr != wantErr {
			t.Errorf("%s: error event = %v, want %v", reason, sawErr, wantErr)
		}
	}
}

// ---- Vibe: a session another process still holds

// An agent that keeps a lock per open session (Mistral Vibe) refuses a load with
// "already open" while the previous agent process is still shutting down; the
// open waits for it instead of failing.
func TestOpeningASessionAnotherProcessHoldsIsRetried(t *testing.T) {
	old := openBusyDelays
	openBusyDelays = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond}
	defer func() { openBusyDelays = old }()
	busy := 2
	b, fa := newBackend(t, func(fa *fakeAgent) {
		fa.hook = func(fa *fakeAgent, id json.RawMessage, method string, _ map[string]any) bool {
			if method == "session/load" && busy > 0 {
				busy--
				_ = fa.conn.respond(id, nil, &rpcError{Code: -31002, Message: "Session is already open: ext-1"})
				return true
			}
			return false
		}
	})
	if _, err := b.Transcript(context.Background(), "/w", "ext-1"); err != nil {
		t.Fatalf("the open failed instead of waiting for the other process: %v", err)
	}
	if n := len(fa.called("session/load")); n != 3 {
		t.Errorf("session/load called %d times, want 3 (two refused, one answered)", n)
	}

	// still held after every retry: the error says so
	busy = 100
	if _, err := b.Transcript(context.Background(), "/w", "ext-2"); err == nil || !strings.Contains(err.Error(), "already open") {
		t.Errorf("err = %v, want the agent's own 'already open'", err)
	}
}
