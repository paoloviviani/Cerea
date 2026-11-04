package policy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/internal/decide"
)

func loadOld(t *testing.T, body string) Policy {
	t.Helper()
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	p, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func wantLimits(t *testing.T, p Permission, want map[string]string) {
	t.Helper()
	got := p.EffectiveLimits()
	for c, w := range want {
		if got[decide.Class(c)].Word() != w {
			t.Errorf("class %s = %s, want %s (all: %v)", c, got[decide.Class(c)].Word(), w, got)
		}
	}
}

// The policy.json a default `enroll` wrote before classes.
const oldDefaultEnroll = `{
  "permission": {"max": {"bash": "ask"}},
  "workspaceRoots": null,
  "allowFreeModels": false,
  "files": "read",
  "fileWrite": "denied",
  "terminal": "allowed",
  "maxTerminals": 8,
  "commandShell": "allowed",
  "agentTools": "allowed",
  "backgroundSubagents": "allowed"
}`

func TestMigrationOfADefaultEnroll(t *testing.T) {
	p := loadOld(t, oldDefaultEnroll)
	wantLimits(t, p.Permission, map[string]string{
		"edit": "run", "command": "ask", "web": "run", "outside": "ask",
		"secrets": "ask", "agents": "run", "tools": "run", "loop": "ask",
	})
	if len(p.Permission.Notices) != 0 || p.Permission.Max != nil || len(p.Permission.Rules) != 0 {
		t.Errorf("a default machine migrates silently and leaves no legacy keys: %+v", p.Permission)
	}
	// Everything else is untouched.
	if p.Terminal != TerminalAllowed || p.FileWrite != FileWriteDenied {
		t.Errorf("non-permission settings changed: %+v", p)
	}
	// And it equals today's default (the ceiling the opencode layer sees).
	if got := p.Permission.Ceiling(); got.Of("bash") != "ask" || len(got.Keys()) != 1 {
		t.Errorf("ceiling = %v", got.Max)
	}
}

func TestMigrationOfARaisedBash(t *testing.T) {
	p := loadOld(t, `{"permission":{"max":{"bash":"allow"}},"workspaceRoots":[],"allowFreeModels":false}`)
	// The owner raised bash; the protected step's asks stay.
	wantLimits(t, p.Permission, map[string]string{"command": "run", "outside": "ask", "secrets": "ask", "loop": "ask", "edit": "run"})
	if len(p.Permission.Ceiling().Keys()) != 0 {
		t.Errorf("a machine whose bash runs caps nothing at the opencode layer: %v", p.Permission.Ceiling().Max)
	}
}

func TestMigrationOfCustomCeilingsAndRules(t *testing.T) {
	p := loadOld(t, `{
	  "permission": {
	    "max": {"bash": "ask", "edit": "ask", "session_send": "deny", "mcp_crm_write": "ask"},
	    "rules": {"external_directory": "allow", "edit": "allow", "webfetch": "allow", "read": "allow", "doom_loop": "allow", "session_read": "ask"}
	  },
	  "workspaceRoots": [], "allowFreeModels": false
	}`)
	wantLimits(t, p.Permission, map[string]string{
		"edit":    "ask", // the most cautious: its ceiling
		"command": "ask",
		"web":     "run", // a rule that covers 1 of 3 keys is dropped, nothing capped
		"outside": "run", // an own allow lifted the protected ask
		"secrets": "ask",
		"agents":  "never", // session_send deny is the most cautious of its keys
		"tools":   "ask",   // an unknown (connector) key capped at ask
		"loop":    "ask",
	})
	// edit's single key agrees, so its allow rule is carried; webfetch's is not.
	if p.Permission.Rules["edit"] != "allow" || len(p.Permission.Rules) != 1 {
		t.Errorf("carried rules = %v, want only edit=allow", p.Permission.Rules)
	}
	joined := strings.Join(p.Permission.Notices, "\n")
	for _, want := range []string{"web class were dropped", "read was dropped", "doom_loop was dropped"} {
		if !strings.Contains(joined, want) {
			t.Errorf("notices lack %q:\n%s", want, joined)
		}
	}
}

func TestMigrationOfAMachineWithNoPermissionBlock(t *testing.T) {
	// No ceiling at all: bash was uncapped, so command runs (the migration is
	// tighten-only: it never invents a limit the owner did not have, beyond
	// the session-level asks that always existed).
	p := loadOld(t, `{"workspaceRoots":[],"allowFreeModels":false,"terminal":"allowed"}`)
	wantLimits(t, p.Permission, map[string]string{"command": "run", "outside": "ask", "secrets": "ask", "loop": "ask", "edit": "run"})
}

func TestMigrationNeverLoosensAndDeniesBecomeNever(t *testing.T) {
	p := loadOld(t, `{"permission":{"max":{"bash":"deny","external_directory":"deny","doom_loop":"deny","webfetch":"ask","websearch":"deny"}}}`)
	wantLimits(t, p.Permission, map[string]string{"command": "never", "outside": "never", "loop": "stop", "web": "never"})
}

func TestMigrationIsIdempotentAndASavedFileKeepsItsClasses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(path, []byte(`{"permission":{"max":{"bash":"deny"},"rules":{"edit":"allow"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	first, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := Save(path, first); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(path)
	if strings.Contains(string(body), `"max"`) || !strings.Contains(string(body), `"limits"`) {
		t.Errorf("a saved policy is in class form:\n%s", body)
	}
	second, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	for c, l := range first.Permission.EffectiveLimits() {
		if second.Permission.EffectiveLimits()[c] != l {
			t.Errorf("%s changed across a save/load: %s -> %s", c, l.Word(), second.Permission.EffectiveLimits()[c].Word())
		}
	}
	if second.Permission.Rules["edit"] != "allow" {
		t.Errorf("a carried rule did not survive: %v", second.Permission.Rules)
	}
}

func TestZeroPolicySavesAsTheDefaultsNotAsNoCeiling(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := Save(path, Policy{}); err != nil {
		t.Fatal(err)
	}
	p, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	wantLimits(t, p.Permission, map[string]string{"command": "ask"})
}

func TestLoadRefusesALimitTheClassDoesNotTake(t *testing.T) {
	for _, bad := range []string{`{"secrets":"run"}`, `{"loop":"run"}`, `{"loop":"never"}`, `{"command":"maybe"}`, `{"colour":"ask"}`, `{"command":"allow"}`} {
		path := filepath.Join(t.TempDir(), "policy.json")
		if err := os.WriteFile(path, []byte(`{"permission":{"limits":`+bad+`}}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path); err == nil {
			t.Errorf("%s was accepted", bad)
		}
	}
}

func TestLiveTightensClassesAndNeverLoosens(t *testing.T) {
	cur := Default().Permission
	live := NewLive(cur)
	next := Default().Permission
	next.Limits["command"] = "never"
	next.Limits["edit"] = "ask"
	next.Limits["web"] = "run"
	if ch := live.Tighten(next); !ch.Tightened {
		t.Fatal("not tightened")
	}
	got := live.Permission().EffectiveLimits()
	if got[decide.ClassCommand] != decide.Never || got[decide.ClassEdit] != decide.AskLimit {
		t.Errorf("limits = %v", got)
	}
	loose := Default().Permission
	loose.Limits["command"] = "run"
	loose.Limits["edit"] = "run"
	loose.Limits["loop"] = "ask"
	if ch := live.Tighten(loose); ch.Tightened {
		t.Errorf("a looser file tightened something: %+v", ch)
	}
	got = live.Permission().EffectiveLimits()
	if got[decide.ClassCommand] != decide.Never || got[decide.ClassEdit] != decide.AskLimit {
		t.Errorf("a looser file was taken in: %v", got)
	}
	// loop ask -> stop is a tightening.
	stop := Default().Permission
	stop.Limits["loop"] = "stop"
	if ch := live.Tighten(stop); !ch.Tightened || live.Permission().EffectiveLimits()[decide.ClassLoop] != decide.Stop {
		t.Errorf("loop stop not taken in: %+v", ch)
	}
	// The layers carry the limits for the decision function.
	if l := live.Layers().Limits; l["command"] != "never" {
		t.Errorf("layers limits = %v", l)
	}
}

func TestWireLimitsAreAllEightInWireWords(t *testing.T) {
	p := Default().Permission
	p.Limits["loop"] = "stop"
	p.Limits["tools"] = "never"
	got := p.WireLimits()
	want := map[string]string{"edit": "allow", "command": "ask", "web": "allow", "outside": "ask", "secrets": "ask", "agents": "allow", "tools": "deny", "loop": "stop"}
	if len(got) != 8 {
		t.Fatalf("wire limits = %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %s, want %s", k, got[k], v)
		}
	}
	// A zero permission block still reports every class, at its default.
	if z := (Permission{}).WireLimits(); len(z) != 8 || z["command"] != "ask" {
		t.Errorf("zero permission wire limits = %v", z)
	}
}

func TestTableNamesEveryClassInPlainWords(t *testing.T) {
	rows := Default().Permission.Table()
	if len(rows) != 8 {
		t.Fatalf("rows = %v", rows)
	}
	for i, c := range decide.Classes {
		if !strings.Contains(rows[i], string(c)) || !strings.Contains(rows[i], c.Meaning()) {
			t.Errorf("row %d = %q", i, rows[i])
		}
	}
}
