package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/sessions"
)

// A task subagent of a session that was once on Deny keeps its tools on its
// FIRST step (anomalyco/opencode#45078): opencode seeds the child with the
// parent's deny rules only, so the Deny block's `* * deny` reached every
// future child without the allows that superseded it, and opencode then sent
// the child's first request with no tools at all — the model could only
// answer in text, and a background child ended there. The mock sees each
// request's tool list, which is the fact under test.
func TestSubagentKeepsItsToolsAfterTheParentWasOnDeny(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	s := r.session("sv", "")
	r.setMode(s, "deny")
	r.setMode(s, "allow")

	marker := fmt.Sprintf("sv-child-marker-%d", time.Now().UnixNano())
	r.script(map[string]any{
		"toolCalls": []map[string]any{{
			"id":        fmt.Sprintf("call_sv%d", r.next()),
			"name":      "task",
			"arguments": mustJSON2(map[string]any{"description": "child", "prompt": marker + ": say done", "subagent_type": "general"}),
		}},
		// The child's own requests carry the marker: answer them with text,
		// so the child finishes after its first step either way.
		"routes": []map[string]any{{
			"contains": marker,
			"scenario": map[string]any{"content": []string{"child done"}, "chunkDelayMs": 5, "finishReason": "stop"},
		}},
	})
	mark := r.hub.mark()
	if err := r.promptSession(s, "delegate it"); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	r.hub.wait(t, mark, 90*time.Second, "the task call to finish", func(e sessions.Envelope) bool {
		p := e.Event.Part
		return e.SessionID == s.ID && e.Event.Kind == backend.EventPart && p != nil && p.Tool == "task" &&
			(p.ToolStatus == backend.ToolCompleted || p.ToolStatus == backend.ToolFailed)
	})

	resp, err := http.Get(r.mock + "/__control/request-log")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var log struct {
		Requests []struct {
			Prompts []string `json:"prompts"`
			Tools   []string `json:"tools"`
		} `json:"requests"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&log); err != nil {
		t.Fatal(err)
	}
	var first []string
	found := false
	for _, req := range log.Requests {
		if strings.Contains(strings.Join(req.Prompts, "\n"), marker) {
			first, found = req.Tools, true
			break
		}
	}
	if !found {
		t.Fatalf("the subagent's request never reached the model (%d requests seen)", len(log.Requests))
	}
	has := map[string]bool{}
	for _, name := range first {
		has[name] = true
	}
	for _, want := range []string{"bash", "read", "glob", "grep"} {
		if !has[want] {
			t.Errorf("the subagent's first request offered no %q (tools: %v)", want, first)
		}
	}
}

// The case the sentinel IT missed (B1): after Ask → Deny → Allow, the child's
// FIRST tool call must RUN — not merely be offered — completing with its
// output. Children inherit no blanket deny any more; the floor's ask for the
// first call is answered once where the root allows it (audited by galopin),
// so no card ever waits on a person.
func TestSubagentFirstCallRunsAfterDenyThenAllow(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	s := r.session("sv-run", "")
	r.setMode(s, "deny")
	r.setMode(s, "allow")

	marker := fmt.Sprintf("sv-run-marker-%d", time.Now().UnixNano())
	id, mark := r.delegateGeneral(s, marker, false, r.bashCall("echo ok"))
	env := r.hub.wait(t, mark, 90*time.Second, "the child's first bash call to complete", func(e sessions.Envelope) bool {
		p := e.Event.Part
		return e.SessionID == id && e.Event.Kind == backend.EventPart && p != nil && p.Tool == "bash" &&
			(p.ToolStatus == backend.ToolCompleted || p.ToolStatus == backend.ToolFailed)
	})
	part := env.Event.Part
	if part.ToolStatus != backend.ToolCompleted {
		t.Fatalf("the child's first call did not complete: %+v", part)
	}
	if !strings.Contains(part.Output, "ok") {
		t.Errorf("the child's first call output = %q, want it to carry ok", part.Output)
	}
	// The floor's ask was answered by galopin, not left for a person: nothing
	// waits, and the audit says who answered.
	if pending := r.mc.mat.PendingPermissionRequests(id); len(pending) != 0 {
		t.Errorf("the child's ask still waits: %+v", pending)
	}
	answered := false
	for _, row := range auditPermissionRows(t, r.stateDir) {
		if row["tool"] == "bash" && row["decision"] == "once" && row["by"] == "galopin" {
			answered = true
		}
	}
	if !answered {
		t.Errorf("no galopin answer for the child's bash in the audit")
	}
}

// Deny mode (B1): a root in Deny that issues bash is refused with the Deny
// message — no ask is materialised anywhere (no card on any link), and the
// rejection is audited as galopin's.
func TestDenyModeRefusesWithoutACard(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	s := r.session("deny-run", "")
	r.setMode(s, "deny")

	mark := r.hub.mark()
	ask, part, _ := r.tryCall(s, "bash", map[string]any{"command": "echo ok", "description": "x"})
	if ask != nil {
		t.Fatalf("a card was materialised under Deny (%+v)", ask)
	}
	if part == nil || (part.ToolStatus != backend.ToolFailed && part.Tool != "invalid") {
		t.Fatalf("the call was not refused: %+v", part)
	}
	if got := part.ToolError + part.Output; !strings.Contains(got, "set to Deny") {
		t.Errorf("refusal text = %q, want the Deny message", got)
	}
	for _, env := range r.hub.since(mark) {
		if env.Event.Kind == backend.EventPermissionAsked && env.SessionID == s.ID {
			t.Errorf("a permission.asked envelope reached clients under Deny: %+v", env.Event.Request)
		}
	}
	if n := r.mc.mat.PendingPermissions(s.ID); n != 0 {
		t.Errorf("pending = %d, want nothing materialised", n)
	}
	rows := auditPermissionRows(t, r.stateDir)
	if len(rows) != 1 || rows[0]["decision"] != "reject" || rows[0]["by"] != "galopin" {
		t.Errorf("audit permission rows = %v, want the one galopin rejection", rows)
	}
}

// A child under a Deny root (B1): its turn's first call is rejected by the
// pre-filter, again with no card. The child is made under Allow (a task from
// a Deny root is itself refused), then the root moves to Deny before the
// child's next turn.
func TestChildUnderDenyRootIsRefusedWithoutACard(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	s := r.session("deny-child", "")
	r.setMode(s, "allow")

	marker := fmt.Sprintf("deny-child-marker-%d", time.Now().UnixNano())
	id, mark := r.delegateGeneral(s, marker, false, r.bashCall("echo ok"))
	setup := r.hub.wait(t, mark, 90*time.Second, "the child's first bash call to complete", func(e sessions.Envelope) bool {
		p := e.Event.Part
		return e.SessionID == id && e.Event.Kind == backend.EventPart && p != nil && p.Tool == "bash" &&
			(p.ToolStatus == backend.ToolCompleted || p.ToolStatus == backend.ToolFailed)
	})
	if setup.Event.Part.ToolStatus != backend.ToolCompleted {
		t.Fatalf("setup: the child's first call under Allow must run: %+v", setup.Event.Part)
	}
	r.setMode(s, "deny")

	mark2 := r.hub.mark()
	if err := r.oc.Prompt(r.ctx, r.work, id, backend.Prompt{Text: marker + " again"}); err != nil {
		t.Fatalf("prompting the child: %v", err)
	}
	env := r.hub.wait(t, mark2, 90*time.Second, "the child's refused bash", func(e sessions.Envelope) bool {
		p := e.Event.Part
		return e.SessionID == id && e.Event.Kind == backend.EventPart && p != nil && p.Tool == "bash" &&
			(p.ToolStatus == backend.ToolCompleted || p.ToolStatus == backend.ToolFailed)
	})
	part := env.Event.Part
	if part.ToolStatus != backend.ToolFailed {
		t.Fatalf("the child's call under a Deny root completed: %+v", part)
	}
	if got := part.ToolError + part.Output; !strings.Contains(got, "set to Deny") {
		t.Errorf("refusal text = %q, want the Deny message", got)
	}
	for _, env := range r.hub.since(mark2) {
		if env.Event.Kind == backend.EventPermissionAsked && env.SessionID == id {
			t.Errorf("a permission.asked envelope reached clients for a Deny-root child: %+v", env.Event.Request)
		}
	}
}

// Stale-deny detection (B2): a root whose stored rules contain an old-style
// `* * deny` (written here with a raw PATCH, simulating a pre-fix session)
// reports staleDeny once a prompt refreshes the verdict.
func TestStaleDenyReportedForOldStyleBlock(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	s := r.session("stale", "")
	r.raw(http.MethodPatch, "/session/"+s.ID, map[string]any{"permission": []map[string]any{
		{"permission": "*", "pattern": "*", "action": "deny"},
		{"permission": "bash", "pattern": "*", "action": "deny"},
	}})
	if err := r.oc.EnsureRules(r.ctx, r.work, s.ID); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"sessionId": s.ID})
	res, operr := r.mc.Handle(r.ctx, "session.get", raw)
	if operr != nil {
		t.Fatalf("session.get: %+v", operr)
	}
	body, _ := json.Marshal(res)
	var out struct {
		Session struct {
			StaleDeny bool `json:"staleDeny"`
		} `json:"session"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	if !out.Session.StaleDeny {
		t.Errorf("session.get staleDeny = false, want true for the old-style block")
	}
}

func auditPermissionRows(t *testing.T, stateDir string) []map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(stateDir, "audit.log"))
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line == "" {
			continue
		}
		var row map[string]any
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatalf("audit line %q: %v", line, err)
		}
		if row["action"] == "permission" {
			rows = append(rows, row)
		}
	}
	return rows
}
