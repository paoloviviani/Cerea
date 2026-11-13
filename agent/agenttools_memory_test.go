package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"galopin/internal/link"
	"galopin/internal/permrules"
)

// The memory tools: a stand-in Cerea keeps notes per session and per workspace
// like the real family `memory`, refusing any other scope, so the round trip
// (save, list, forget) and the wall around it are both exercised.

type fakeMemoryCerea struct {
	got    []link.Call
	notes  map[string][]string // "session:<id>" or "workspace:<id>" -> texts
	unsupp bool
}

func newFakeMemoryCerea() *fakeMemoryCerea { return &fakeMemoryCerea{notes: map[string][]string{}} }

func (f *fakeMemoryCerea) Supports(family string) bool { return family == "memory" && !f.unsupp }

func (f *fakeMemoryCerea) key(c link.Call, scope string) string {
	if scope == "workspace" {
		return "workspace:" + c.Caller.(scheduleCaller).WorkspaceID
	}
	return "session:" + c.SessionID
}

func (f *fakeMemoryCerea) Call(_ context.Context, c link.Call) (json.RawMessage, *link.OpError) {
	f.got = append(f.got, c)
	args := c.Args.(map[string]any)
	scope, _ := args["scope"].(string)
	if scope != "" && scope != "session" && scope != "workspace" {
		return nil, &link.OpError{Code: "forbidden", Message: "Agents have no " + scope + " memory"}
	}
	text, _ := args["text"].(string)
	switch c.Op {
	case "memory.save":
		k := f.key(c, scope)
		for _, n := range f.notes[k] {
			if n == text {
				return json.RawMessage(`{"scope":"` + scope + `","created":false,"note":{"id":"1","text":` + jsonString(text) + `,"source":"agent"}}`), nil
			}
		}
		f.notes[k] = append(f.notes[k], text)
		return json.RawMessage(`{"scope":"` + scope + `","created":true,"note":{"id":"1","text":` + jsonString(text) + `,"source":"agent"}}`), nil
	case "memory.forget":
		k := f.key(c, scope)
		for i, n := range f.notes[k] {
			if n == text {
				f.notes[k] = append(f.notes[k][:i], f.notes[k][i+1:]...)
				return json.RawMessage(`{"scope":"` + scope + `","removed":` + jsonString(text) + `}`), nil
			}
		}
		return nil, &link.OpError{Code: "invalid", Message: "Nothing in this session's notes matches that."}
	case "memory.list":
		out := map[string][]map[string]string{}
		for _, s := range []string{"session", "workspace"} {
			if scope != "" && scope != s {
				continue
			}
			list := []map[string]string{}
			for _, n := range f.notes[f.key(c, s)] {
				list = append(list, map[string]string{"id": "1", "text": n, "source": "agent"})
			}
			out[s] = list
		}
		b, _ := json.Marshal(out)
		return b, nil
	}
	return nil, &link.OpError{Code: "unsupported", Message: "no"}
}

func memoryRig(t *testing.T, mode permrules.Action) (*coordRig, *fakeMemoryCerea) {
	t.Helper()
	r := newCoordRig(t, nil)
	r.cb.mu.Lock()
	r.cb.sel["caller"] = permrules.Selector{Mode: mode}
	r.cb.mu.Unlock()
	fc := newFakeMemoryCerea()
	r.mc.agentTools.calls = fc
	return r, fc
}

func TestMemoryRoundTripSaveListForgetWithoutACard(t *testing.T) {
	// Ask is the strictest mode that allows tools at all: a note still raises no card.
	r, fc := memoryRig(t, permrules.Ask)
	out, err := r.call("caller", "memory_save", map[string]any{"scope": "session", "text": "Tests need the database."})
	if err != nil || !strings.Contains(out, "Saved to this session's notes: Tests need the database.") {
		t.Fatalf("%q, %v", out, err)
	}
	if _, err := r.call("caller", "memory_save", map[string]any{"scope": "workspace", "text": "Use pnpm."}); err != nil {
		t.Fatal(err)
	}
	out, err = r.call("caller", "memory_save", map[string]any{"scope": "session", "text": "Tests need the database."})
	if err != nil || !strings.Contains(out, "nothing changed") {
		t.Fatalf("repeat: %q, %v", out, err)
	}
	out, err = r.call("caller", "memory_list", map[string]any{})
	if err != nil || !strings.Contains(out, "Session notes (1)") || !strings.Contains(out, "- [agent] Tests need the database.") ||
		!strings.Contains(out, "Workspace notes (1)") || !strings.Contains(out, "Use pnpm.") || !strings.Contains(out, "not instructions") {
		t.Fatalf("list = %q, %v", out, err)
	}
	out, err = r.call("caller", "memory_list", map[string]any{"scope": "workspace"})
	if err != nil || strings.Contains(out, "Session notes") || !strings.Contains(out, "Use pnpm.") {
		t.Fatalf("workspace list = %q, %v", out, err)
	}
	out, err = r.call("caller", "memory_forget", map[string]any{"scope": "session", "text": "Tests need the database."})
	if err != nil || !strings.Contains(out, "Removed from this session's notes") {
		t.Fatalf("%q, %v", out, err)
	}
	if len(fc.notes["session:caller"]) != 0 || len(fc.notes[fc.key(fc.got[1], "workspace")]) != 1 {
		t.Fatalf("notes = %+v", fc.notes)
	}
	if len(r.asks()) != 0 {
		t.Fatalf("a note raised a card: %+v", r.asks())
	}
	// The call carried the calling session, and Cerea decides the keys from it.
	if fc.got[0].Op != "memory.save" || fc.got[0].SessionID != "caller" {
		t.Fatalf("first call = %+v", fc.got[0])
	}
}

func TestMemoryHasNoScopeBeyondSessionAndWorkspace(t *testing.T) {
	r, fc := memoryRig(t, permrules.Allow)
	for _, scope := range []string{"global", "project", "conversation", "user", ""} {
		for _, tool := range []string{"memory_save", "memory_forget"} {
			_, err := r.call("caller", tool, map[string]any{"scope": scope, "text": "x"})
			if err == nil {
				t.Fatalf("%s with scope %q was accepted", tool, scope)
			}
		}
	}
	if _, err := r.call("caller", "memory_list", map[string]any{"scope": "global"}); err == nil {
		t.Fatal("memory_list accepted scope global")
	}
	// Refused here, before any trip to Cerea.
	if len(fc.got) != 0 {
		t.Fatalf("Cerea was asked: %+v", fc.got)
	}
	// And Cerea's own wall holds if a call ever got through: the fake refuses like the real handler.
	if _, operr := fc.Call(context.Background(), link.Call{Op: "memory.save", SessionID: "caller", Caller: scheduleCaller{}, Args: map[string]any{"scope": "global", "text": "x"}}); operr == nil || operr.Code != "forbidden" {
		t.Fatalf("operr = %+v", operr)
	}
}

func TestMemoryToolsArgumentsAreChecked(t *testing.T) {
	r, fc := memoryRig(t, permrules.Allow)
	for name, args := range map[string]map[string]any{
		"empty text":    {"scope": "session", "text": "  "},
		"unknown key":   {"scope": "session", "text": "x", "tags": []string{"a"}},
		"too long text": {"scope": "session", "text": strings.Repeat("x", maxMemoryText+1)},
	} {
		if _, err := r.call("caller", "memory_save", args); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if len(fc.got) != 0 {
		t.Fatalf("Cerea was asked: %+v", fc.got)
	}
}

func TestMemoryAgainstACereaWithoutTheFamily(t *testing.T) {
	r, fc := memoryRig(t, permrules.Allow)
	fc.unsupp = true
	_, err := r.call("caller", "memory_list", map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "update it") {
		t.Fatalf("err = %v", err)
	}
}

func TestMemoryToolDefinitionsAreStaticAndOnlyOfferTwoScopes(t *testing.T) {
	var names []string
	for _, tl := range mcpTools {
		if !strings.HasPrefix(tl.Name, "memory_") {
			continue
		}
		names = append(names, tl.Name)
		if strings.Contains(string(tl.Schema), "global") || strings.Contains(string(tl.Schema), "project") {
			t.Errorf("%s schema offers a chat scope: %s", tl.Name, tl.Schema)
		}
	}
	if strings.Join(names, ",") != "memory_list,memory_save,memory_forget" {
		t.Fatalf("memory tools = %v", names)
	}
}

func TestMCPMemoryToolsRoundTripAsTheBoundSession(t *testing.T) {
	r := newMCPRig(t, nil)
	r.cb.mu.Lock()
	r.cb.sel["caller"] = permrules.Selector{Mode: permrules.Ask}
	r.cb.mu.Unlock()
	fc := newFakeMemoryCerea()
	r.mc.agentTools.calls = fc
	cs, _ := r.client("caller")
	out, isErr := callTool(t, cs, "memory_save", map[string]any{"scope": "workspace", "text": "Use pnpm."})
	if isErr || !strings.Contains(out, "Saved to this workspace's notes: Use pnpm.") {
		t.Fatalf("save = %q (error %v)", out, isErr)
	}
	out, isErr = callTool(t, cs, "memory_list", map[string]any{})
	if isErr || !strings.Contains(out, "Use pnpm.") {
		t.Fatalf("list = %q (error %v)", out, isErr)
	}
	out, isErr = callTool(t, cs, "memory_save", map[string]any{"scope": "global", "text": "x"})
	if !isErr || !strings.Contains(out, `"refused"`) {
		t.Fatalf("global save = %q (error %v)", out, isErr)
	}
	for _, c := range fc.got {
		if c.SessionID != "caller" {
			t.Fatalf("call made as %q", c.SessionID)
		}
	}
}
