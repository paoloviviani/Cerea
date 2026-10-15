package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/sessions"
)

// ADR 0097 against the real binary: galopin answers every ask and writes no
// rule into a session.

// dbRuleCount reads, read-only, how many rules opencode's own database holds for
// a session ("" when python3 is not available).
func (r *permRig) dbRuleCount(id string) (int, bool) {
	r.t.Helper()
	py, err := exec.LookPath("python3")
	if err != nil {
		return 0, false
	}
	db := filepath.Join(r.root, "data", "opencode", "opencode.db")
	if _, err := os.Stat(db); err != nil {
		return 0, false
	}
	code := "import sqlite3,sys,json\\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\\nrow=c.execute('select permission from session where id=?',(sys.argv[2],)).fetchone()\\nprint(0 if not row or not row[0] else len(json.loads(row[0])))"
	out, err := exec.Command(py, "-I", "-c", strings.ReplaceAll(code, "\\n", "\n"), db, id).Output()
	if err != nil {
		r.t.Fatalf("reading opencode.db: %v", err)
	}
	var n int
	_, _ = fmt.Sscanf(strings.TrimSpace(string(out)), "%d", &n)
	return n, true
}

// "Allow always" is a galopin-side exception: opencode is answered once and its
// session carries no rule for it (API and database), and the next identical
// write is answered by the exception with no card.
func TestAnswerAlwaysLeavesNoRuleInTheSession(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	s := r.session("always", "")
	ask, _, mark := r.try(s, "always-1.txt")
	if ask == nil {
		t.Fatal("a write on Ask did not raise a card")
	}
	r.reply(s, ask.ID, "always")
	r.idle(s, mark)
	if !r.exists("always-1.txt") {
		t.Fatal("always did not let the write through")
	}
	if got := len(r.exceptions(s)); got != 1 {
		t.Fatalf("exceptions = %d, want the one galopin keeps", got)
	}
	if rules := r.sessionRules(s.ID); len(rules) != 0 {
		t.Errorf("session.permission over the API = %+v, want none", rules)
	}
	if n, ok := r.dbRuleCount(s.ID); ok && n != 0 {
		t.Errorf("session.permission in opencode.db holds %d rules, want 0", n)
	}
	ask, part, _ := r.try(s, "always-1.txt")
	if ask != nil || part == nil || part.ToolStatus != backend.ToolCompleted {
		t.Errorf("the exception did not answer the repeat: ask=%v part=%+v", ask, part)
	}
}

// A session's stored rule count stays constant across ten mode changes, with a
// prompt after each.
func TestAnswerRuleCountIsConstantAcrossTenModeChanges(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	s := r.session("ten", "")
	before := len(r.sessionRules(s.ID))
	for i, m := range []string{"deny", "allow", "ask", "deny", "allow", "ask", "allow", "deny", "ask", "allow"} {
		r.setMode(s, m)
		ask, _, mark := r.try(s, fmt.Sprintf("ten-%d.txt", i))
		if ask != nil {
			r.reply(s, ask.ID, "reject")
		}
		r.idle(s, mark)
		if got := len(r.sessionRules(s.ID)); got != before {
			t.Fatalf("after mode change %d (%s) the session holds %d rules, want the constant %d", i+1, m, got, before)
		}
	}
	if n, ok := r.dbRuleCount(s.ID); ok && n != before {
		t.Errorf("opencode.db holds %d rules, want %d", n, before)
	}
}

// Plan -> build -> spawn a subagent: the child edits on its first turn with no
// card and no rule written. Ask: its first edit is a card. Plan: refused.
func TestAnswerSubagentFirstTurnFollowsTheRootsWord(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	s := r.session("root", "")
	r.setMode(s, "deny")
	if ask, part, _ := r.try(s, "root-plan.txt"); ask != nil || !refused(part) || r.exists("root-plan.txt") {
		t.Fatalf("Plan root edit: ask=%v part=%+v exists=%v, want refused", ask, part, r.exists("root-plan.txt"))
	}
	r.setMode(s, "allow")
	child, mark := r.delegate(s, "answer-allow", "child-allow.txt")
	ask, part := r.childOutcome(child, mark)
	if ask != nil || part == nil || part.ToolStatus != backend.ToolCompleted || !r.exists("child-allow.txt") {
		t.Fatalf("plan -> allow -> spawn: the child's first edit: ask=%v part=%+v exists=%v, want it to run with no card", ask, part, r.exists("child-allow.txt"))
	}
	if rules := r.sessionRules(child); len(rules) > 2 {
		t.Errorf("the child holds %d stored rules, want only opencode's own two task denies", len(rules))
	}

	// A fresh root for the next delegation: late events of the first child would
	// otherwise be taken for the second one's.
	s = r.session("root-ask", "")
	child, mark = r.delegate(s, "answer-ask", "child-ask.txt")
	ask, _ = r.childOutcome(child, mark)
	if ask == nil || ask.Tool != "edit" {
		t.Fatalf("Ask root: the child's first edit raised %v, want a card", ask)
	}
	r.reply(backend.Session{ID: child}, ask.ID, "reject")
}

// Plan root -> the task tool spawns (not an effect in itself) -> the child's
// read is answered once and its edit is refused at its first effectful call.
func TestAnswerPlanRootChildReadsButCannotEdit(t *testing.T) {
	r := newPermRig(t, permRigOpts{})
	if err := os.WriteFile(filepath.Join(r.work, "notes.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := r.session("plan-root", "")
	r.setMode(s, "deny")
	child, mark := r.delegateCall(s, "plan-read", map[string]any{
		"id": fmt.Sprintf("call_r%d", r.next()), "name": "read",
		"arguments": mustJSON2(map[string]any{"filePath": filepath.Join(r.work, "notes.txt")}),
	})
	ask, part := r.childOutcomeOf("read", child, mark)
	if ask != nil || part == nil || part.ToolStatus != backend.ToolCompleted {
		t.Fatalf("Plan root's child read: ask=%v part=%+v, want it answered once", ask, part)
	}
	s = r.session("plan-root-2", "")
	r.setMode(s, "deny")
	child2, mark2 := r.delegate(s, "plan-edit", "child-plan.txt")
	ask, part = r.childOutcome(child2, mark2)
	if ask != nil || part == nil || !refused(part) || r.exists("child-plan.txt") {
		t.Fatalf("Plan root's child edit: ask=%v part=%+v exists=%v, want refused with no card", ask, part, r.exists("child-plan.txt"))
	}
}

// The measured cost of an ask with the real function (ADR 0097): the same read
// with and without the floor. Numbers are logged; a p50 over 300 ms fails so it
// is reported before anything is decided on it.
func TestAnswerLatencyPerRead(t *testing.T) {
	const n = 60
	run := func(o permRigOpts) []time.Duration {
		r := newPermRig(t, o)
		r.bypass = false
		if err := os.WriteFile(filepath.Join(r.work, "a.txt"), []byte("hello\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		s := r.session("lat", "")
		var d []time.Duration
		for i := 0; i < n+5; i++ {
			r.script(map[string]any{"toolCalls": []map[string]any{{
				"id": fmt.Sprintf("call_l%d", r.next()), "name": "read",
				"arguments": mustJSON2(map[string]any{"filePath": filepath.Join(r.work, "a.txt")}),
			}}})
			mark := r.hub.mark()
			t0 := time.Now()
			if err := r.promptSession(s, "read"); err != nil {
				t.Fatal(err)
			}
			r.hub.wait(t, mark, 60*time.Second, "read done", func(e sessions.Envelope) bool {
				p := e.Event.Part
				return e.SessionID == s.ID && e.Event.Kind == backend.EventPart && p != nil && p.Tool == "read" && p.ToolStatus == backend.ToolCompleted
			})
			el := time.Since(t0)
			r.idle(s, mark)
			if i >= 5 {
				d = append(d, el)
			}
		}
		return d
	}
	pct := func(d []time.Duration, p float64) time.Duration {
		s := append([]time.Duration(nil), d...)
		sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
		return s[int(float64(len(s)-1)*p)]
	}
	base := run(permRigOpts{noFloor: true})
	asks := run(permRigOpts{})
	d50, d95 := pct(asks, .5)-pct(base, .5), pct(asks, .95)-pct(base, .95)
	t.Logf("read turn without the floor: p50 %v p95 %v; with every read asking and galopin answering: p50 %v p95 %v; per-ask cost p50 %v p95 %v",
		pct(base, .5), pct(base, .95), pct(asks, .5), pct(asks, .95), d50, d95)
	if d50 > 300*time.Millisecond {
		t.Errorf("per-ask p50 cost %v exceeds 300ms: report it before deciding anything", d50)
	}
}
