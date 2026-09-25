//go:build unix

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"galopin/internal/link"
	"galopin/internal/policy"
	"galopin/internal/sessions"
	"galopin/internal/terminal"
	"galopin/internal/workspaces"
)

func terminalMachine(t *testing.T, pol policy.Policy) (*machine, string) {
	t.Helper()
	// A spawned shell must never write into /tmp (tmpfs on this box): point
	// TMPDIR at the same on-disk cache directory opencode_it_test.go's
	// itTmpDir uses for the same reason.
	t.Setenv("TMPDIR", itTmpDir(t))
	reg, err := workspaces.Load(filepath.Join(t.TempDir(), "workspaces.json"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	w, err := reg.Create("ws", dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	back := &fakeBackend{}
	mc := newMachine(reg, back, sessions.New(back, pol), pol)
	t.Cleanup(func() {
		mc.terminals.CloseAll(true)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = mc.terminals.WaitAllClosed(ctx)
	})
	return mc, w.ID
}

func allowTerminalPolicy(max int) policy.Policy {
	pol := policy.Default()
	pol.Terminal = policy.TerminalAllowed
	pol.MaxTerminals = max
	return pol
}

func TestTerminalOpsRefusedWhenDenied(t *testing.T) {
	mc, wsID := terminalMachine(t, policy.Default())
	ctx := context.Background()
	for _, op := range []string{"terminal.list", "terminal.open"} {
		args := json.RawMessage(`{"workspaceId":"` + wsID + `","cols":80,"rows":24}`)
		_, operr := mc.Handle(ctx, op, args)
		if operr == nil || operr.Code != "forbidden" {
			t.Fatalf("%s with denied policy = %+v, want forbidden", op, operr)
		}
	}
}

func TestTerminalMaxTerminals(t *testing.T) {
	if !terminal.Supported {
		t.Skip("terminals are not supported on this OS")
	}
	mc, wsID := terminalMachine(t, allowTerminalPolicy(1))
	ctx := context.Background()
	openArgs := json.RawMessage(`{"workspaceId":"` + wsID + `","cols":80,"rows":24}`)

	if _, operr := mc.Handle(ctx, "terminal.open", openArgs); operr != nil {
		t.Fatalf("first terminal.open: %+v", operr)
	}
	_, operr := mc.Handle(ctx, "terminal.open", openArgs)
	if operr == nil || operr.Code != "invalid" {
		t.Fatalf("terminal.open beyond maxTerminals = %+v, want invalid", operr)
	}
}

func TestTerminalOpenAttachEchoOverRealPTYThroughDispatch(t *testing.T) {
	if !terminal.Supported {
		t.Skip("terminals are not supported on this OS")
	}
	mc, wsID := terminalMachine(t, allowTerminalPolicy(8))
	ctx := context.Background()

	res, operr := mc.Handle(ctx, "terminal.open", json.RawMessage(`{"workspaceId":"`+wsID+`","cols":80,"rows":24}`))
	if operr != nil {
		t.Fatalf("terminal.open: %+v", operr)
	}
	body, _ := json.Marshal(res)
	var opened struct {
		Terminal terminal.Snapshot `json:"terminal"`
	}
	if err := json.Unmarshal(body, &opened); err != nil {
		t.Fatalf("unmarshal terminal.open result: %v", err)
	}
	termID := opened.Terminal.ID
	if termID == "" {
		t.Fatal("terminal.open returned no id")
	}

	// Collect what would go out as term.output over the link: since AttachLink
	// was never called, mc.terminalOutput drops frames, so attach directly
	// against the *terminal.Terminal and decode through the wire codec — the
	// dispatch layer (op routing, policy, maxTerminals, channel bookkeeping)
	// is what this test is really exercising; codec_it_test.go in
	// internal/terminal separately proves the codec round trip.
	tm, err := mc.terminals.Get(termID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	attachArgs, _ := json.Marshal(map[string]any{"terminalId": termID, "channel": "c1"})
	attachRes, operr := mc.Handle(ctx, "terminal.attach", attachArgs)
	if operr != nil {
		t.Fatalf("terminal.attach: %+v", operr)
	}
	attachBody, _ := json.Marshal(attachRes)
	var attached struct {
		Reset   bool   `json:"reset"`
		Prelude string `json:"prelude"`
	}
	if err := json.Unmarshal(attachBody, &attached); err != nil {
		t.Fatal(err)
	}
	if !attached.Reset {
		t.Error("a fresh attach with no `from` must be a reset")
	}
	if _, err := base64.StdEncoding.DecodeString(attached.Prelude); err != nil {
		t.Errorf("prelude must be valid base64: %v", err)
	}

	mc.mu.Lock()
	if mc.channelTerminal["c1"] != termID {
		t.Errorf("channelTerminal[c1] = %q, want %q", mc.channelTerminal["c1"], termID)
	}
	mc.mu.Unlock()

	// Route input the way an inbound binary term.input frame actually would:
	// through machine.HandleBinary, keyed by the channel terminal.attach
	// just registered — not a direct tm.Write, so this exercises the same
	// channel-to-terminal bookkeeping a real link connection relies on.
	mc.HandleBinary(link.BinTermInput, "c1", 0, []byte("echo $((6*7))\n"))

	deadline := time.Now().Add(5 * time.Second)
	var seen string
	for time.Now().Before(deadline) {
		seen = string(tm.RingContent())
		if strings.Contains(seen, "42") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(seen, "42") {
		t.Fatalf("never saw 42 in the ring; got %q", seen)
	}

	if _, operr := mc.Handle(ctx, "terminal.close", json.RawMessage(`{"terminalId":"`+termID+`","force":true}`)); operr != nil {
		t.Fatalf("terminal.close: %+v", operr)
	}
}
