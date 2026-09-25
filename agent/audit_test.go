//go:build unix

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"galopin/internal/link"
)

func TestAuditLoggerBasics(t *testing.T) {
	dir := t.TempDir()
	a, err := newAuditLogger(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()

	a.terminalOpen("t1", "sub/dir", "/bin/bash")
	a.terminalClose("t1")
	a.refusal("terminal.open", "terminal denied by machine policy")

	body, err := os.ReadFile(filepath.Join(dir, "audit.log"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(body)), "\n")
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d: %s", len(lines), body)
	}
	for _, line := range lines {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("line is not valid JSON: %s: %v", line, err)
		}
		if _, ok := entry["at"]; !ok {
			t.Errorf("entry missing a timestamp: %s", line)
		}
	}
	if !strings.Contains(string(body), `"action":"terminal.open"`) {
		t.Errorf("missing terminal.open entry: %s", body)
	}
	if !strings.Contains(string(body), `"action":"refusal"`) {
		t.Errorf("missing refusal entry: %s", body)
	}
}

func TestNilAuditLoggerIsSafe(t *testing.T) {
	var a *auditLogger
	// None of these must panic on a nil *auditLogger — machines built by
	// tests that never call AttachAudit rely on this.
	a.terminalOpen("t1", ".", "/bin/sh")
	a.terminalClose("t1")
	a.refusal("terminal.open", "denied")
	if err := a.Close(); err != nil {
		t.Errorf("Close on nil: %v", err)
	}
}

// TestAuditLogNeverContainsTerminalContent runs a real terminal end to end
// (open, attach, input carrying a secret marker, output carrying a
// different marker, close) through the same dispatch path 'run' uses, with
// a real audit logger attached, and asserts the on-disk audit.log contains
// neither marker — only identifiers, paths and timestamps, per PROTOCOL.md
// §9.3's "never records keystrokes, output or content."
func TestAuditLogNeverContainsTerminalContent(t *testing.T) {
	mc, wsID := terminalMachine(t, allowTerminalPolicy(8))
	auditDir := t.TempDir()
	a, err := newAuditLogger(auditDir)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	mc.AttachAudit(a)

	ctx := context.Background()
	res, operr := mc.Handle(ctx, "terminal.open", json.RawMessage(`{"workspaceId":"`+wsID+`","cols":80,"rows":24}`))
	if operr != nil {
		t.Fatalf("terminal.open: %+v", operr)
	}
	var opened struct {
		Terminal struct {
			ID string `json:"id"`
		} `json:"terminal"`
	}
	rawRes, _ := json.Marshal(res)
	if err := json.Unmarshal(rawRes, &opened); err != nil {
		t.Fatal(err)
	}
	termID := opened.Terminal.ID

	attachArgs, _ := json.Marshal(map[string]any{"terminalId": termID, "channel": "audit-c1"})
	if _, operr := mc.Handle(ctx, "terminal.attach", attachArgs); operr != nil {
		t.Fatalf("terminal.attach: %+v", operr)
	}

	const inputMarker = "MARKER_INPUT_39fbe2"
	const outputMarker = "MARKER_OUTPUT_84acd1"
	mc.HandleBinary(link.BinTermInput, "audit-c1", 0, []byte("echo "+outputMarker+" # "+inputMarker+"\n"))

	tm, err := mc.terminals.Get(termID)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(string(tm.RingContent()), outputMarker) {
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(string(tm.RingContent()), outputMarker) {
		t.Fatal("the echoed marker never appeared in the terminal's own output")
	}

	if _, operr := mc.Handle(ctx, "terminal.close", json.RawMessage(`{"terminalId":"`+termID+`","force":true}`)); operr != nil {
		t.Fatalf("terminal.close: %+v", operr)
	}
	ctxWait, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = mc.terminals.WaitAllClosed(ctxWait)

	body, err := os.ReadFile(filepath.Join(auditDir, "audit.log"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), inputMarker) || strings.Contains(string(body), outputMarker) {
		t.Fatalf("audit.log leaked terminal content: %s", body)
	}
	if !strings.Contains(string(body), `"action":"terminal.open"`) || !strings.Contains(string(body), `"action":"terminal.close"`) {
		t.Errorf("audit.log missing expected open/close entries: %s", body)
	}
}
