package opencode

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"galopin/internal/permrules"
)

func TestFloorContentShape(t *testing.T) {
	body, err := floorConfig(nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	// "*" leads the top-level object, so the explicit keys after it are what
	// a lower source's later allow cannot beat.
	if !strings.Contains(body, `"permission":{"*":"ask","bash":"ask"`) {
		t.Errorf("top-level permission does not lead with *: %s", body)
	}
	for _, bad := range []string{`"task":"ask"`, `"todowrite"`} {
		top := body[:strings.Index(body, `"agent"`)+1]
		if strings.Contains(top, bad) {
			t.Errorf("the top-level floor names %s, which would give a subagent a literal rule (task.ts)", bad)
		}
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	agents := got["agent"].(map[string]any)
	for _, n := range []string{"plan", "explore", "compaction", "title", "summary"} {
		if agents[n] == nil {
			t.Errorf("no restated denies for %s", n)
		}
	}
	// plan's edit object keeps its order: the deny first, the plan file after.
	if !strings.Contains(body, `"edit":{"*":"deny",".opencode/plans/*.md":"ask"}`) {
		t.Errorf("plan's edit rule lost its order: %s", body)
	}
	if !strings.Contains(body, `"explore":{"permission":{"*":"deny","bash":"ask"`) {
		t.Errorf("explore's blanket deny must lead: %s", body)
	}
}

func rules(rs ...string) []permrules.Rule {
	var out []permrules.Rule
	for i := 0; i+2 < len(rs)+0; i += 3 {
		out = append(out, permrules.Rule{Permission: rs[i], Pattern: rs[i+1], Action: permrules.Action(rs[i+2])})
	}
	return out
}

func TestBreachesAndCustomAgentPatch(t *testing.T) {
	zed := agentInfo{Name: "zed", Permission: rules(
		"*", "*", "ask", "bash", "*", "allow", "edit", "*", "deny", "webfetch", "https://ok/*", "allow")}
	safe := agentInfo{Name: "safe", Permission: rules("*", "*", "ask", "external_directory", "/tmp/*", "allow")}
	build := agentInfo{Name: "build", Native: true, Permission: rules("*", "*", "ask")}
	br := findBreaches([]agentInfo{zed, safe, build})
	got := map[string]bool{}
	for _, b := range br {
		got[b.Agent+":"+b.Key] = true
	}
	if !got["zed:bash"] || !got["zed:webfetch https://ok/*"] {
		t.Errorf("breaches = %v, want zed's bash and webfetch allows", br)
	}
	if got["safe:external_directory /tmp/*"] || got["build:bash"] {
		t.Errorf("breaches = %v: opencode's own safe dirs and a clean agent are not breaches", br)
	}
	patch := customAgentPatch([]agentInfo{zed, safe, build})
	if len(patch) != 1 || patch["zed"] == nil {
		t.Fatalf("patch = %v, want zed only", patch)
	}
	b, _ := json.Marshal(patch)
	s := string(b)
	if !strings.Contains(s, `"bash":"ask"`) || !strings.Contains(s, `"edit":"deny"`) {
		t.Errorf("patch %s must ask for bash and keep the edit deny", s)
	}
	if strings.Contains(s, `:"allow"`) {
		t.Errorf("patch %s restates an allow", s)
	}
	if !strings.Contains(s, `"webfetch":{"*":"ask","https://ok/*":"ask"}`) {
		t.Errorf("patch %s: a pattern allow must become an ask under a catch-all ask", s)
	}
}

func TestFileDenyStandsUnderTheFloor(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/opencode.json"
	if err := os.WriteFile(path, []byte(`{"permission":{"edit":"deny","bash":"ask","read":"allow"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	d := fileDenies(path)
	if !d["edit"] || d["bash"] || d["read"] {
		t.Fatalf("fileDenies = %v, want only edit", d)
	}
	body, _ := floorConfig(nil, nil, d)
	if !strings.Contains(body, `"edit":"deny"`) || strings.Contains(body[:strings.Index(body, `"agent"`)], `"edit":"ask"`) {
		t.Errorf("the owner's file deny did not survive the floor: %s", body)
	}
}
