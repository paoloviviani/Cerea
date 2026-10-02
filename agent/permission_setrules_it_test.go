package main

import (
	"context"
	"encoding/json"
	"testing"

	"galopin/internal/backend"
	"galopin/internal/policy"
)

type rulesView struct {
	Agent string `json:"agent"`
	Rules []struct {
		Permission string `json:"permission"`
		Pattern    string `json:"pattern"`
		Action     string `json:"action"`
		Source     string `json:"source"`
	} `json:"rules"`
	SavedApprovals []backend.SavedApproval `json:"savedApprovals"`
	Ceiling        map[string]string       `json:"ceiling"`
}

func (r *permRig) setRules(s backend.Session, rules []map[string]string) {
	r.t.Helper()
	raw, _ := json.Marshal(map[string]any{"sessionId": s.ID, "rules": rules})
	if res, operr := r.mc.Handle(context.Background(), "session.setRules", raw); operr != nil {
		r.t.Fatalf("session.setRules: %+v", operr)
	} else if m, ok := res.(map[string]any); !ok || len(m) != 0 {
		r.t.Fatalf("session.setRules answered %v, want {}", res)
	}
}

// reread is what the panel does after a write: ask the machine what is true.
func (r *permRig) reread(s backend.Session) rulesView {
	r.t.Helper()
	raw, _ := json.Marshal(map[string]any{"sessionId": s.ID})
	res, operr := r.mc.Handle(context.Background(), "permission.rules", raw)
	if operr != nil {
		r.t.Fatalf("permission.rules: %+v", operr)
	}
	body, _ := json.Marshal(res)
	var v rulesView
	if err := json.Unmarshal(body, &v); err != nil {
		r.t.Fatal(err)
	}
	return v
}

// setRules past the ceiling is applied AT the ceiling: the write runs nothing
// it should not, and the re-read shows the ceiling's value, not the request.
func TestSetRulesLiveIsClampedAndReReadShowsTheCeiling(t *testing.T) {
	r := newPermRig(t, permRigOpts{
		file: map[string]any{"edit": "ask"},
		perm: policy.Permission{Max: map[string]string{"edit": "ask"}},
	})
	s := r.session("setrules-clamp", "")
	r.setRules(s, []map[string]string{{"permission": "edit", "pattern": "*", "action": "allow"}})

	ask, _, mark := r.try(s, "clamp.txt")
	if ask == nil {
		t.Fatal("the write ran: a panel write of allow got past a ceiling of ask")
	}
	r.reply(s, ask.ID, "reject")
	r.idle(s, mark)

	v := r.reread(s)
	var cereaEdit, last = "", ""
	for i, rule := range v.Rules {
		if rule.Permission == "edit" && rule.Source == "cerea" {
			cereaEdit = rule.Action
		}
		if i == len(v.Rules)-1 {
			last = rule.Source
		}
	}
	if cereaEdit != "ask" {
		t.Errorf("the re-read shows the written edit rule as %q, want the ceiling's ask: %+v", cereaEdit, v.Rules)
	}
	if last != "ceiling" {
		t.Errorf("last rule's source = %q, want the ceiling", last)
	}
	// The order after a write is still: opencode's own rules (default, file and
	// floor interleave as opencode merged them — some built-in defaults come
	// after config), then the cerea rules, then the ceiling, last.
	phase := 0
	for _, rule := range v.Rules {
		p := map[string]int{"default": 0, "file": 0, "floor": 0, "machine": 1, "cerea": 1, "ceiling": 2}[rule.Source]
		if p < phase {
			t.Errorf("rule %+v is out of order (opencode's, then cerea, then the ceiling)", rule)
		}
		phase = p
	}
	if phase != 2 {
		t.Errorf("the re-read does not end in the ceiling: %+v", v.Rules)
	}
	if v.Ceiling["edit"] != "ask" {
		t.Errorf("ceiling in the re-read = %v", v.Ceiling)
	}
}

// A write under the ceiling lands as written; a later write that drops a rule
// takes it OUT (opencode itself can only append): the session goes back to
// what the file said.
func TestSetRulesLiveReplaceRestoresTheBase(t *testing.T) {
	r := newPermRig(t, permRigOpts{file: map[string]any{"edit": "ask"}})
	s := r.session("setrules-replace", "")

	r.setRules(s, []map[string]string{{"permission": "edit", "pattern": "*", "action": "allow"}})
	if ask, part, _ := r.try(s, "rep1.txt"); ask != nil || part.ToolStatus != backend.ToolCompleted {
		t.Fatalf("with the person's allow: ask=%v part=%+v", ask, part)
	}
	r.setRules(s, []map[string]string{{"permission": "edit", "pattern": "*", "action": "deny"}})
	if ask, part, _ := r.try(s, "rep2.txt"); ask != nil || !refused(part) || r.exists("rep2.txt") {
		t.Fatalf("with the person's deny: ask=%v part=%+v exists=%v", ask, part, r.exists("rep2.txt"))
	}
	r.setRules(s, nil)
	ask, _, mark := r.try(s, "rep3.txt")
	if ask == nil {
		t.Fatal("after the rules were cleared the write did not go back to asking (the file says ask)")
	}
	r.reply(s, ask.ID, "reject")
	r.idle(s, mark)
}

// The person's rules survive a mode change, in the right place.
func TestSetRulesLiveSurvivesAModeChange(t *testing.T) {
	r := newPermRig(t, permRigOpts{perm: policy.Permission{Max: map[string]string{"bash": "ask"}}})
	s := r.session("setrules-mode", "")
	r.setRules(s, []map[string]string{{"permission": "edit", "pattern": "*", "action": "allow"}})
	if ask, part, _ := r.try(s, "mode1.txt"); ask != nil || part.ToolStatus != backend.ToolCompleted {
		t.Fatalf("build with the person's allow: ask=%v part=%+v", ask, part)
	}
	// In plan, edit is denied by the agent; the person's allow still sits above
	// it (a session rule beats the agent's), and the ceiling is still last.
	if _, err := r.oc.SetMode(r.ctx, r.work, s.ID, "plan"); err != nil {
		t.Fatal(err)
	}
	if ask, part, _ := r.try(s, "mode2.txt"); ask != nil || part.ToolStatus != backend.ToolCompleted {
		t.Fatalf("plan with the person's allow: ask=%v part=%+v", ask, part)
	}
	v := r.reread(s)
	if v.Agent != "plan" || v.Rules[len(v.Rules)-1].Source != "ceiling" {
		t.Errorf("re-read after the mode change: agent=%q last=%+v", v.Agent, v.Rules[len(v.Rules)-1])
	}
}
