package policy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultIsClosed(t *testing.T) {
	p := Default()
	if p.Permission.RespondersAllowed() {
		t.Error("default policy must not let a session auto-accept")
	}
	if p.AllowFreeModels {
		t.Error("default policy must not allow free models")
	}
	if p.TerminalAllowed() {
		t.Error("default policy must deny the terminal (ADR 0090)")
	}
	if p.BackgroundSubagentsAllowed() {
		t.Error("default policy must deny background subagents")
	}
	if got := p.EffectiveMaxTerminals(); got != DefaultMaxTerminals {
		t.Errorf("EffectiveMaxTerminals() = %d, want the default %d", got, DefaultMaxTerminals)
	}
}

func TestBackgroundSubagentsAllowed(t *testing.T) {
	if (Policy{BackgroundSubagents: TerminalDenied}).BackgroundSubagentsAllowed() {
		t.Error("denied must not be allowed")
	}
	if !(Policy{BackgroundSubagents: TerminalAllowed}).BackgroundSubagentsAllowed() {
		t.Error("allowed must be allowed")
	}
	if (Policy{}).BackgroundSubagentsAllowed() {
		t.Error("a zero-value Policy (never enrolled with the background flag) must deny")
	}
}

func TestTerminalAllowed(t *testing.T) {
	if (Policy{Terminal: TerminalDenied}).TerminalAllowed() {
		t.Error("denied must not be allowed")
	}
	if !(Policy{Terminal: TerminalAllowed}).TerminalAllowed() {
		t.Error("allowed must be allowed")
	}
	if (Policy{}).TerminalAllowed() {
		t.Error("a zero-value Policy (never enrolled with any terminal flag) must deny")
	}
}

func TestEffectiveMaxTerminals(t *testing.T) {
	if got := (Policy{MaxTerminals: 3}).EffectiveMaxTerminals(); got != 3 {
		t.Errorf("got %d, want 3", got)
	}
	if got := (Policy{MaxTerminals: 0}).EffectiveMaxTerminals(); got != DefaultMaxTerminals {
		t.Errorf("got %d, want the default %d", got, DefaultMaxTerminals)
	}
}

func TestLoadDefaultsTerminalToDenied(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(path, []byte(`{"autoAccept":"denied"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	p, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if p.Terminal != TerminalDenied {
		t.Errorf("Terminal = %q, want %q for a policy.json predating this field", p.Terminal, TerminalDenied)
	}
	if p.BackgroundSubagents != TerminalDenied {
		t.Errorf("BackgroundSubagents = %q, want %q for a policy.json predating this field", p.BackgroundSubagents, TerminalDenied)
	}
}

func TestLoadMissingFileIsDefault(t *testing.T) {
	p, err := Load(filepath.Join(t.TempDir(), "no-such-policy.json"))
	if err != nil {
		t.Fatalf("Load of a missing file must not error: %v", err)
	}
	if p.Permission.Responders != TerminalDenied {
		t.Errorf("Responders = %q, want denied", p.Permission.Responders)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	want := Policy{
		Permission:     Permission{Responders: TerminalAllowed, Max: map[string]string{"bash": "ask"}, Rules: map[string]string{"edit": "allow"}},
		WorkspaceRoots: []string{"/srv/code"}, AllowFreeModels: true,
	}
	if err := Save(path, want); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.Permission.Responders != want.Permission.Responders || got.Permission.Max["bash"] != "ask" ||
		got.Permission.Rules["edit"] != "allow" || got.AllowFreeModels != want.AllowFreeModels ||
		!equalStrings(got.WorkspaceRoots, want.WorkspaceRoots) {
		t.Errorf("round trip mismatch: got %+v, want %+v", got, want)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("policy.json mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestAllowedEmptyRootsIsUnrestricted(t *testing.T) {
	ok, err := Allowed(nil, t.TempDir())
	if err != nil || !ok {
		t.Fatalf("empty roots must allow anything: ok=%v err=%v", ok, err)
	}
}

func TestAllowedPrefixAndSymlink(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "project")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()

	ok, err := Allowed([]string{root}, sub)
	if err != nil || !ok {
		t.Fatalf("a subdirectory of an allowed root must pass: ok=%v err=%v", ok, err)
	}
	ok, err = Allowed([]string{root}, outside)
	if err != nil || ok {
		t.Fatalf("a directory outside every root must fail: ok=%v err=%v", ok, err)
	}

	// A symlink inside the root that points outside it must resolve to its
	// real target and be refused — a bare string prefix check on the
	// unresolved path would wrongly allow it.
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	ok, err = Allowed([]string{root}, link)
	if err != nil || ok {
		t.Fatalf("a symlink escaping the root must be refused: ok=%v err=%v", ok, err)
	}
}

func TestFilterModelIDs(t *testing.T) {
	ids := []string{"pystino/coder-large", "anthropic/claude", "pystino/chat-small"}

	closed := Policy{AllowFreeModels: false}
	got := closed.FilterModelIDs(ids)
	want := []string{"pystino/coder-large", "pystino/chat-small"}
	if !equalStrings(got, want) {
		t.Errorf("closed policy: got %v, want %v", got, want)
	}

	open := Policy{AllowFreeModels: true}
	got = open.FilterModelIDs(ids)
	if !equalStrings(got, ids) {
		t.Errorf("open policy must pass every id through: got %v", got)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// A policy.json from before the pass-through carries autoAccept. It is
// ignored on load and gone after a save: nothing about the old word is
// translated into the new ones (translating "allowed" into a responder, or
// worse into rules, would loosen a machine nobody touched).
func TestLegacyAutoAcceptIsIgnoredAndDropped(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(path, []byte(`{"autoAccept":"allowed","terminal":"allowed"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	p, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if p.Permission.RespondersAllowed() {
		t.Error("a legacy autoAccept:allowed must not become a responder")
	}
	if !p.TerminalAllowed() {
		t.Error("the rest of the file still loads")
	}
	if err := Save(path, p); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(path)
	if strings.Contains(string(body), "autoAccept") {
		t.Errorf("Save kept the legacy field:\n%s", body)
	}
}

func TestLoadRefusesAPermissionTypoInsteadOfUncapping(t *testing.T) {
	for name, body := range map[string]string{
		"ceiling typo":        `{"permission":{"max":{"bash":"asc"}}}`,
		"wildcard key":        `{"permission":{"max":{"*":"deny"}}}`,
		"rule typo":           `{"permission":{"rules":{"edit":"yes"}}}`,
		"responders nonsense": `{"permission":{"responders":"maybe"}}`,
	} {
		path := filepath.Join(t.TempDir(), "policy.json")
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path); err == nil {
			t.Errorf("%s: Load accepted %s", name, body)
		}
	}
}

func TestPermissionCeilingAndRules(t *testing.T) {
	p := Permission{Max: map[string]string{"bash": "ask", "edit": "deny"}, Rules: map[string]string{"edit": "allow", "read": "allow"}}
	if got := p.Ceiling().Of("bash"); got != "ask" {
		t.Errorf("bash ceiling = %s", got)
	}
	if got := p.Ceiling().Of("webfetch"); got != "allow" {
		t.Errorf("an uncapped key = %s, want allow", got)
	}
	rules := p.OwnRules()
	if len(rules) != 2 || rules[0].Permission != "edit" || rules[1].Permission != "read" {
		t.Errorf("OwnRules = %+v, want edit then read (sorted)", rules)
	}
}
