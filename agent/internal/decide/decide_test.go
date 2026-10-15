package decide

import (
	"testing"

	"galopin/internal/permrules"
)

const ws = "/work/proj"

func pol(max map[string]permrules.Action) Policy {
	return Policy{Ceiling: permrules.Ceiling{Max: max}, SafeDirs: []string{"/tmp"}}
}

func TestDecideTable(t *testing.T) {
	ex := []permrules.Exception{{ID: "ex_1", Permission: "bash", Patterns: []string{"go test *"}}}
	exAll := []permrules.Exception{{ID: "ex_2", Permission: "edit", Patterns: []string{"*"}}}
	tests := []struct {
		name string
		p    Policy
		s    State
		r    Request
		want Verdict
		step string
	}{
		// category x mode, no ceiling
		{"plan read", pol(nil), State{Mode: permrules.Deny}, Request{Key: "read", Patterns: []string{ws + "/a.go"}, Workspace: ws}, Once, "plan-read"},
		{"plan grep", pol(nil), State{Mode: permrules.Deny}, Request{Key: "grep", Patterns: []string{"foo"}, Workspace: ws}, Once, "plan-read"},
		{"plan edit", pol(nil), State{Mode: permrules.Deny}, Request{Key: "edit", Patterns: []string{"a.go"}, Workspace: ws}, Reject, "plan"},
		{"plan plan-file", pol(nil), State{Mode: permrules.Deny}, Request{Key: "edit", Patterns: []string{".opencode/plans/x.md"}, Workspace: ws}, Once, "plan-file"},
		{"plan bash", pol(nil), State{Mode: permrules.Deny}, Request{Key: "bash", Patterns: []string{"ls"}, Workspace: ws}, Reject, "plan"},
		{"plan web", pol(nil), State{Mode: permrules.Deny}, Request{Key: "webfetch", Patterns: []string{"https://x"}, Workspace: ws}, Reject, "plan"},
		{"plan mcp", pol(nil), State{Mode: permrules.Deny}, Request{Key: "srv_tool", Patterns: []string{"*"}, Workspace: ws}, Reject, "plan"},
		{"plan outside", pol(nil), State{Mode: permrules.Deny}, Request{Key: "external_directory", Patterns: []string{"/etc/*"}, Workspace: ws}, Reject, "plan"},
		{"plan safe dir", pol(nil), State{Mode: permrules.Deny}, Request{Key: "external_directory", Patterns: []string{"/tmp/*"}, Workspace: ws}, Once, "plan-safe-dir"},
		{"plan env read", pol(nil), State{Mode: permrules.Deny}, Request{Key: "read", Patterns: []string{ws + "/.env"}, Workspace: ws}, Reject, "plan"},
		{"plan spawn", pol(nil), State{Mode: permrules.Deny}, Request{Key: "task", Patterns: []string{"explore"}, Workspace: ws}, Once, "internal"},
		{"plan todo", pol(nil), State{Mode: permrules.Deny}, Request{Key: "todowrite", Workspace: ws}, Once, "internal"},
		{"plan exception cannot lift", pol(nil), State{Mode: permrules.Deny, Exceptions: ex}, Request{Key: "bash", Patterns: []string{"go test ./..."}, Workspace: ws}, Reject, "plan"},
		{"ask read", pol(nil), State{}, Request{Key: "read", Patterns: []string{ws + "/a.go"}, Workspace: ws}, Once, "ask-read"},
		{"ask read outside", pol(nil), State{}, Request{Key: "read", Patterns: []string{"/etc/passwd"}, Workspace: ws}, Card, "protected"},
		{"ask env read", pol(nil), State{}, Request{Key: "read", Patterns: []string{ws + "/.env"}, Workspace: ws}, Card, "protected"},
		{"ask env example", pol(nil), State{}, Request{Key: "read", Patterns: []string{ws + "/.env.example"}, Workspace: ws}, Once, "ask-read"},
		{"ask edit", pol(nil), State{}, Request{Key: "edit", Patterns: []string{"a.go"}, Workspace: ws}, Card, "ask"},
		{"ask bash", pol(nil), State{}, Request{Key: "bash", Patterns: []string{"ls"}, Workspace: ws}, Card, "ask"},
		{"ask web", pol(nil), State{}, Request{Key: "websearch", Patterns: []string{"q"}, Workspace: ws}, Card, "ask"},
		{"ask mcp", pol(nil), State{}, Request{Key: "srv_tool", Patterns: []string{"*"}, Workspace: ws}, Card, "ask"},
		{"ask spawn", pol(nil), State{}, Request{Key: "task", Patterns: []string{"general"}, Workspace: ws}, Once, "internal"},
		{"ask brake", pol(nil), State{}, Request{Key: "doom_loop", Patterns: []string{"bash"}, Workspace: ws}, Card, "protected"},
		{"ask exception", pol(nil), State{Exceptions: ex}, Request{Key: "bash", Patterns: []string{"go test ./..."}, Workspace: ws}, Once, "exception"},
		{"ask exception other cmd", pol(nil), State{Exceptions: ex}, Request{Key: "bash", Patterns: []string{"rm -rf x"}, Workspace: ws}, Card, "ask"},
		{"ask safe dir", pol(nil), State{}, Request{Key: "external_directory", Patterns: []string{"/tmp/*"}, Workspace: ws}, Once, "safe-dir"},
		{"allow edit", pol(nil), State{Mode: permrules.Allow}, Request{Key: "edit", Patterns: []string{"a.go"}, Workspace: ws}, Once, "allow"},
		{"allow bash", pol(nil), State{Mode: permrules.Allow}, Request{Key: "bash", Patterns: []string{"ls"}, Workspace: ws}, Once, "allow"},
		{"allow mcp", pol(nil), State{Mode: permrules.Allow}, Request{Key: "srv_tool", Patterns: []string{"*"}, Workspace: ws}, Once, "allow"},
		{"allow outside still asks", pol(nil), State{Mode: permrules.Allow}, Request{Key: "external_directory", Patterns: []string{"/etc/*"}, Workspace: ws}, Card, "protected"},
		{"allow brake still asks", pol(nil), State{Mode: permrules.Allow}, Request{Key: "doom_loop", Patterns: []string{"bash"}, Workspace: ws}, Card, "protected"},
		// ceiling x mode
		{"ceiling deny beats allow", pol(map[string]permrules.Action{"bash": permrules.Deny}), State{Mode: permrules.Allow}, Request{Key: "bash", Patterns: []string{"ls"}, Workspace: ws}, Reject, "ceiling"},
		{"ceiling deny beats exception", pol(map[string]permrules.Action{"bash": permrules.Deny}), State{Exceptions: ex}, Request{Key: "bash", Patterns: []string{"go test ./..."}, Workspace: ws}, Reject, "ceiling"},
		{"ceiling ask beats allow", pol(map[string]permrules.Action{"bash": permrules.Ask}), State{Mode: permrules.Allow}, Request{Key: "bash", Patterns: []string{"ls"}, Workspace: ws}, Card, "ceiling"},
		{"ceiling ask beats exception", pol(map[string]permrules.Action{"bash": permrules.Ask}), State{Exceptions: ex}, Request{Key: "bash", Patterns: []string{"go test ./..."}, Workspace: ws}, Card, "ceiling"},
		{"ceiling ask, plan still rejects", pol(map[string]permrules.Action{"bash": permrules.Ask}), State{Mode: permrules.Deny}, Request{Key: "bash", Patterns: []string{"ls"}, Workspace: ws}, Reject, "plan"},
		{"ceiling ask on read", pol(map[string]permrules.Action{"read": permrules.Ask}), State{}, Request{Key: "read", Patterns: []string{ws + "/a"}, Workspace: ws}, Card, "ceiling"},
		{"ceiling deny on task", pol(map[string]permrules.Action{"task": permrules.Deny}), State{}, Request{Key: "task", Patterns: []string{"x"}, Workspace: ws}, Reject, "ceiling"},
		{"ceiling ask on task", pol(map[string]permrules.Action{"task": permrules.Ask}), State{Mode: permrules.Allow}, Request{Key: "task", Patterns: []string{"x"}, Workspace: ws}, Card, "ceiling"},
		{"ceiling external_directory caps safe dir", pol(map[string]permrules.Action{"external_directory": permrules.Ask}), State{}, Request{Key: "external_directory", Patterns: []string{"/tmp/*"}, Workspace: ws}, Card, "ceiling"},
		{"ceiling external_directory deny caps outside edit", pol(map[string]permrules.Action{"external_directory": permrules.Deny}), State{Mode: permrules.Allow}, Request{Key: "edit", Patterns: []string{"/etc/x"}, Workspace: ws}, Reject, "ceiling"},
		{"allow-all exception", pol(nil), State{Exceptions: exAll}, Request{Key: "edit", Patterns: []string{"a.go"}, Workspace: ws}, Once, "exception"},
		// machine's own rules
		{"machine allow lifts the protected ask", Policy{Own: []permrules.Rule{{Permission: "external_directory", Pattern: "*", Action: permrules.Allow}}}, State{}, Request{Key: "external_directory", Patterns: []string{"/etc/*"}, Workspace: ws}, Once, "machine-rule"},
		{"machine allow of bash is not a licence on Ask", Policy{Own: []permrules.Rule{{Permission: "bash", Pattern: "*", Action: permrules.Allow}}}, State{}, Request{Key: "bash", Patterns: []string{"ls"}, Workspace: ws}, Card, "ask"},
		{"machine allow never lifts plan", Policy{Own: []permrules.Rule{{Permission: "external_directory", Pattern: "*", Action: permrules.Allow}}}, State{Mode: permrules.Deny}, Request{Key: "external_directory", Patterns: []string{"/etc/*"}, Workspace: ws}, Reject, "plan"},
		{"machine allow under ceiling ask", Policy{Own: []permrules.Rule{{Permission: "external_directory", Pattern: "*", Action: permrules.Allow}}, Ceiling: permrules.Ceiling{Max: map[string]permrules.Action{"external_directory": permrules.Ask}}}, State{}, Request{Key: "external_directory", Patterns: []string{"/etc/*"}, Workspace: ws}, Card, "ceiling"},
		{"machine deny rule", Policy{Own: []permrules.Rule{{Permission: "webfetch", Pattern: "*", Action: permrules.Deny}}}, State{Mode: permrules.Allow}, Request{Key: "webfetch", Patterns: []string{"u"}, Workspace: ws}, Reject, "ceiling"},
	}
	for _, tc := range tests {
		got := Decide(tc.p, tc.s, tc.r)
		if got.Verdict != tc.want || got.Step != tc.step {
			t.Errorf("%s: got %s/%s, want %s/%s", tc.name, got.Verdict, got.Step, tc.want, tc.step)
		}
		if got.Verdict == Reject && got.Reason == "" {
			t.Errorf("%s: a reject needs a reason", tc.name)
		}
	}
}

func TestCoordinationTool(t *testing.T) {
	grant := State{Coordination: []string{"session_read", "session_send"}}
	tests := []struct {
		name     string
		p        Policy
		s        State
		key      string
		delegate bool
		want     permrules.Action
	}{
		{"ask spawn", Policy{}, State{}, "session_spawn", false, permrules.Ask},
		{"allow spawn", Policy{}, State{Mode: permrules.Allow}, "session_spawn", false, permrules.Allow},
		{"allow send", Policy{}, State{Mode: permrules.Allow}, "session_send", false, permrules.Allow},
		{"allow read is grant-gated", Policy{}, State{Mode: permrules.Allow}, "session_read", false, permrules.Ask},
		{"list needs no approval", Policy{}, State{}, "session_list", false, permrules.Allow},
		{"grant read", Policy{}, grant, "session_read", false, permrules.Allow},
		{"grant does not cover spawn", Policy{}, grant, "session_spawn", false, permrules.Ask},
		{"plan refuses", Policy{}, State{Mode: permrules.Deny, Coordination: []string{"session_send"}}, "session_send", false, permrules.Deny},
		{"ceiling ask beats grant", Policy{Ceiling: permrules.Ceiling{Max: map[string]permrules.Action{"session_send": permrules.Ask}}}, grant, "session_send", false, permrules.Ask},
		{"ceiling deny", Policy{Ceiling: permrules.Ceiling{Max: map[string]permrules.Action{"session_send": permrules.Deny}}}, State{Mode: permrules.Allow}, "session_send", false, permrules.Deny},
		{"machine ask beats grant", Policy{Own: []permrules.Rule{{Permission: "session_send", Pattern: "*", Action: permrules.Ask}}}, grant, "session_send", false, permrules.Ask},
		{"machine allow", Policy{Own: []permrules.Rule{{Permission: "session_read", Pattern: "*", Action: permrules.Allow}}}, State{}, "session_read", false, permrules.Allow},
		{"delegate read in ask", Policy{}, State{}, "session_read", true, permrules.Allow},
		{"a Plan spawner's send to its delegate is rejected", Policy{}, State{Mode: permrules.Deny}, "session_send", true, permrules.Deny},
		{"a Plan spawner reads its delegate", Policy{}, State{Mode: permrules.Deny}, "session_read", true, permrules.Allow},
		{"a Plan caller's spawn is rejected, delegate or not", Policy{}, State{Mode: permrules.Deny}, "session_spawn", true, permrules.Deny},
		{"a Plan caller's schedule is rejected", Policy{}, State{Mode: permrules.Deny}, "schedule", true, permrules.Deny},
		{"an Ask spawner's send to its delegate is once", Policy{}, State{}, "session_send", true, permrules.Allow},
		{"a delegate on Ask sending to a Plan spawner is once", Policy{}, State{Mode: permrules.Ask}, "session_send", true, permrules.Allow},
		{"delegate under ceiling ask", Policy{Ceiling: permrules.Ceiling{Max: map[string]permrules.Action{"session_read": permrules.Ask}}}, State{}, "session_read", true, permrules.Ask},
		{"delegate under ceiling deny", Policy{Ceiling: permrules.Ceiling{Max: map[string]permrules.Action{"session_read": permrules.Deny}}}, State{}, "session_read", true, permrules.Deny},
	}
	for _, tc := range tests {
		got, _ := CoordinationTool(tc.p, tc.s, tc.key, tc.delegate)
		if got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}
}
