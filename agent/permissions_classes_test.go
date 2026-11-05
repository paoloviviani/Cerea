package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"galopin/internal/backend"
	"galopin/internal/decide"
	"galopin/internal/link"
	"galopin/internal/permrules"
	"galopin/internal/policy"
)

// Classes on the machine (ADR 0107): the label a card carries, the fixed
// refusal of galopin's own files, the loop stop, the reply actor.

func classMachine(t *testing.T, mutate func(*policy.Policy)) (*machine, *ruleBackend, string) {
	t.Helper()
	pol := policy.Default()
	if mutate != nil {
		mutate(&pol)
	}
	mc, rb, dir := newRuleMachine(t, pol)
	mc.installPermissions()
	home := t.TempDir()
	mc.protected = decide.NewProtected(home, filepath.Join(home, "state"))
	return mc, rb, dir
}

func pendingClass(mc *machine, id string) (string, bool) {
	for _, r := range mc.mat.PendingPermissionRequests("s1") {
		if r.ID == id {
			return r.Class, true
		}
	}
	return "", false
}

func TestACardCarriesItsClass(t *testing.T) {
	mc, _, _ := classMachine(t, nil)
	for id, tc := range map[string]struct{ tool, class string }{
		"per_1": {"bash", "command"},
		"per_2": {"external_directory", "outside"},
		"per_3": {"doom_loop", "loop"},
		"per_4": {"srv_tool", "tools"},
		"per_5": {"gp_probe", ""},
	} {
		if tc.tool == "gp_probe" {
			continue
		}
		askFor(mc, id, tc.tool)
		got, held := pendingClass(mc, id)
		if !held {
			t.Fatalf("%s: the ask was not left as a card", tc.tool)
		}
		if got != tc.class {
			t.Errorf("%s card class = %q, want %q", tc.tool, got, tc.class)
		}
	}
	// A galopin tool's own ask is the agents class.
	mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{WorkspaceDir: "/x", SessionID: "s1", Event: backend.Event{
		Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: "gp_1", SessionID: "s1", Tool: "session_send"},
	}})
	if got, _ := pendingClass(mc, "gp_1"); got != "agents" {
		t.Errorf("gp ask class = %q", got)
	}
	// And the wire carries it.
	body, _ := json.Marshal(mc.mat.PendingPermissionRequests("s1")[0])
	if !strings.Contains(string(body), `"class":"`) {
		t.Errorf("the request does not marshal its class: %s", body)
	}
}

func TestGalopinsOwnConfigIsRefusedWhateverTheLimits(t *testing.T) {
	mc, rb, _ := classMachine(t, func(p *policy.Policy) {
		for _, c := range []string{"edit", "command", "outside", "tools"} {
			p.Permission.Limits[c] = "run"
		}
	})
	own := filepath.Join(mc.protected.OwnDirs[0], "policy.json")
	mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{WorkspaceDir: "/x", SessionID: "s1", Event: backend.Event{
		Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: "per_1", SessionID: "s1", Tool: "edit", Patterns: []string{own}},
	}})
	waitReplies(t, rb, 1)
	rb.mu.Lock()
	defer rb.mu.Unlock()
	if rb.replies[0] != backend.DecisionReject || !strings.Contains(rb.messages[0], "galopin's own") {
		t.Errorf("reply = %v %q, want a refusal naming galopin's own files", rb.replies[0], rb.messages[0])
	}
}

func TestTheLoopStopEndsTheTurnAndTellsThePerson(t *testing.T) {
	mc, rb, dir := classMachine(t, func(p *policy.Policy) { p.Permission.Limits["loop"] = "stop" })
	askFor(mc, "per_1", "doom_loop")
	waitReplies(t, rb, 1)
	rb.mu.Lock()
	if rb.replies[0] != backend.DecisionReject {
		t.Errorf("reply = %v, want reject", rb.replies[0])
	}
	cancelled := rb.cancelled
	rb.mu.Unlock()
	if len(cancelled) != 1 || cancelled[0] != "s1" {
		t.Errorf("cancelled = %v, want the turn of s1 ended", cancelled)
	}
	if n := mc.mat.PendingPermissions("s1"); n != 0 {
		t.Errorf("a stop must not leave a card, got %d", n)
	}
	var found bool
	for _, row := range auditRows(t, dir) {
		found = found || row["action"] == "permission.loopStop"
	}
	if !found {
		t.Error("the stop was not audited")
	}
}

func replyArgs(t *testing.T, id, decision string, actor map[string]any) json.RawMessage {
	t.Helper()
	m := map[string]any{"sessionId": "s1", "requestId": id, "decision": decision}
	if actor != nil {
		m["actor"] = actor
	}
	raw, _ := json.Marshal(m)
	return raw
}

func permissionRows(t *testing.T, dir string) []map[string]any {
	var out []map[string]any
	for _, r := range auditRows(t, dir) {
		if r["action"] == "permission" {
			out = append(out, r)
		}
	}
	return out
}

func TestAReplyActorIsAuditedAndAReviewerIsOnceOnly(t *testing.T) {
	mc, rb, dir := classMachine(t, nil)
	askFor(mc, "per_1", "bash")
	askFor(mc, "per_2", "bash")
	askFor(mc, "per_3", "bash")

	// A person (no actor, then an explicit one).
	if _, operr := mc.opPermissionReply(context.Background(), replyArgs(t, "per_1", "once", nil)); operr != nil {
		t.Fatal(operr)
	}
	// The reviewer, with a long reason.
	long := strings.Repeat("é", 1000)
	if _, operr := mc.opPermissionReply(context.Background(), replyArgs(t, "per_2", "once", map[string]any{"kind": "review-model", "modelId": "pystino/decide-1", "reason": long})); operr != nil {
		t.Fatal(operr)
	}
	rows := permissionRows(t, dir)
	if len(rows) != 2 {
		t.Fatalf("rows = %v", rows)
	}
	if rows[0]["by"] != "user" || rows[0]["applied"] != true || rows[0]["model"] != nil {
		t.Errorf("user row = %v", rows[0])
	}
	if rows[1]["by"] != "auto" || rows[1]["model"] != "pystino/decide-1" || rows[1]["decision"] != "once" || rows[1]["applied"] != true {
		t.Errorf("auto row = %v", rows[1])
	}
	if got := []rune(rows[1]["reason"].(string)); len(got) != 300 {
		t.Errorf("reason kept %d runes, want 300", len(got))
	}

	// Once only: never always, never reject; an unknown kind or no model is invalid.
	for name, tc := range map[string]struct {
		decision string
		actor    map[string]any
	}{
		"always":     {"always", map[string]any{"kind": "review-model", "modelId": "m"}},
		"reject":     {"reject", map[string]any{"kind": "review-model", "modelId": "m"}},
		"no model":   {"once", map[string]any{"kind": "review-model"}},
		"other kind": {"once", map[string]any{"kind": "robot", "modelId": "m"}},
	} {
		_, operr := mc.opPermissionReply(context.Background(), replyArgs(t, "per_3", tc.decision, tc.actor))
		if operr == nil || operr.Code != "invalid" {
			t.Errorf("%s: %v, want invalid", name, operr)
		}
	}
	rb.mu.Lock()
	defer rb.mu.Unlock()
	if len(rb.replies) != 2 {
		t.Errorf("replies sent = %v, want only the two good ones", rb.replies)
	}
	for _, d := range rb.replies {
		if d == backend.DecisionAlways {
			t.Error("an always reached the agent")
		}
	}
}

// A reply for an ask that is already resolved is audited as not applied.
func TestAnAutoReplyToAResolvedAskIsAuditedNotApplied(t *testing.T) {
	mc, _, dir := classMachine(t, nil)
	askFor(mc, "per_1", "bash")
	mc.back.(*ruleBackend).gone = true
	res, operr := mc.opPermissionReply(context.Background(), replyArgs(t, "per_1", "once", map[string]any{"kind": "review-model", "modelId": "m", "reason": "r"}))
	if operr != nil {
		t.Fatal(operr)
	}
	if m, _ := res.(map[string]any); m["alreadyResolved"] != true {
		t.Errorf("result = %v", res)
	}
	rows := permissionRows(t, dir)
	if len(rows) != 1 || rows[0]["by"] != "auto" || rows[0]["applied"] != false {
		t.Errorf("rows = %v", rows)
	}
}

// A human's "always" stands where the class is limited to ask (the exception is
// marked OverAsk), and a later matching ask runs under it.
func TestHumanAlwaysOnAnAskLimitedClassIsStoredAndRuns(t *testing.T) {
	mc, rb, _ := classMachine(t, nil)
	rh, _ := mc.ruleHost()
	ask := func(id string) {
		mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{WorkspaceDir: "/x", SessionID: "s1", Event: backend.Event{
			Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: id, SessionID: "s1", Tool: "bash", Patterns: []string{"go test ./..."}, Always: []string{"go test *"}},
		}})
	}
	ask("per_1")
	for _, actor := range []map[string]any{nil, {"kind": "user"}} {
		if actor != nil {
			// a second ask, answered with an explicit user actor
			ask("per_2")
		}
		id := "per_1"
		if actor != nil {
			id = "per_2"
		}
		if _, operr := mc.opPermissionReply(context.Background(), replyArgs(t, id, "always", actor)); operr != nil {
			t.Fatal(operr)
		}
	}
	ex := rb.Exceptions("s1")
	if len(ex) != 1 || !ex[0].OverAsk || ex[0].Patterns[0] != "go test *" {
		t.Fatalf("exceptions = %+v, want one OverAsk go test exception", ex)
	}
	for _, d := range rb.replies {
		if d != backend.DecisionOnce {
			t.Errorf("opencode was told %s, want once", d)
		}
	}
	ask("per_3")
	if _, held := pendingClass(mc, "per_3"); held {
		t.Error("a later matching ask under the exception was carded")
	}
	// Something the exception does not cover still asks.
	mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{WorkspaceDir: "/x", SessionID: "s1", Event: backend.Event{
		Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: "per_4", SessionID: "s1", Tool: "bash", Patterns: []string{"rm -rf /"}},
	}})
	if _, held := pendingClass(mc, "per_4"); !held {
		t.Error("an uncovered command did not ask")
	}
	_ = rh
}

func TestHumanAlwaysOnAnEnvReadIsStored(t *testing.T) {
	mc, rb, _ := classMachine(t, nil)
	mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{WorkspaceDir: "/x", SessionID: "s1", Event: backend.Event{
		Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{ID: "per_1", SessionID: "s1", Tool: "read", Patterns: []string{"/x/.env"}, Always: []string{"*"}},
	}})
	if _, operr := mc.opPermissionReply(context.Background(), replyArgs(t, "per_1", "always", nil)); operr != nil {
		t.Fatal(operr)
	}
	if ex := rb.Exceptions("s1"); len(ex) != 1 || !ex[0].OverAsk {
		t.Errorf("exceptions = %+v", ex)
	}
}

// A reviewer or a rule never gets "always" (refused), the loop class stays
// once-only, and a never limit still refuses.
func TestAlwaysStaysOnceForLoopAndNeverAndIsRefusedForAutoAndRule(t *testing.T) {
	mc, rb, _ := classMachine(t, func(p *policy.Policy) { p.Permission.Limits["web"] = "never" })
	ctx := context.Background()
	askFor(mc, "per_1", "doom_loop")
	askFor(mc, "per_2", "bash")
	if _, operr := mc.opPermissionReply(ctx, replyArgs(t, "per_1", "always", nil)); operr != nil {
		t.Fatal(operr)
	}
	if ex := rb.Exceptions("s1"); len(ex) != 0 {
		t.Errorf("a loop ask stored an exception: %+v", ex)
	}
	for _, actor := range []map[string]any{{"kind": "auto", "modelId": "m"}, {"kind": "review-model", "modelId": "m"}, {"kind": "rule"}} {
		if _, operr := mc.opPermissionReply(ctx, replyArgs(t, "per_2", "always", actor)); operr == nil {
			t.Errorf("actor %v: an always was accepted", actor)
		}
	}
	if ex := rb.Exceptions("s1"); len(ex) != 0 {
		t.Errorf("a non-human always stored an exception: %+v", ex)
	}
	// A never limit still refuses the ask itself, and stores nothing.
	rh, _ := mc.ruleHost()
	req := backend.PermissionRequest{ID: "per_3", SessionID: "s1", Tool: "webfetch", Patterns: []string{"https://x.test"}}
	if mc.humanAlwaysOverAsk(rh, "/x", req) {
		t.Error("a never-limited class accepts a human always")
	}
	if res := mc.decideAsk(rh, "/x", req); res.Verdict != decide.Reject {
		t.Errorf("never limit = %+v", res)
	}
}

func TestAnOverAskExceptionIsHeldBackByPlan(t *testing.T) {
	mc, rb, _ := classMachine(t, nil)
	rh, _ := mc.ruleHost()
	askFor(mc, "per_1", "bash")
	if _, operr := mc.opPermissionReply(context.Background(), replyArgs(t, "per_1", "always", nil)); operr != nil {
		t.Fatal(operr)
	}
	if len(rb.Exceptions("s1")) != 1 {
		t.Fatal("no exception stored")
	}
	req := backend.PermissionRequest{ID: "per_2", SessionID: "s1", Tool: "bash", Patterns: []string{"rm -rf /"}}
	if res := mc.decideAsk(rh, "/x", req); res.Verdict != decide.Once || res.Step != "exception-ask" {
		t.Errorf("ask mode = %+v", res)
	}
	_ = rb.SetPermissionMode(context.Background(), "", "s1", permrules.Deny)
	if res := mc.decideAsk(rh, "/x", req); res.Verdict != decide.Reject || res.Step != "plan" {
		t.Errorf("plan mode = %+v, want the plan refusal", res)
	}
}

func TestTheHelloCarriesTheLimitsAndAnOldHelloHasNone(t *testing.T) {
	pol := policy.Default()
	pol.Permission.Limits["tools"] = "never"
	pol.Permission.Limits["loop"] = "stop"
	body, _ := json.Marshal(buildHello(newE2EFakeBackend(), pol))
	var got struct {
		Policy struct {
			Limits map[string]string `json:"limits"`
		} `json:"policy"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Policy.Limits["tools"] != "deny" || got.Policy.Limits["loop"] != "stop" || got.Policy.Limits["command"] != "ask" || len(got.Policy.Limits) != 8 {
		t.Errorf("hello limits = %v", got.Policy.Limits)
	}
	// An older machine's hello has no limits: it decodes with none.
	var old link.PolicyInfo
	if err := json.Unmarshal([]byte(`{"autoAccept":"denied","permission":{"max":{"bash":"ask"}},"workspaceRoots":[],"allowFreeModels":false}`), &old); err != nil || old.Limits != nil {
		t.Errorf("old policy = %+v %v", old, err)
	}
}

func TestDecidePolicyReadsTheLiveLimits(t *testing.T) {
	mc, _, _ := classMachine(t, nil)
	rh, _ := mc.ruleHost()
	if got := mc.decidePolicy(rh).Limit(decide.ClassCommand); got != decide.AskLimit {
		t.Fatalf("command = %v", got)
	}
	next := policy.Default().Permission
	next.Limits["command"] = "never"
	mc.live.Tighten(next)
	if got := mc.decidePolicy(rh).Limit(decide.ClassCommand); got != decide.Never {
		t.Errorf("a tightened limit is not read live: %v", got)
	}
}

// The machine marks a plain read itself, and the "rule" actor is for that mark
// alone: an agent's own readOnly field is overwritten, and a rule reply to any
// other ask is refused.
func TestRuleActorNeedsTheMachinesReadOnlyMark(t *testing.T) {
	mc, rb, dir := classMachine(t, nil)
	ws := t.TempDir()
	ask := func(id, cmd string) {
		mc.mat.ApplyBackendEvent(context.Background(), backend.BackendEvent{
			WorkspaceDir: ws, SessionID: "s1",
			Event: backend.Event{Kind: backend.EventPermissionAsked, Request: &backend.PermissionRequest{
				ID: id, SessionID: "s1", Tool: "bash", Patterns: []string{cmd}, ReadOnly: true}},
		})
	}
	ask("per_1", "ls -la")
	ask("per_2", "rm -rf /")
	rule := map[string]any{"kind": "rule", "reason": "read-only"}
	if _, operr := mc.opPermissionReply(context.Background(), replyArgs(t, "per_2", "once", rule)); operr == nil || operr.Code != "invalid" {
		t.Errorf("rule reply to a non-read-only ask: %v, want invalid", operr)
	}
	if _, operr := mc.opPermissionReply(context.Background(), replyArgs(t, "per_1", "always", rule)); operr == nil {
		t.Error("a rule reply must be once")
	}
	if _, operr := mc.opPermissionReply(context.Background(), replyArgs(t, "per_1", "once", rule)); operr != nil {
		t.Fatal(operr)
	}
	rows := permissionRows(t, dir)
	if len(rows) != 1 || rows[0]["by"] != "rule" {
		t.Errorf("rows = %v", rows)
	}
	rb.mu.Lock()
	defer rb.mu.Unlock()
	if len(rb.replies) != 1 {
		t.Errorf("replies = %v", rb.replies)
	}
}
