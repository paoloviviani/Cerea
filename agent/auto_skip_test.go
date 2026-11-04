package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/decide"
	"galopin/internal/link"
	"galopin/internal/policy"
)

// ADR 0105: the fourth permission word, the reply actor and the skip posture,
// at the machine's own level (the decision function has its own tests).

func autoPolicy(max map[string]string) policy.Policy {
	p := policyWithCeiling(max)
	p.AutoPermission = true
	return p
}

func setMode(t *testing.T, mc *machine, mode string) *link.OpError {
	t.Helper()
	_, operr := mc.Handle(context.Background(), "session.setPermissionMode", json.RawMessage(`{"sessionId":"s1","mode":"`+mode+`"}`))
	return operr
}

func askWith(mc *machine, id, tool string, patterns ...string) {
	mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{
		WorkspaceDir: "/x", SessionID: "s1",
		Event: backend.Event{Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: id, SessionID: "s1", Tool: tool, Patterns: patterns}},
	})
}

func pendingByID(mc *machine) map[string]backend.PermissionRequest {
	out := map[string]backend.PermissionRequest{}
	for _, r := range mc.mat.PendingPermissionRequests("s1") {
		out[r.ID] = r
	}
	return out
}

func TestAutoNeedsThePolicyAndReadsBackAsAuto(t *testing.T) {
	mc, rb, _ := newRuleMachine(t, policy.Default())
	if operr := setMode(t, mc, "auto"); operr == nil || operr.Code != "forbidden" {
		t.Fatalf("auto with the policy off: %v, want forbidden", operr)
	}
	if rb.Auto("s1") {
		t.Fatal("a refused auto was applied")
	}

	mc, rb, dir := newRuleMachine(t, autoPolicy(nil))
	if operr := setMode(t, mc, "auto"); operr != nil {
		t.Fatal(operr)
	}
	if got := mc.permissionMode("s1"); got != "auto" {
		t.Errorf("Session.permissionMode = %q, want auto", got)
	}
	if rb.PermissionMode("s1") != "ask" {
		t.Errorf("an auto session is ask locally, got %q", rb.PermissionMode("s1"))
	}
	for _, mode := range []string{"allow", "ask"} {
		if operr := setMode(t, mc, mode); operr != nil {
			t.Fatal(operr)
		}
		if mc.permissionMode("s1") != mode || rb.Auto("s1") {
			t.Errorf("after %s the word is %q auto=%v: any other word must clear auto", mode, mc.permissionMode("s1"), rb.Auto("s1"))
		}
	}
	var modes []string
	for _, r := range auditRows(t, dir) {
		if r["action"] == "permission.mode" {
			modes = append(modes, r["mode"].(string))
		}
	}
	if strings.Join(modes, " ") != "auto allow ask" {
		t.Errorf("audit modes = %v", modes)
	}
}

// Auto is decided exactly as Ask is, and every card the ceiling forced says so.
func TestAutoDecidesAsAskAndMarksCeilingForcedCards(t *testing.T) {
	mc, rb, _ := newRuleMachine(t, autoPolicy(map[string]string{"bash": "ask"}))
	if operr := setMode(t, mc, "auto"); operr != nil {
		t.Fatal(operr)
	}
	askWith(mc, "per_bash", "bash", "npm test")
	askWith(mc, "per_edit", "edit", "a.go")
	askWith(mc, "per_read", "read", "a.go")
	waitReplies(t, rb, 1) // the read is answered here, once, as on Ask
	rb.mu.Lock()
	if len(rb.replies) != 1 || rb.replies[0] != backend.DecisionOnce {
		t.Errorf("replies = %v, want the one local read answered once", rb.replies)
	}
	rb.mu.Unlock()
	cards := pendingByID(mc)
	if len(cards) != 2 {
		t.Fatalf("cards = %v, want bash and edit (what Ask shows)", cards)
	}
	if !cards["per_bash"].CeilingForced {
		t.Error("the bash card is capped at ask by the ceiling: it must be marked ceilingForced")
	}
	if cards["per_edit"].CeilingForced {
		t.Error("the edit card is not capped: it must not be marked")
	}
	body, _ := json.Marshal(cards["per_edit"])
	if strings.Contains(string(body), "ceilingForced") {
		t.Errorf("an unmarked card must not carry the field at all: %s", body)
	}
}

// The reply actor, in the local audit; a review model's answers are held to
// three lines by galopin itself.
func TestReplyActorIsAuditedAndAReviewModelIsHeldToItsLines(t *testing.T) {
	mc, rb, dir := newRuleMachine(t, autoPolicy(map[string]string{"bash": "ask"}))
	ctx := context.Background()
	reply := func(body map[string]any) (any, *link.OpError) {
		body["sessionId"] = "s1"
		raw, _ := json.Marshal(body)
		return mc.opPermissionReply(ctx, raw)
	}
	askWith(mc, "per_bash", "bash", "npm test")
	askWith(mc, "per_edit", "edit", "a.go")
	review := map[string]any{"kind": "review-model", "modelId": "pystino/rev-1", "reason": "p=0.97 routine"}

	// Not on Auto yet: refused.
	if _, operr := reply(map[string]any{"requestId": "per_edit", "decision": "once", "actor": review}); operr == nil || operr.Code != "forbidden" {
		t.Fatalf("review answer on an Ask session: %v, want forbidden", operr)
	}
	if err := setMode(t, mc, "auto"); err != nil {
		t.Fatal(err)
	}
	// What the ceiling forces never goes to a model.
	if _, operr := reply(map[string]any{"requestId": "per_bash", "decision": "once", "actor": review}); operr == nil || operr.Code != "forbidden" {
		t.Errorf("review answer to a ceiling-forced ask: %v, want forbidden", operr)
	}
	// A model never rejects or always-allows.
	for _, d := range []string{"always", "reject"} {
		if _, operr := reply(map[string]any{"requestId": "per_edit", "decision": d, "actor": review}); operr == nil || operr.Code != "invalid" {
			t.Errorf("review decision %s: %v, want invalid", d, operr)
		}
	}
	if _, operr := reply(map[string]any{"requestId": "per_edit", "decision": "once", "actor": map[string]any{"kind": "review-model"}}); operr == nil || operr.Code != "invalid" {
		t.Errorf("a review actor with no modelId: %v, want invalid", operr)
	}
	if _, operr := reply(map[string]any{"requestId": "per_edit", "decision": "once", "actor": map[string]any{"kind": "robot"}}); operr == nil || operr.Code != "invalid" {
		t.Errorf("an unknown actor: %v, want invalid", operr)
	}
	if len(rb.replies) != 0 {
		t.Fatalf("a refused reply reached the agent: %v", rb.replies)
	}
	// The allowed one lands, audited by:auto with the model and reason.
	if _, operr := reply(map[string]any{"requestId": "per_edit", "decision": "once", "actor": review}); operr != nil {
		t.Fatal(operr)
	}
	// A person's answer (no actor) is by:user; an answer to an ask that is
	// already gone is recorded as not applied.
	if _, operr := reply(map[string]any{"requestId": "per_bash", "decision": "once"}); operr != nil {
		t.Fatal(operr)
	}
	rb.replyErr = backend.ErrPermissionGone
	res, operr := reply(map[string]any{"requestId": "per_gone", "decision": "once", "actor": review})
	if operr != nil {
		t.Fatal(operr)
	}
	if m, _ := res.(map[string]any); m["alreadyResolved"] != true {
		t.Fatalf("answer = %v", res)
	}
	var rows []map[string]any
	for _, r := range auditRows(t, dir) {
		if r["action"] == "permission" {
			rows = append(rows, r)
		}
	}
	if len(rows) != 3 {
		t.Fatalf("audit rows = %v, want the three answers that were decided", rows)
	}
	if rows[0]["by"] != "auto" || rows[0]["model"] != "pystino/rev-1" || rows[0]["reason"] != "p=0.97 routine" || rows[0]["applied"] != true || rows[0]["requestId"] != "per_edit" {
		t.Errorf("review row = %v", rows[0])
	}
	if rows[1]["by"] != "user" || rows[1]["applied"] != true || rows[1]["model"] != nil {
		t.Errorf("user row = %v", rows[1])
	}
	if rows[2]["by"] != "auto" || rows[2]["applied"] != false {
		t.Errorf("an answer to a resolved ask must be recorded as not applied: %v", rows[2])
	}
}

func TestReviewReasonIsCappedInTheAudit(t *testing.T) {
	a, operr := parseActor(&replyActor{Kind: actorReviewModel, ModelID: "m", Reason: strings.Repeat("é", 1000)})
	if operr != nil || len([]rune(a.Reason)) != maxActorReason {
		t.Errorf("reason = %d runes, err %v", len([]rune(a.Reason)), operr)
	}
}

func skipMachine(t *testing.T, max map[string]string) (*machine, *ruleBackend, string) {
	t.Helper()
	mc, rb, dir := newRuleMachine(t, policyWithCeiling(max))
	home := t.TempDir()
	mc.protected = decide.NewProtected(home, dir)
	mc.skip.Store(true)
	return mc, rb, dir
}

func waitAudit(t *testing.T, dir string, n int) []map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var rows []map[string]any
		for _, r := range auditRows(t, dir) {
			if r["by"] == "skip" {
				rows = append(rows, r)
			}
		}
		if len(rows) >= n {
			return rows
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d skip audit rows, have %v", n, rows)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestSkipAllowsEveryCardExceptTheCeilingTheRejectListAndTheLoopBrake(t *testing.T) {
	mc, rb, dir := skipMachine(t, map[string]string{"bash": "ask"})
	policyJSON := filepath.Join(dir, policyFileName)
	askWith(mc, "per_edit", "edit", "a.go")                       // a card on Ask: allowed
	askWith(mc, "per_web", "webfetch", "https://example.org")     // allowed
	askWith(mc, "per_bash", "bash", "npm test")                   // the ceiling: refused
	askWith(mc, "per_loop", "doom_loop", "*")                     // the brake: refused
	askWith(mc, "per_policy", "edit", policyJSON)                 // galopin's own policy: refused
	askWith(mc, "per_ci", "edit", ".github/workflows/ci.yml")     // a write to CI config: refused
	askWith(mc, "per_ciread", "read", ".github/workflows/ci.yml") // a read of it: a plain local answer
	rows := waitAudit(t, dir, 6)
	if got := mc.mat.PendingPermissions("s1"); got != 0 {
		t.Fatalf("pending = %d: under skip nothing becomes a card", got)
	}
	want := map[string][2]string{
		"per_edit":   {"once", decide.SkipAllow},
		"per_web":    {"once", decide.SkipAllow},
		"per_bash":   {"reject", decide.SkipCeiling},
		"per_loop":   {"reject", decide.SkipLoop},
		"per_policy": {"reject", decide.SkipProtected},
		"per_ci":     {"reject", decide.SkipProtected},
	}
	for _, r := range rows {
		id := r["requestId"].(string)
		w, ok := want[id]
		if !ok {
			t.Errorf("unexpected skip row %v", r)
			continue
		}
		if r["decision"] != w[0] || r["step"] != w[1] || r["applied"] != true || r["by"] != "skip" {
			t.Errorf("%s: row %v, want %v", id, r, w)
		}
		delete(want, id)
	}
	if len(want) != 0 {
		t.Errorf("no audit row for %v", want)
	}
	raw, _ := json.Marshal(rows)
	if strings.Contains(string(raw), "npm test") || strings.Contains(string(raw), "policy.json") {
		t.Errorf("a pattern reached the audit: %s", raw)
	}
	waitReplies(t, rb, 7)
}

func TestSkipKeepsPlanAndIsNeverPersisted(t *testing.T) {
	mc, rb, dir := skipMachine(t, nil)
	if operr := setMode(t, mc, "deny"); operr != nil {
		t.Fatal(operr)
	}
	askWith(mc, "per_edit", "edit", "a.go")
	waitReplies(t, rb, 1)
	rb.mu.Lock()
	d := rb.replies[0]
	rb.mu.Unlock()
	if d != backend.DecisionReject {
		t.Errorf("a Plan session under skip answered %s, want reject: skip never overrides Plan", d)
	}
	for _, r := range auditRows(t, dir) {
		if r["by"] == "skip" && r["requestId"] == "per_edit" {
			t.Errorf("Plan's refusal is not a skip decision: %v", r)
		}
	}
	if mc.posture() != "skip" {
		t.Errorf("posture = %s", mc.posture())
	}
	// Nothing about skip is in the policy file or in any new machine.
	raw, _ := json.Marshal(policy.Default())
	if strings.Contains(strings.ToLower(string(raw)), "skip") && strings.Contains(string(raw), "true") {
		t.Errorf("policy carries skip state: %s", raw)
	}
	fresh, _, _ := newRuleMachine(t, policy.Default())
	if fresh.posture() != "normal" {
		t.Errorf("a new machine's posture = %s, want normal: skip lives in the process that was given the flag", fresh.posture())
	}
}

func TestSkipIsRefusedAtStartUnlessPolicyAllowsIt(t *testing.T) {
	if err := checkSkipAllowed(true, policy.Default()); err == nil || !strings.Contains(err.Error(), "--allow-skip-permissions") {
		t.Errorf("default policy: %v, want a refusal naming the enroll flag", err)
	}
	if err := checkSkipAllowed(false, policy.Default()); err != nil {
		t.Errorf("no flag: %v", err)
	}
	p := policy.Default()
	p.AllowSkip = true
	if err := checkSkipAllowed(true, p); err != nil {
		t.Errorf("allowed policy: %v", err)
	}
	if err := runRun([]string{"--dangerously-skip-permissions", "--connectors-only"}); err == nil || !strings.Contains(err.Error(), "connectors-only") {
		t.Errorf("skip on a connectors-only run: %v", err)
	}
}

func TestHelloAdvertisesAutoAndThePosture(t *testing.T) {
	pol := policy.Default()
	pol.AutoPermission = true
	pol.MaxPerHour = 12
	h := buildHello(newE2EFakeBackend(), pol)
	if !h.Machine.Capabilities["autoPermission"] {
		t.Error("this build understands auto: capability must be true")
	}
	body, _ := json.Marshal(h)
	var got struct {
		Policy struct {
			AutoPermission bool `json:"autoPermission"`
			MaxPerHour     int  `json:"maxPerHour"`
		} `json:"policy"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if !got.Policy.AutoPermission || got.Policy.MaxPerHour != 12 {
		t.Errorf("policy = %+v", got.Policy)
	}
	off := buildHello(newE2EFakeBackend(), policy.Default())
	body, _ = json.Marshal(off)
	if strings.Contains(string(body), `"autoPermission":true`) && !strings.Contains(string(body), `"capabilities"`) {
		t.Errorf("hello = %s", body)
	}
	if off.Policy.AutoPermission || off.Policy.MaxPerHour != policy.DefaultMaxPerHour {
		t.Errorf("default policy: auto=%v maxPerHour=%d, want off and %d", off.Policy.AutoPermission, off.Policy.MaxPerHour, policy.DefaultMaxPerHour)
	}
	if c := buildConnectorsHello(pol); c.Machine.Capabilities["autoPermission"] || c.Policy.AutoPermission || c.Posture != "normal" {
		t.Errorf("a connectors-only machine has no agent to put on Auto: %+v", c)
	}
}

func TestPolicyKeysForAutoAndSkip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	p := policy.Default()
	if p.AutoPermission || p.AllowSkip || p.EffectiveMaxPerHour() != 60 {
		t.Fatalf("defaults: auto=%v skip=%v maxPerHour=%d, want off, off, 60", p.AutoPermission, p.AllowSkip, p.EffectiveMaxPerHour())
	}
	// enroll's flags open them.
	opts := enrollOptions{allowAutoPermission: true, allowSkipPermissions: true, maxPerHour: 20, maxTerminals: policy.DefaultMaxTerminals}
	opened, err := enrollPolicy(&opts)
	if err != nil {
		t.Fatal(err)
	}
	if !opened.AutoPermission || !opened.AllowSkip || opened.MaxPerHour != 20 {
		t.Errorf("enroll flags: %+v", opened)
	}
	if err := policy.Save(path, opened); err != nil {
		t.Fatal(err)
	}
	// policy set only tightens.
	if err := runPolicySet([]string{"--state-dir", dir, "--max-per-hour", "50"}); err == nil || !strings.Contains(err.Error(), "enroll") {
		t.Errorf("raising maxPerHour: %v, want a refusal pointing at enroll", err)
	}
	if err := runPolicySet([]string{"--state-dir", dir, "--max-per-hour", "5", "--no-auto-permission", "--no-allow-skip"}); err != nil {
		t.Fatal(err)
	}
	got, err := policy.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.AutoPermission || got.AllowSkip || got.MaxPerHour != 5 {
		t.Errorf("after tightening: %+v", got)
	}
	// show says all three.
	sum := autoPermissionPolicySummary(got) + skipPolicySummary(got)
	for _, want := range []string{"Auto permission: DENIED", "maxPerHour): 5", "Skip permissions: DENIED"} {
		if !strings.Contains(sum, want) {
			t.Errorf("summary lacks %q: %s", want, sum)
		}
	}
}
