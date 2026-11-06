package mcpconn

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestLocalClientListsAndCallsWithoutTouchingTheLink(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), nil)
	tools, err := r.hub.LocalTools(t_ctx(t), "fake")
	if err != nil || len(tools) != 3 || tools[0].Name != "read_file" {
		t.Fatalf("tools = %+v, %v", tools, err)
	}
	res, err := r.hub.LocalCall(t_ctx(t), "fake", "read_file", json.RawMessage(`{"path":"a"}`), 0)
	if err != nil || res.IsError || len(res.Content) != 1 || !strings.Contains(string(res.Content[0]), "called read_file v1") {
		t.Fatalf("call = %+v, %v", res, err)
	}
	bad, err := r.hub.LocalCall(t_ctx(t), "fake", "boom", nil, 0)
	if err != nil || !bad.IsError {
		t.Fatalf("boom = %+v, %v", bad, err)
	}
	select {
	case f := <-r.frames:
		t.Fatalf("a frame reached the link: %s", f.message)
	case c := <-r.closed:
		t.Fatalf("a closed frame reached the link: %+v", c)
	default:
	}
	// The audit line is the chat's own (server, tool, outcome; never arguments).
	got := strings.Join(r.auditLines(), "|")
	if !strings.Contains(got, "fake read_file ok") || !strings.Contains(got, "fake boom error") {
		t.Fatalf("audit = %q", got)
	}
}

func TestLocalClientHonoursTheMachinesCeiling(t *testing.T) {
	r := newRig(t, fakeConfig("", `, "allowedTools": ["read_file"]`), nil)
	tools, err := r.hub.LocalTools(t_ctx(t), "fake")
	if err != nil || len(tools) != 1 || tools[0].Name != "read_file" {
		t.Fatalf("tools = %+v, %v", tools, err)
	}
	if _, err := r.hub.LocalCall(t_ctx(t), "fake", "write_file", nil, 0); err == nil || !strings.Contains(err.Error(), "not allowed on this machine") {
		t.Fatalf("a tool outside allowedTools ran: %v", err)
	}
	if !strings.Contains(strings.Join(r.auditLines(), "|"), "fake write_file refused") {
		t.Fatalf("audit = %v", r.auditLines())
	}
}

func TestLocalClientReopensAfterTheServerEnds(t *testing.T) {
	r := newRig(t, fakeConfig("crash", ""), nil)
	if _, err := r.hub.LocalTools(t_ctx(t), "fake"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.hub.LocalCall(t_ctx(t), "fake", "read_file", nil, 5*time.Second); err == nil {
		t.Fatal("a crashing server answered")
	}
	// The next use opens a fresh channel rather than hanging on the dead one.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if _, err := r.hub.LocalTools(ctx, "fake"); err != nil {
		t.Fatalf("no reopen: %v", err)
	}
}

func TestLocalClientUnknownServer(t *testing.T) {
	r := newRig(t, fakeConfig("", ""), nil)
	if _, err := r.hub.LocalTools(t_ctx(t), "nope"); err == nil || !strings.Contains(err.Error(), "no connector named nope") {
		t.Fatalf("err = %v", err)
	}
}
