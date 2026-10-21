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

// Part A3: a background subagent's result wakes its parent.
//
// opencode injects a finished background child's result as a synthetic
// <task> message and starts a new parent turn for it — but the injected
// prompt carries no model, so it resolves the agent's own, and a global
// agent file pinning a model outside Pystino breaks (or bypasses) it. The
// first half pins galopin's side of that contract: an isolated
// XDG_CONFIG_HOME holding opencode/agents/build.md with a bogus model is
// reported by the scanner and on the hello. The second half, with the pin
// removed, runs the whole loop against the mock: the parent issues task
// with background:true, the mock completes the child, and a NEW assistant
// turn starts in the parent — running on the session's own model, as the
// mock's request log proves.
//
// GALOPIN_OPENCODE_IT=1 (spawns real opencode + a mock LLM). galopin sets
// OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1 in production; the rig does
// the same through permRigOpts.background.
func TestBackgroundResultStartsAParentTurnOnTheSessionsModel(t *testing.T) {
	// --- The pin is reported. ---
	cfgHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", cfgHome)
	t.Setenv("OPENCODE_CONFIG_DIR", "")
	pinDir := filepath.Join(cfgHome, "opencode", "agents")
	if err := os.MkdirAll(pinDir, 0o755); err != nil {
		t.Fatal(err)
	}
	pinFile := filepath.Join(pinDir, "build.md")
	if err := os.WriteFile(pinFile, []byte("---\nmodel: nosuch/model\n---\n\nYou build.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pins := scanModelPins(false)
	if len(pins) != 1 || pins[0].Model != "nosuch/model" || pins[0].File != pinFile {
		t.Fatalf("pins = %+v, want the one bogus agent pin", pins)
	}
	r := newPermRig(t, permRigOpts{background: true})
	hello := buildHello(r.oc, r.mc.pol)
	if len(hello.Policy.Warnings) != 1 || !strings.Contains(hello.Policy.Warnings[0], "nosuch/model") {
		t.Fatalf("hello warnings = %v, want the pin reported", hello.Policy.Warnings)
	}
	// With the pin removed, nothing is reported.
	if err := os.Remove(pinFile); err != nil {
		t.Fatal(err)
	}
	if pins := scanModelPins(false); len(pins) != 0 {
		t.Fatalf("pins after removal = %+v, want none", pins)
	}

	// --- The background loop, with no pin in the way. ---
	s := r.session("notify", "")
	r.setMode(s, "allow")
	marker := fmt.Sprintf("bg-notify-marker-%d", time.Now().UnixNano())
	r.script(map[string]any{
		"toolCalls": []map[string]any{{
			"id":   fmt.Sprintf("call_bg%d", r.next()),
			"name": "task",
			"arguments": mustJSON2(map[string]any{
				"description": "background child", "prompt": marker + ": say done",
				"subagent_type": "general", "background": true,
			}),
		}},
		"routes": []map[string]any{{
			"contains": marker,
			"scenario": map[string]any{"content": []string{"child done"}, "chunkDelayMs": 5, "finishReason": "stop"},
		}},
	})
	mark := r.hub.mark()
	if err := r.promptSession(s, "delegate it"); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	// The background task call returns at once; the parent settles...
	r.hub.wait(t, mark, 90*time.Second, "the background task call to start", func(e sessions.Envelope) bool {
		p := e.Event.Part
		return e.SessionID == s.ID && e.Event.Kind == backend.EventPart && p != nil && p.Tool == "task" &&
			(p.ToolStatus == backend.ToolCompleted || p.ToolStatus == backend.ToolFailed)
	})
	// ...and when the child finishes, a NEW assistant turn starts in the
	// parent: this is the turn the pin used to break (and the stray
	// cortecs connection used to run).
	//
	// The child can finish before the parent's own turn settles (the mock
	// answers in milliseconds), in which case opencode folds the injected
	// <task> message into the turn already running and the parent goes idle
	// only once, after the notification. Even when it does come after the
	// idle, it lands within a millisecond of it (opencode starts the turn
	// the moment the parent settles), while the idle is only noticed on the
	// next 100ms poll: a mark taken then is already past the notification's
	// busy event, which a wait for "busy after idle" would then never see
	// (a 4 minute timeout). So the test anchors on the injected message
	// itself, then on the assistant reply to it, then on idle; none of
	// those depend on where the parent's own idle falls.
	var taskAt int
	r.hub.wait(t, mark, 240*time.Second, "the injected <task> message in the parent", func(e sessions.Envelope) bool {
		p := e.Event.Part
		return e.SessionID == s.ID && e.Event.Kind == backend.EventPart && p != nil && p.Role == "user" &&
			strings.Contains(p.Text, "<task")
	})
	for i, e := range r.hub.since(mark) {
		if p := e.Event.Part; e.SessionID == s.ID && e.Event.Kind == backend.EventPart && p != nil && p.Role == "user" && strings.Contains(p.Text, "<task") {
			taskAt = mark + i
			break
		}
	}
	r.hub.wait(t, taskAt, 240*time.Second, "the notification turn's assistant reply in the parent", func(e sessions.Envelope) bool {
		p := e.Event.Part
		return e.SessionID == s.ID && e.Event.Kind == backend.EventPart && p != nil && p.Role == "assistant" && p.Type == "step-finish"
	})
	r.idle(s, taskAt)

	// The mock's request log proves the turn ran on the session's model:
	// the request carrying the injected <task> message used the same model
	// as the parent's own requests.
	resp, err := http.Get(r.mock + "/__control/request-log")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var log struct {
		Requests []struct {
			Prompts []string `json:"prompts"`
			Tools   []string `json:"tools"`
			Model   string   `json:"model"`
		} `json:"requests"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&log); err != nil {
		t.Fatal(err)
	}
	var parentModel, notifyModel string
	for _, req := range log.Requests {
		joined := strings.Join(req.Prompts, "\n")
		if strings.Contains(joined, "delegate it") && parentModel == "" {
			parentModel = req.Model
		}
		if strings.Contains(joined, "<task") {
			notifyModel = req.Model
		}
	}
	if parentModel == "" {
		t.Fatalf("the parent's own request never reached the model (%d requests seen)", len(log.Requests))
	}
	if notifyModel == "" {
		t.Fatalf("no request carried the injected <task> message (%d requests seen)", len(log.Requests))
	}
	if notifyModel != parentModel {
		t.Errorf("notification turn ran on %q, want the session's model %q", notifyModel, parentModel)
	}
}
