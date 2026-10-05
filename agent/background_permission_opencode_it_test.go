package main

import (
	"fmt"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/policy"
	"galopin/internal/sessions"
)

// delegateGeneral prompts root to run a general subagent (foreground, or in the
// background) whose one call is the given tool call, and returns the child's
// session id.
func (r *permRig) delegateGeneral(root backend.Session, marker string, background bool, call map[string]any) (string, int) {
	r.t.Helper()
	r.script(map[string]any{
		"toolCalls": []map[string]any{{
			"id": fmt.Sprintf("call_task%d", r.next()), "name": "task",
			"arguments": mustJSON2(map[string]any{"description": "subagent test", "prompt": marker, "subagent_type": "general", "background": background}),
		}},
		"routes": []map[string]any{{
			"contains": marker,
			"scenario": map[string]any{
				"toolCalls": []map[string]any{call}, "content": []string{"child done"}, "chunkDelayMs": 5, "finishReason": "stop",
			},
		}},
	})
	return r.startDelegation(root)
}

func (r *permRig) bashCall(command string) map[string]any {
	return map[string]any{
		"id": fmt.Sprintf("call_b%d", r.next()), "name": "bash",
		"arguments": mustJSON2(map[string]any{"command": command, "description": "run"}),
	}
}

// TestBackgroundSubagentPermissions: under a root on Allow a general subagent,
// foreground or background, asks only where the machine's ceiling caps the key.
func TestBackgroundSubagentPermissions(t *testing.T) {
	for _, tc := range []struct {
		name string
		max  map[string]string
		tool string
		ask  bool
	}{
		{"no ceiling", nil, "bash", false},
		{"no ceiling", nil, "edit", false},
		{"bash=ask", map[string]string{"bash": "ask"}, "bash", true},
		{"bash=ask", map[string]string{"bash": "ask"}, "edit", false},
	} {
		for _, bg := range []bool{false, true} {
			name := fmt.Sprintf("%s/%s/bg=%v", tc.name, tc.tool, bg)
			t.Run(name, func(t *testing.T) {
				var perm policy.Permission
				if tc.max != nil {
					perm.Max = map[string]string{}
					for k, v := range tc.max {
						perm.Max[k] = v
					}
				}
				r := newPermRig(t, permRigOpts{background: true, perm: perm})
				root := r.session("bg-root", "")
				r.setMode(root, "allow")
				call := r.bashCall("sleep 6")
				if tc.tool == "edit" {
					call = r.writeTool("bg.txt")
				}
				id, mark := r.delegateGeneral(root, "bg-marker", bg, call)
				tool := map[bool]string{true: "bash", false: "write"}[tc.tool == "bash"]
				// A card is never shown for an ask the root's mode allows: the
				// machine answers it. Collect the asks the child raises and
				// answer none of them by hand, so a stuck ask times out.
				done := r.hub.wait(t, mark, 60*time.Second, "the child's "+tool+" to finish or ask", func(e sessions.Envelope) bool {
					p := e.Event.Part
					if e.SessionID != id {
						return false
					}
					if e.Event.Kind == backend.EventPermissionAsked {
						return len(r.mc.mat.PendingPermissionRequests(id)) > 0 && tc.ask
					}
					return e.Event.Kind == backend.EventPart && p != nil && p.Tool == tool && p.ToolStatus == backend.ToolCompleted
				})
				pending := r.mc.mat.PendingPermissionRequests(id)
				switch {
				case tc.ask && len(pending) != 1:
					t.Fatalf("want exactly one answerable ask (the ceiling caps %s), got %+v (event %s)", tc.tool, pending, done.Event.Kind)
				case !tc.ask && len(pending) != 0:
					t.Fatalf("want no ask under Allow, got %+v", pending)
				case tc.ask:
					r.reply(backend.Session{ID: id}, pending[0].ID, "once")
					r.reply(backend.Session{ID: id}, pending[0].ID, "once") // already answered: resolved, never an error
				}
				if tc.ask {
					r.hub.wait(t, mark, 60*time.Second, "the child's "+tool+" to finish", func(e sessions.Envelope) bool {
						p := e.Event.Part
						return e.SessionID == id && e.Event.Kind == backend.EventPart && p != nil && p.Tool == tool && p.ToolStatus == backend.ToolCompleted
					})
				}
				if bg {
					// The roster the panel's banner reads clears when the child ends.
					deadline := time.Now().Add(30 * time.Second)
					for cs := r.mc.mat.ChildSummary(root.ID); cs != nil && cs.Running > 0; cs = r.mc.mat.ChildSummary(root.ID) {
						if time.Now().After(deadline) {
							t.Fatalf("the root still reports %d running children after the child finished", cs.Running)
						}
						time.Sleep(200 * time.Millisecond)
					}
				}
				if bg && tc.tool == "bash" {
					// A background child must not keep its root busy: the root's
					// turn ends while the child's sleep is still running.
					idleAt, doneAt := -1, -1
					for i, e := range r.hub.since(mark) {
						p := e.Event.Part
						if e.SessionID == root.ID && e.Event.Kind == backend.EventStatus && e.Event.Status == backend.StatusIdle && idleAt < 0 {
							idleAt = i
						}
						if e.SessionID == id && e.Event.Kind == backend.EventPart && p != nil && p.Tool == "bash" && p.ToolStatus == backend.ToolCompleted && doneAt < 0 {
							doneAt = i
						}
					}
					if idleAt < 0 || idleAt > doneAt {
						t.Errorf("the root went idle at event %d, the child's bash finished at %d: want idle first", idleAt, doneAt)
					}
				}
			})
		}
	}
}
