package policy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultIsClosed(t *testing.T) {
	p := Default()
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
	if len(p.Permission.Max) != 0 || len(p.Permission.Rules) != 0 {
		t.Errorf("a missing file must carry no ceiling and no rules: %+v", p.Permission)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	want := Policy{
		Permission:     Permission{Max: map[string]string{"bash": "ask"}, Rules: map[string]string{"edit": "allow"}},
		WorkspaceRoots: []string{"/srv/code"}, AllowFreeModels: true,
	}
	if err := Save(path, want); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.Permission.Max["bash"] != "ask" ||
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

// A policy.json from before the permission selector carries autoAccept and
// maybe permission.responders. Both are ignored on read and gone after a save:
// the responder they gated no longer exists, so an owner who enrolled with
// --allow-auto-accept keeps nothing of it, and nothing else is translated.
func TestLegacyAutoAcceptAndRespondersAreIgnoredAndDropped(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	body := `{"autoAccept":"allowed","terminal":"allowed","permission":{"responders":"allowed","max":{"bash":"ask"}}}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	p, err := Load(path)
	if err != nil {
		t.Fatalf("a legacy file must still load: %v", err)
	}
	if p.Permission.Max["bash"] != "ask" || len(p.Permission.Rules) != 0 {
		t.Errorf("the ceiling must survive and nothing else appear: %+v", p.Permission)
	}
	if !p.TerminalAllowed() {
		t.Error("the rest of the file still loads")
	}
	if err := Save(path, p); err != nil {
		t.Fatal(err)
	}
	saved, _ := os.ReadFile(path)
	if strings.Contains(string(saved), "autoAccept") || strings.Contains(string(saved), "responders") {
		t.Errorf("Save kept a retired field:\n%s", saved)
	}
}

func TestLoadRefusesAPermissionTypoInsteadOfUncapping(t *testing.T) {
	for name, body := range map[string]string{
		"ceiling typo": `{"permission":{"max":{"bash":"asc"}}}`,
		"wildcard key": `{"permission":{"max":{"*":"deny"}}}`,
		"rule typo":    `{"permission":{"rules":{"edit":"yes"}}}`,
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

func TestLiveOnlyTightens(t *testing.T) {
	live := NewLive(Permission{Max: map[string]string{"bash": "ask"}, Rules: map[string]string{"edit": "allow"}})

	// Looser input: ignored.
	ch := live.Tighten(Permission{Max: map[string]string{"bash": "allow", "edit": "allow"}, Rules: map[string]string{"edit": "allow", "read": "allow"}})
	if ch.Any() {
		t.Errorf("a looser file changed something: %+v", ch)
	}
	if got := live.Permission(); got.Max["bash"] != "ask" || got.Rules["read"] != "" {
		t.Errorf("after a loosening read: %+v", got)
	}

	// Tighter input: taken, and reported.
	ch = live.Tighten(Permission{Max: map[string]string{"bash": "deny", "webfetch": "ask"}, Rules: map[string]string{"edit": "ask"}})
	if !ch.Tightened {
		t.Errorf("change = %+v, want tightened", ch)
	}
	got := live.Permission()
	if got.Max["bash"] != "deny" || got.Max["webfetch"] != "ask" || got.Rules["edit"] != "ask" {
		t.Errorf("after tightening: %+v", got)
	}

	// Raising what was lowered: ignored, so a file edited back up cannot undo it.
	ch = live.Tighten(Permission{Max: map[string]string{"bash": "ask"}, Rules: map[string]string{"edit": "allow"}})
	if ch.Any() || live.Permission().Max["bash"] != "deny" || live.Permission().Rules["edit"] != "ask" {
		t.Errorf("a raised file undid a tightening: %+v %+v", ch, live.Permission())
	}

	// A new ask/deny rule where there was none tightens; a new allow does not.
	ch = live.Tighten(Permission{Rules: map[string]string{"read": "ask"}})
	if !ch.Tightened {
		t.Error("a new ask rule is a tightening")
	}
	if ch = live.Tighten(Permission{Rules: map[string]string{"write": "allow"}}); ch.Any() {
		t.Errorf("a new allow rule changed something: %+v", ch)
	}
}

func TestLiveLayers(t *testing.T) {
	l := NewLive(Permission{Max: map[string]string{"bash": "ask"}, Rules: map[string]string{"edit": "allow"}}).Layers()
	if l.Ceiling.Of("bash") != "ask" || len(l.Own) != 1 || l.Own[0].Permission != "edit" {
		t.Errorf("layers = %+v", l)
	}
}

// scratchDir is a temp directory this test may make and remove: under /tmp
// even when the box's TMPDIR points somewhere a test must not write (an
// opencode tmp dir belongs to a running galopin here).
func scratchDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "galopin-policy-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// The safe directories' three file states, and the one-way rule for a local
// change: a policy set may only REMOVE entries, never add one.
func TestSafeDirsAbsentIsEmptyAndCustom(t *testing.T) {
	dir := scratchDir(t)
	existing := filepath.Join(dir, "exists")
	if err := os.Mkdir(existing, 0o755); err != nil {
		t.Fatal(err)
	}

	// Absent: the default list, expanded and filtered to what exists. /tmp is
	// always among them; the temp dir only when this machine's TMPDIR is
	// somewhere a safe directory may name.
	p, err := Load(filepath.Join(dir, "policy.json")) // a missing file is Default
	if err != nil {
		t.Fatal(err)
	}
	if p.Permission.SafeDirs != nil {
		t.Errorf("an absent field must read as the default (nil), got %+v", p.Permission.SafeDirs)
	}
	def := p.Permission.EffectiveSafeDirs()
	if !equalStrings(def, DefaultSafeDirs()) {
		t.Errorf("EffectiveSafeDirs() = %v, want the default %v", def, DefaultSafeDirs())
	}
	var sawTmp bool
	for _, d := range def {
		sawTmp = sawTmp || d == "/tmp"
	}
	if !sawTmp {
		t.Errorf("the default list = %v, want /tmp in it", def)
	}

	// Custom entries are kept as given, even when they do not exist (an owner
	// who named one is not second-guessed).
	path := filepath.Join(dir, "custom.json")
	if err := os.WriteFile(path, []byte(`{"permission":{"safeDirs":["/data/scratch","/tmp"]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	p, err = Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := p.Permission.EffectiveSafeDirs(); !equalStrings(got, []string{"/data/scratch", "/tmp"}) {
		t.Errorf("custom list = %v, want it kept as given", got)
	}

	// An empty list is none, and it survives a save — the field may not
	// collapse back to the default on the way through the file.
	empty := filepath.Join(dir, "empty.json")
	if err := os.WriteFile(empty, []byte(`{"permission":{"safeDirs":[]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	p, err = Load(empty)
	if err != nil {
		t.Fatal(err)
	}
	if got := p.Permission.EffectiveSafeDirs(); len(got) != 0 {
		t.Errorf("an empty list = %v, want none", got)
	}
	if err := Save(empty, p); err != nil {
		t.Fatal(err)
	}
	saved, _ := os.ReadFile(empty)
	if !strings.Contains(string(saved), `"safeDirs": []`) {
		t.Errorf("Save dropped an empty safeDirs list:\n%s", saved)
	}
	p2, err := Load(empty)
	if err != nil {
		t.Fatal(err)
	}
	if p2.Permission.SafeDirs == nil || len(*p2.Permission.SafeDirs) != 0 {
		t.Errorf("the saved empty list read back as %+v, want [] (not the default)", p2.Permission.SafeDirs)
	}

	// A path that is not absolute, or not clean, is refused rather than
	// allowing whatever the working directory happens to be.
	for name, body := range map[string]string{
		"relative": `{"permission":{"safeDirs":["tmp"]}}`,
		"unclean":  `{"permission":{"safeDirs":["/tmp//x"]}}`,
		"empty":    `{"permission":{"safeDirs":[""]}}`,
	} {
		bad := filepath.Join(dir, "bad.json")
		if err := os.WriteFile(bad, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(bad); err == nil {
			t.Errorf("%s: Load accepted %s", name, body)
		}
	}
}

func TestLiveTightenOnlyRemovesSafeDirs(t *testing.T) {
	live := NewLive(Permission{SafeDirs: &[]string{"/tmp", "/home/u/.cache", "/data/scratch"}})
	if got := live.Layers().SafeDirs; !equalStrings(got, []string{"/tmp", "/home/u/.cache", "/data/scratch"}) {
		t.Fatalf("layers safe dirs = %v", got)
	}

	// A file that adds an entry is not a tightening: the addition is ignored.
	if ch := live.Tighten(Permission{SafeDirs: &[]string{"/tmp", "/home/u/.cache", "/data/scratch", "/srv/pub"}}); ch.Any() {
		t.Errorf("an added safe directory changed something: %+v", ch)
	}
	if got := live.Layers().SafeDirs; !equalStrings(got, []string{"/tmp", "/home/u/.cache", "/data/scratch"}) {
		t.Errorf("safe dirs after an attempted addition = %v", got)
	}

	// A file that drops one is: the entry goes, and the change is reported.
	if ch := live.Tighten(Permission{SafeDirs: &[]string{"/tmp", "/data/scratch"}}); !ch.Tightened {
		t.Error("removing a safe directory is a tightening")
	}
	if got := live.Layers().SafeDirs; !equalStrings(got, []string{"/tmp", "/data/scratch"}) {
		t.Errorf("safe dirs after a removal = %v", got)
	}

	// An empty list removes everything.
	if ch := live.Tighten(Permission{SafeDirs: &[]string{}}); !ch.Tightened {
		t.Error("an empty list removes the rest")
	}
	if got := live.Layers().SafeDirs; len(got) != 0 {
		t.Errorf("safe dirs after an empty list = %v, want none", got)
	}

	// A file that does not speak of safe directories leaves them as they are.
	if ch := live.Tighten(Permission{}); ch.Any() {
		t.Errorf("an absent field changed something: %+v", ch)
	}
	if got := live.Layers().SafeDirs; len(got) != 0 {
		t.Errorf("safe dirs after an absent field = %v, want none still", got)
	}
}

func TestDefaultSafeDirsFiltersToExistingAndConservative(t *testing.T) {
	def := DefaultSafeDirs()
	for _, d := range def {
		if !filepath.IsAbs(d) {
			t.Errorf("default entry %q is not absolute", d)
		}
		if info, err := os.Stat(d); err != nil || !info.IsDir() {
			t.Errorf("default entry %q does not exist as a directory", d)
		}
	}
	if !equalStrings(def, DefaultSafeDirs()) {
		t.Error("DefaultSafeDirs is not stable across calls")
	}
	// The conservative half: never the home directory itself, never a config,
	// ssh or personal-bin directory — whatever the environment names. On a
	// box whose TMPDIR lives under the config directory (a galopin unit does
	// exactly that), the temp-dir entry must be dropped, not kept.
	home, _ := os.UserHomeDir()
	if home != "" {
		for _, d := range def {
			forbidden := d == home
			for _, bad := range []string{filepath.Join(home, ".config"), filepath.Join(home, ".ssh"), filepath.Join(home, ".local", "bin")} {
				forbidden = forbidden || d == bad || strings.HasPrefix(d, bad+string(filepath.Separator))
			}
			if forbidden {
				t.Errorf("default entry %q is not conservative", d)
			}
		}
	}
	fake := scratchDir(t)
	tmpInConfig := filepath.Join(fake, ".config", "galopin", "opencode-tmp")
	goBuild := filepath.Join(fake, ".cache", "go-build")
	opencodeBin := filepath.Join(fake, ".cache", "opencode", "bin")
	for _, d := range []string{goBuild, opencodeBin, tmpInConfig} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", fake)
	t.Setenv("TMPDIR", tmpInConfig)
	t.Setenv("XDG_CACHE_HOME", "")
	got := DefaultSafeDirs()
	var hasTmp, hasGoBuild bool
	for _, d := range got {
		hasTmp, hasGoBuild = hasTmp || d == "/tmp", hasGoBuild || d == goBuild
		// The cache root holds programs other tools run (opencode's bin/,
		// Playwright's browsers): a write there would run code past the bash
		// ceiling, so only the named build caches under it are allowed.
		if d == filepath.Join(fake, ".cache") || strings.HasPrefix(d, filepath.Join(fake, ".cache", "opencode")) {
			t.Errorf("the default list = %v, must never name the cache root or opencode's cache", got)
		}
		if d == tmpInConfig {
			t.Errorf("the default list = %v, must never name a directory under the config one", got)
		}
	}
	if !hasTmp || !hasGoBuild {
		t.Errorf("the default list = %v, want /tmp and the go build cache", got)
	}

	// An XDG cache pointed into opencode's own cache names nothing there.
	t.Setenv("XDG_CACHE_HOME", filepath.Join(fake, ".cache", "opencode"))
	if err := os.MkdirAll(filepath.Join(fake, ".cache", "opencode", "go-build"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, d := range DefaultSafeDirs() {
		if strings.HasPrefix(d, filepath.Join(fake, ".cache", "opencode")) {
			t.Errorf("with XDG_CACHE_HOME inside opencode's cache the default list names %q", d)
		}
	}
}

func TestDisplaySafeDirsShortensTheHomePrefix(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("no home directory to shorten against")
	}
	got := DisplaySafeDirs([]string{"/tmp", filepath.Join(home, ".cache"), filepath.Join(home+"2", "x")})
	want := []string{"/tmp", "~/.cache", filepath.Join(home+"2", "x")}
	if !equalStrings(got, want) {
		t.Errorf("DisplaySafeDirs = %v, want %v (a neighbour directory is not the home)", got, want)
	}
}
