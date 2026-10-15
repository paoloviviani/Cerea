package main

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/sessions"
)

// realModel is an OpenAI-compatible endpoint for the smoke check. The key is
// read from the environment file and is never logged.
type realModel struct{ baseURL, apiKey, model string }

// loadRealModel reads ~/.config/galopin-eval.env (EVAL_GATEWAY_KEY,
// EVAL_GATEWAY_BASE_URL). Skips when it is absent or GALOPIN_REAL_MODEL_IT is not 1.
func loadRealModel(t *testing.T) *realModel {
	t.Helper()
	if os.Getenv("GALOPIN_REAL_MODEL_IT") != "1" {
		t.Skip("set GALOPIN_REAL_MODEL_IT=1 (and have ~/.config/galopin-eval.env) for the real-model smoke check")
	}
	home, _ := os.UserHomeDir()
	f, err := os.Open(filepath.Join(home, ".config", "galopin-eval.env"))
	if err != nil {
		t.Skip("no ~/.config/galopin-eval.env")
	}
	defer f.Close()
	vals := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(sc.Text()), "export "))
		if k, v, ok := strings.Cut(line, "="); ok {
			vals[k] = strings.Trim(v, `"'`)
		}
	}
	m := &realModel{baseURL: vals["EVAL_GATEWAY_BASE_URL"], apiKey: vals["EVAL_GATEWAY_KEY"], model: "deepseek-v4-flash-0731"}
	if m.baseURL == "" || m.apiKey == "" {
		t.Skip("galopin-eval.env lacks EVAL_GATEWAY_BASE_URL / EVAL_GATEWAY_KEY")
	}
	return m
}

// The new permission model with a real model, in an isolated opencode + galopin
// (at most ~30 model calls): Plan refuses an edit and the model copes (says it
// cannot, does not loop), Ask raises a card, Allow edits with no card and no
// rule written.
func TestRealModelSmokePlanAskAllow(t *testing.T) {
	rm := loadRealModel(t)
	r := newPermRig(t, permRigOpts{real: rm})
	toolCalls := func(mark int, sid string) (names []string) {
		for _, e := range r.hub.since(mark) {
			p := e.Event.Part
			if e.SessionID == sid && e.Event.Kind == backend.EventPart && p != nil && p.Type == backend.PartTool &&
				(p.ToolStatus == backend.ToolCompleted || p.ToolStatus == backend.ToolFailed) {
				names = append(names, p.Tool+":"+string(p.ToolStatus))
			}
		}
		return
	}
	finalText := func(mark int, sid string) string {
		out := ""
		for _, e := range r.hub.since(mark) {
			p := e.Event.Part
			if e.SessionID == sid && e.Event.Kind == backend.EventPart && p != nil && p.Type == backend.PartText && p.Role == "assistant" {
				out = p.Text
			}
		}
		if len(out) > 240 {
			out = out[:240] + "…"
		}
		return strings.ReplaceAll(out, "\n", " ")
	}
	turn := func(s backend.Session, prompt string) (mark int, ask *backend.PermissionRequest) {
		mark = r.hub.mark()
		if err := r.promptSession(s, prompt); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(120 * time.Second)
		for time.Now().Before(deadline) {
			for _, e := range r.hub.since(mark) {
				if e.SessionID != s.ID {
					continue
				}
				if e.Event.Kind == backend.EventPermissionAsked {
					return mark, e.Event.Request
				}
				if e.Event.Kind == backend.EventStatus && e.Event.Status == backend.StatusIdle {
					return mark, nil
				}
			}
			time.Sleep(200 * time.Millisecond)
		}
		t.Fatal("the turn neither asked nor finished within 120s")
		return
	}
	modelID := "pystino/" + rm.model

	// Plan: the plan agent, and galopin rejecting every effectful call.
	plan := r.session("smoke-plan", "plan")
	if _, err := r.oc.SetModel(r.ctx, r.work, plan.ID, modelID); err != nil {
		t.Fatal(err)
	}
	r.setMode(plan, "deny")
	mark, ask := turn(plan, "Create a file named hello.txt in the project folder containing the single word hi.")
	if ask != nil {
		t.Fatalf("Plan raised a card (%s %v), want galopin to refuse by itself", ask.Tool, ask.Patterns)
	}
	calls := toolCalls(mark, plan.ID)
	t.Logf("PLAN: tool calls %v; file exists=%v; final text: %q", calls, r.exists("hello.txt"), finalText(mark, plan.ID))
	if r.exists("hello.txt") {
		t.Error("Plan let the model write the file")
	}
	if len(calls) > 6 {
		t.Errorf("Plan: %d tool calls, the model looped on the refusal", len(calls))
	}

	// Ask: a card.
	ask1 := r.session("smoke-ask", "build")
	if _, err := r.oc.SetModel(r.ctx, r.work, ask1.ID, modelID); err != nil {
		t.Fatal(err)
	}
	mark, ask = turn(ask1, "Create a file named ask.txt in the project folder containing the single word hi.")
	if ask == nil {
		t.Errorf("Ask raised no card; tool calls %v", toolCalls(mark, ask1.ID))
	} else {
		t.Logf("ASK: card for %s %v", ask.Tool, ask.Patterns)
		r.reply(ask1, ask.ID, "reject")
		r.idle(ask1, mark)
	}
	if r.exists("ask.txt") {
		t.Error("Ask wrote the file though the card was rejected")
	}

	// Allow: no card, an edit, no rule written.
	allow := r.session("smoke-allow", "build")
	if _, err := r.oc.SetModel(r.ctx, r.work, allow.ID, modelID); err != nil {
		t.Fatal(err)
	}
	r.setMode(allow, "allow")
	mark, ask = turn(allow, "Create a file named allow.txt in the project folder containing the single word hi.")
	if ask != nil {
		t.Errorf("Allow raised a card (%s %v)", ask.Tool, ask.Patterns)
		r.reply(allow, ask.ID, "reject")
	}
	r.idle(allow, mark)
	t.Logf("ALLOW: tool calls %v; file exists=%v; stored rules=%d", toolCalls(mark, allow.ID), r.exists("allow.txt"), len(r.sessionRules(allow.ID)))
	if !r.exists("allow.txt") {
		t.Error("Allow did not edit the file")
	}
	if n := len(r.sessionRules(allow.ID)); n != 0 {
		t.Errorf("Allow left %d rules in the session", n)
	}
	_ = sessions.Envelope{}
}
