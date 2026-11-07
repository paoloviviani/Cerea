package acp

import (
	"context"
	"testing"
	"time"

	"galopin/internal/backend"
)

// A mode update into a mode that skips asks is put back, and no permission
// answer is given while that is in flight; an allow is refused if it cannot be put back.
func TestPermissionAnswerWaitsForTheModePutBack(t *testing.T) {
	b, fa := newTestBackendCfg(t, false, func(c *Config) { c.HiddenModes = []string{"auto"}; c.ForceMode = "approve" })
	fa.setModeHold = make(chan struct{})
	ctx := context.Background()
	sess, err := b.CreateSession(ctx, "/work", backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	st, _ := b.reg.get(sess.ID)
	st.mu.Lock()
	st.pending["p1"] = pendingPermission{jsonrpcID: []byte("7"), options: []permissionOption{{OptionID: "yes", Kind: "allow_once"}}}
	st.mu.Unlock()

	fa.update(sess.ID, map[string]any{"sessionUpdate": "current_mode_update", "currentModeId": "auto"})
	deadline := time.Now().Add(5 * time.Second)
	for {
		st.mu.Lock()
		busy := st.reasserting != nil
		st.mu.Unlock()
		if busy {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the put-back never started")
		}
		time.Sleep(5 * time.Millisecond)
	}
	answered := make(chan error, 1)
	go func() { answered <- b.ReplyPermission(ctx, "/work", sess.ID, "p1", backend.DecisionOnce, "") }()
	select {
	case err := <-answered:
		t.Fatalf("answered while the mode was being put back: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	close(fa.setModeHold) // the agent accepts set_mode
	select {
	case err := <-answered:
		if err != nil {
			t.Fatalf("answer after the put-back: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the answer never came after the put-back")
	}
	if st.modeID != "approve" {
		t.Errorf("mode = %q, want approve", st.modeID)
	}
}

func TestPermissionAllowIsRefusedWhileTheSessionIsInAnAskSkippingMode(t *testing.T) {
	b, _ := newTestBackendCfg(t, false, func(c *Config) { c.HiddenModes = []string{"auto"}; c.ForceMode = "approve" })
	sess, err := b.CreateSession(context.Background(), "/work", backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	st, _ := b.reg.get(sess.ID)
	st.mu.Lock()
	st.modeID = "auto"
	st.mu.Unlock()
	if err := b.waitReasserted(context.Background(), st, backend.DecisionOnce); err == nil {
		t.Error("an allow was let through in auto")
	}
	if err := b.waitReasserted(context.Background(), st, backend.DecisionReject); err != nil {
		t.Errorf("a reject was refused: %v", err)
	}
}

// A put-back that a newer mode change overtook must not overwrite it.
func TestStalePutBackDoesNotOverwriteANewerMode(t *testing.T) {
	b, fa := newTestBackendCfg(t, false, func(c *Config) { c.HiddenModes = []string{"auto"}; c.ForceMode = "approve" })
	fa.setModeHold = make(chan struct{})
	sess, err := b.CreateSession(context.Background(), "/work", backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	st, _ := b.reg.get(sess.ID)
	fa.update(sess.ID, map[string]any{"sessionUpdate": "current_mode_update", "currentModeId": "auto"})
	deadline := time.Now().Add(5 * time.Second)
	for {
		st.mu.Lock()
		busy := st.reasserting != nil
		st.mu.Unlock()
		if busy {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the put-back never started")
		}
		time.Sleep(5 * time.Millisecond)
	}
	// While it is in flight the user moves the session to plan.
	fa.update(sess.ID, map[string]any{"sessionUpdate": "current_mode_update", "currentModeId": "plan"})
	time.Sleep(100 * time.Millisecond)
	close(fa.setModeHold)
	time.Sleep(300 * time.Millisecond)
	st.mu.Lock()
	mode := st.modeID
	st.mu.Unlock()
	if mode != "plan" {
		t.Errorf("a stale put-back overwrote the newer mode: %q", mode)
	}
}
