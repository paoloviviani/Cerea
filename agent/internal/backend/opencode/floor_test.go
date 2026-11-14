package opencode

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"galopin/internal/permrules"
)

// floorBackend is a Backend with the machine's plan directory known and
// background subagents allowed, as a normal enrolled machine has them.
func floorBackend(bg bool) *Backend {
	return &Backend{cfg: Config{Env: []string{"HOME=/home/u"}, BackgroundSubagents: bg}}
}

// topLevel is the floor's top-level permissions array.
func topLevel(t *testing.T, body string) []map[string]string {
	t.Helper()
	var got struct {
		Permissions []map[string]string `json:"permissions"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	return got.Permissions
}

func hasRule(rs []map[string]string, action, resource, effect string) bool {
	for _, r := range rs {
		if r["action"] == action && r["resource"] == resource && r["effect"] == effect {
			return true
		}
	}
	return false
}

func TestFloorContentShape(t *testing.T) {
	body, err := floorBackend(true).floorConfig(nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Permissions []map[string]string `json:"permissions"`
		Agents      map[string]struct {
			Permissions []map[string]string `json:"permissions"`
		} `json:"agents"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	// "*" leads the top-level array, so the explicit keys after it are what a
	// lower source's later allow cannot beat.
	if len(got.Permissions) < 2 || got.Permissions[0]["action"] != "*" || got.Permissions[0]["effect"] != "ask" {
		t.Fatalf("top-level permissions do not lead with * ask: %s", body)
	}
	for _, r := range got.Permissions {
		if r["action"] == "subagent" || r["action"] == "todowrite" {
			t.Errorf("the top-level floor names %s, which would give a subagent a literal rule", r["action"])
		}
		if r["effect"] == "allow" {
			t.Errorf("the floor allows %v", r)
		}
	}
	// Code Mode is denied so every tool call is its own ask.
	hasExecute := false
	for _, r := range got.Permissions {
		hasExecute = hasExecute || (r["action"] == "execute" && r["effect"] == "deny")
	}
	if !hasExecute {
		t.Errorf("Code Mode (execute) must be denied: %s", body)
	}
	for _, n := range []string{"plan", "explore", "general", "compaction", "title", "summary"} {
		if got.Agents[n].Permissions == nil {
			t.Errorf("no restated denies for %s", n)
		}
	}
	// Every agent block is the whole top-level floor, the agent's own rules, then the machine's
	// denies again (here: Code Mode); own() is the middle.
	own := func(name string) []map[string]string {
		p := got.Agents[name].Permissions
		if len(p) < len(got.Permissions)+1 {
			t.Fatalf("%s block is shorter than the floor: %v", name, p)
		}
		for i, r := range got.Permissions {
			if p[i]["action"] != r["action"] || p[i]["effect"] != r["effect"] {
				t.Errorf("%s block does not start with the top-level floor at %d: %v", name, i, p[i])
			}
		}
		if last := p[len(p)-1]; last["action"] != "execute" || last["effect"] != "deny" {
			t.Errorf("%s block does not end with the machine denies: %v", name, last)
		}
		return p[len(got.Permissions) : len(p)-1]
	}
	// plan's edit deny comes first (then general), the plan directory after it (asking).
	plan := own("plan")
	if len(plan) != 3 || plan[0]["action"] != "edit" || plan[0]["effect"] != "deny" ||
		plan[1]["action"] != "subagent" || plan[1]["resource"] != "general" || plan[1]["effect"] != "deny" ||
		plan[2]["resource"] != "/home/u/.opencode/plan/*" || plan[2]["effect"] != "ask" {
		t.Errorf("plan's edit rules lost their order: %v", plan)
	}
	// explore's blanket deny leads.
	if ex := own("explore"); ex[0]["action"] != "*" || ex[0]["effect"] != "deny" || ex[1]["action"] != "shell" {
		t.Errorf("explore's blanket deny must lead: %v", ex)
	}
}

func TestFloorDeniesSubagentsWhenBackgroundIsNotAllowed(t *testing.T) {
	body, err := floorBackend(false).floorConfig(nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !hasRule(topLevel(t, body), "subagent", "*", "deny") {
		t.Errorf("a machine without background subagents must deny the subagent tool: %s", body)
	}
	allowed, _ := floorBackend(true).floorConfig(nil, nil, nil)
	if hasRule(topLevel(t, allowed), "subagent", "*", "deny") {
		t.Errorf("the top level names subagent on a machine that allows them: %s", allowed)
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
	if !strings.Contains(s, `{"action":"shell","effect":"ask","resource":"*"}`) || !strings.Contains(s, `{"action":"edit","effect":"deny","resource":"*"}`) {
		t.Errorf("patch %s must ask for shell and keep the edit deny", s)
	}
	if strings.Contains(s, `"effect":"allow"`) {
		t.Errorf("patch %s restates an allow", s)
	}
	if !strings.Contains(s, `{"action":"webfetch","effect":"ask","resource":"*"},{"action":"webfetch","effect":"ask","resource":"https://ok/*"}`) {
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
	body, _ := floorBackend(true).floorConfig(nil, nil, d)
	top := topLevel(t, body)
	if !hasRule(top, "edit", "*", "deny") || hasRule(top, "edit", "*", "ask") {
		t.Errorf("the owner's file deny did not survive the floor: %s", body)
	}
}

// A custom agent's own `* ask` or `subagent * ask` cannot reopen what the machine denies: each
// block ends with Code Mode and (when background subagents are off) the subagent tool denied.
func TestEveryAgentBlockEndsWithTheMachineDenies(t *testing.T) {
	b := floorBackend(false)
	patch := map[string]any{"zed": map[string]any{"permissions": []rule{mk("*", "*", "ask"), mk("task", "*", "ask")}}}
	body, err := b.floorConfig(nil, patch, map[string]bool{"edit": true})
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Agents map[string]struct {
			Permissions []map[string]string `json:"permissions"`
		} `json:"agents"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"build", "plan", "explore", "general", "zed", "title"} {
		p := got.Agents[name].Permissions
		if len(p) == 0 {
			t.Errorf("no block for %s", name)
			continue
		}
		tail := p[len(p)-3:]
		want := [][2]string{{"execute", "deny"}, {"subagent", "deny"}, {"edit", "deny"}}
		for i, w := range want {
			if tail[i]["action"] != w[0] || tail[i]["effect"] != w[1] || tail[i]["resource"] != "*" {
				t.Errorf("%s block tail = %v, want execute, subagent, edit denied", name, tail)
				break
			}
		}
	}
}

// opencode 2's saved ("always") approvals are project-wide standing allows beneath galopin's
// selector and ceiling: the floor check reports and deletes them.
func TestSavedApprovalsAreReportedAndDeleted(t *testing.T) {
	var deleted []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/permission/saved":
			_, _ = io.WriteString(w, `{"data":[{"id":"psv_1","action":"shell","resource":"make *"}]}`)
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/permission/saved/"):
			deleted = append(deleted, strings.TrimPrefix(r.URL.Path, "/api/permission/saved/"))
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	b := fakeServerBackend(t, srv)
	got := b.dropSavedApprovals(context.Background())
	if len(got) != 1 || got[0] != "saved:bash make *" || len(deleted) != 1 || deleted[0] != "psv_1" {
		t.Errorf("reported %v, deleted %v", got, deleted)
	}
}
