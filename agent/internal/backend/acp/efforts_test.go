package acp

import (
	"context"
	"encoding/json"
	"galopin/internal/backend"
	"strings"
	"sync"
	"testing"
)

// thinkingAgent makes the fake agent a Vibe-like one: session/new answers a mode, a
// model and a "thinking" option (category "thinking"), and set_config_option moves them.
type thinkingAgent struct {
	mu       sync.Mutex
	thinking string // what a new session starts on (the agent keeps the last level set)
	model    string
	sets     []string // "<configId>=<value>"
}

func (ta *thinkingAgent) options() []any {
	lvl := func(vs ...string) []any {
		var out []any
		for _, v := range vs {
			out = append(out, map[string]any{"value": v, "name": v})
		}
		return out
	}
	return []any{
		map[string]any{"id": "mode", "category": "mode", "type": "select", "currentValue": "ask", "options": lvl("ask")},
		map[string]any{"id": "model", "category": "model", "type": "select", "currentValue": ta.model, "options": lvl("m1", "m2")},
		map[string]any{"id": "thinking", "category": "thinking", "type": "select", "currentValue": ta.thinking, "options": lvl("off", "low", "medium", "high")},
	}
}

func (ta *thinkingAgent) hook(fa *fakeAgent, id json.RawMessage, method string, p map[string]any) bool {
	ta.mu.Lock()
	defer ta.mu.Unlock()
	switch method {
	case "session/new":
		fa.sessionCounter++
		fa.respond(id, map[string]any{"sessionId": "sess-" + string(rune('0'+fa.sessionCounter)), "configOptions": ta.options()})
		return true
	case "session/set_config_option":
		cid, _ := p["configId"].(string)
		val, _ := p["value"].(string)
		ta.sets = append(ta.sets, cid+"="+val)
		switch cid {
		case "thinking":
			ta.thinking = val
		case "model":
			ta.model = val
			ta.thinking = "off" // the agent puts a model on its own level
		}
		fa.respond(id, map[string]any{"configOptions": ta.options()})
		return true
	}
	return false
}

func newEffortBackend(t *testing.T, ta *thinkingAgent) *Backend {
	t.Helper()
	return newEffortBackendWith(t, ta, map[string][]string{"m2": {"low", "medium", "high"}})
}

func newEffortBackendWith(t *testing.T, ta *thinkingAgent, efforts map[string][]string) *Backend {
	t.Helper()
	b, fa := newTestBackendCfg(t, false, func(c *Config) {
		c.Efforts, c.EffortDefault = true, "off"
		c.ModelEfforts = func() map[string][]string { return efforts }
	})
	fa.hook = ta.hook
	return b
}

func TestSetEffortSetsTheThinkingOption(t *testing.T) {
	ta := &thinkingAgent{thinking: "off", model: "m1"}
	b := newEffortBackend(t, ta)
	if !b.Capabilities().Efforts {
		t.Fatal("efforts capability off")
	}
	ctx := context.Background()
	sess, err := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	// m1 is no reasoning model in galopin's record: the agent's own levels do not count
	if _, err := b.SetEffort(ctx, "/w", sess.ID, "high"); err == nil {
		t.Fatal("an effort was accepted for a model galopin lists none for")
	}
	if _, err := b.SetModel(ctx, "/w", sess.ID, "m2"); err != nil {
		t.Fatal(err)
	}
	if _, err := b.SetEffort(ctx, "/w", sess.ID, "off"); err == nil {
		t.Fatal("off was accepted although galopin does not list it")
	}
	got, err := b.SetEffort(ctx, "/w", sess.ID, "high")
	if err != nil || got.Effort != "high" {
		t.Fatalf("SetEffort high: %v %+v", err, got)
	}
	if last := ta.sets[len(ta.sets)-1]; last != "thinking=high" {
		t.Fatalf("agent was sent %q", last)
	}
	if _, err := b.SetEffort(ctx, "/w", sess.ID, "ludicrous"); err == nil || !strings.Contains(err.Error(), "not one of") {
		t.Fatalf("an unoffered level was accepted: %v", err)
	}
	got, err = b.SetEffort(ctx, "/w", sess.ID, "")
	if err != nil || got.Effort != "" {
		t.Fatalf("SetEffort default: %v %+v", err, got)
	}
	if last := ta.sets[len(ta.sets)-1]; last != "thinking=off" {
		t.Fatalf("the default is the agent's %q level, sent %q", "off", last)
	}
}

// The agent keeps the last level set per model, so a new session on it starts there:
// galopin puts it back on the default, and a model change keeps the person's choice when
// the new model offers it.
func TestEffortDefaultOnNewSessionAndKeptAcrossModelChange(t *testing.T) {
	ta := &thinkingAgent{thinking: "high", model: "m1"}
	b := newEffortBackendWith(t, ta, map[string][]string{"m1": {"low", "medium", "high"}, "m2": {"low", "medium", "high"}})
	ctx := context.Background()
	sess, err := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if ta.sets[len(ta.sets)-1] != "thinking=off" {
		t.Fatalf("a new session was not put on the default level: %v", ta.sets)
	}
	if _, err := b.SetEffort(ctx, "/w", sess.ID, "medium"); err != nil {
		t.Fatal(err)
	}
	ta.sets = nil
	got, err := b.SetModel(ctx, "/w", sess.ID, "m2")
	if err != nil {
		t.Fatal(err)
	}
	if got.Effort != "medium" || ta.thinking != "medium" {
		t.Fatalf("the person's level was lost on a model change: session %q, agent %q, sets %v", got.Effort, ta.thinking, ta.sets)
	}
}

func TestModelsCarryTheEffortsGalopinKnows(t *testing.T) {
	ta := &thinkingAgent{thinking: "off", model: "m1"}
	b := newEffortBackend(t, ta)
	ctx := context.Background()
	if _, err := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{}); err != nil {
		t.Fatal(err)
	}
	ms, err := b.Models(ctx, "/w")
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range ms {
		switch m.ID {
		case "m2":
			if !m.Reasoning || strings.Join(m.Efforts, ",") != "low,medium,high" {
				t.Errorf("m2 = %+v", m)
			}
		case "m1":
			if m.Reasoning || len(m.Efforts) != 0 {
				t.Errorf("m1 = %+v", m)
			}
		}
	}
}

func TestSetEffortRefusedWithoutTheOption(t *testing.T) {
	b, _ := newTestBackend(t)
	if b.Capabilities().Efforts {
		t.Fatal("efforts on for an agent without the option")
	}
	if _, err := b.SetEffort(context.Background(), "/w", "x", "high"); err == nil {
		t.Fatal("SetEffort worked without the option")
	}
}

// A level the new model does not offer falls back to the default on a model change.
func TestEffortFallsBackToTheDefaultWhenTheNewModelDoesNotOfferIt(t *testing.T) {
	ta := &thinkingAgent{thinking: "off", model: "m2"}
	b := newEffortBackend(t, ta) // only m2 reasons
	ctx := context.Background()
	sess, err := b.CreateSession(ctx, "/w", backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.SetEffort(ctx, "/w", sess.ID, "high"); err != nil {
		t.Fatal(err)
	}
	got, err := b.SetModel(ctx, "/w", sess.ID, "m1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Effort != "" || ta.thinking != "off" {
		t.Fatalf("effort %q, agent %q: want the default", got.Effort, ta.thinking)
	}
}
