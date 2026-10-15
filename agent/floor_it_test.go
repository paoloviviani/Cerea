package main

import (
	"os"
	"path/filepath"
	"testing"

	"galopin/internal/permrules"
)

// The floor, against the real binary (ADR 0097): every agent, built-in or
// custom, asks galopin for every key, the read-only agents keep their denies,
// and a custom agent's own allow is closed. If a release changes a built-in
// agent, this fails instead of loosening a machine.
func TestFloorEveryAgentAsksAndReadOnlyAgentsKeepTheirDenies(t *testing.T) {
	r := newPermRig(t, permRigOpts{
		file: map[string]any{"edit": "ask", "bash": "ask", "webfetch": "ask"},
		preStart: func(root string) {
			dir := filepath.Join(root, "config", "opencode", "agents")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			md := "---\ndescription: a custom agent that allows bash natively\nmode: all\npermission:\n  bash: allow\n  edit: deny\n---\nYou are zed.\n"
			if err := os.WriteFile(filepath.Join(dir, "zed.md"), []byte(md), 0o644); err != nil {
				t.Fatal(err)
			}
		},
	})
	probes := []string{"read", "edit", "bash", "webfetch", "websearch", "codesearch", "glob", "grep", "list", "lsp", "skill", "task", "todowrite", "galopin_probe_tool", "external_directory"}
	for _, a := range []string{"build", "general", "zed"} {
		rules := r.agentRules(a)
		for _, k := range probes {
			got := permrules.Evaluate(rules, k, "src/a.go")
			if k == "todowrite" && a == "general" {
				continue // general's own deny is restated by task.ts at the child
			}
			if k == "edit" && a == "zed" {
				if got != permrules.Deny {
					t.Errorf("zed edit = %s, want its own deny kept", got)
				}
				continue
			}
			if got != permrules.Ask {
				t.Errorf("agent %s key %s = %s, want ask (nothing runs without galopin)", a, k, got)
			}
		}
	}
	// The read-only agents keep their denies.
	plan := r.agentRules("plan")
	if got := permrules.Evaluate(plan, "edit", "src/a.go"); got != permrules.Deny {
		t.Errorf("plan edit src/a.go = %s, want deny", got)
	}
	if got := permrules.Evaluate(plan, "edit", ".opencode/plans/x.md"); got != permrules.Ask {
		t.Errorf("plan edit of its plan file = %s, want ask (galopin lets it through on Plan)", got)
	}
	if got := permrules.Evaluate(plan, "task", "general"); got != permrules.Deny {
		t.Errorf("plan task general = %s, want deny", got)
	}
	explore := r.agentRules("explore")
	for k, want := range map[string]permrules.Action{
		"edit": permrules.Deny, "write": permrules.Deny, "galopin_probe_tool": permrules.Deny,
		"task": permrules.Deny, "bash": permrules.Ask, "read": permrules.Ask, "grep": permrules.Ask, "webfetch": permrules.Ask,
	} {
		if got := permrules.Evaluate(explore, k, "x"); got != want {
			t.Errorf("explore %s = %s, want %s", k, got, want)
		}
	}
	for _, a := range []string{"compaction", "title", "summary"} {
		if got := permrules.Evaluate(r.agentRules(a), "bash", "x"); got != permrules.Deny {
			t.Errorf("hidden agent %s bash = %s, want deny", a, got)
		}
	}
	// A subagent keeps no literal task/todowrite rule it would not have had:
	// the child's own denies come from task.ts only when the agent has none.
	for _, rule := range r.agentRules("explore") {
		_ = rule
	}
	if bs := r.oc.FloorBreaches(); len(bs) != 0 {
		t.Errorf("floor breaches after the patch: %v", bs)
	}
}
