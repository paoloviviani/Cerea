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
		Permission:     Permission{Deny: []string{"web", "command"}},
		WorkspaceRoots: []string{"/srv/code"}, AllowFreeModels: true,
	}
	if err := Save(path, want); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !equalStrings(got.Permission.Deny, []string{"command", "web"}) || got.AllowFreeModels != want.AllowFreeModels ||
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
	if p.Permission.Max != nil || len(p.Permission.Deny) != 0 || len(p.Permission.Notices) != 1 {
		t.Errorf("a retired ceiling is dropped with a notice, and nothing else appears: %+v", p.Permission)
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

// ADR 0109: a policy.json from before it, with limits, a ceiling and own rules
// (even malformed ones), loads, says so, and ignores them; the next write drops
// them.
func TestRetiredLimitsLoadWarnAndAreIgnored(t *testing.T) {
	for name, body := range map[string]string{
		"limits":       `{"permission":{"limits":{"command":"never","edit":"ask","loop":"stop"}}}`,
		"ceiling":      `{"permission":{"max":{"bash":"deny"}}}`,
		"rules":        `{"permission":{"rules":{"edit":"allow"}}}`,
		"typo ignored": `{"permission":{"max":{"bash":"asc"},"limits":{"nonsense":"x"}}}`,
	} {
		path := filepath.Join(t.TempDir(), "policy.json")
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		p, err := Load(path)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(p.Permission.Notices) != 1 || !strings.Contains(p.Permission.Notices[0], "ignored") {
			t.Errorf("%s: notices %v", name, p.Permission.Notices)
		}
		if len(p.Permission.DenySet()) != 0 || len(p.Permission.Ceiling().Keys()) != 0 {
			t.Errorf("%s: a retired field must not refuse anything: %+v", name, p.Permission)
		}
		if err := Save(path, p); err != nil {
			t.Fatal(err)
		}
		saved, _ := os.ReadFile(path)
		for _, w := range []string{"limits", `"max"`, `"rules"`} {
			if strings.Contains(string(saved), w) {
				t.Errorf("%s: Save kept %s:\n%s", name, w, saved)
			}
		}
	}
}

func TestLoadRefusesAnUnknownOrLoopDeny(t *testing.T) {
	for _, body := range []string{`{"permission":{"deny":["nonsense"]}}`, `{"permission":{"deny":["loop"]}}`} {
		path := filepath.Join(t.TempDir(), "policy.json")
		_ = os.WriteFile(path, []byte(body), 0o600)
		if _, err := Load(path); err == nil {
			t.Errorf("Load accepted %s", body)
		}
	}
}

func TestDenyCeilingAndSet(t *testing.T) {
	p := Permission{Deny: []string{"web", "command", "web", "edit"}}
	p.Normalize()
	if !equalStrings(p.Deny, []string{"command", "edit", "web"}) {
		t.Errorf("Normalize: %v", p.Deny)
	}
	if got := p.Ceiling().Of("bash"); got != "deny" {
		t.Errorf("bash ceiling = %s", got)
	}
	if got := p.Ceiling().Of("webfetch"); got != "deny" {
		t.Errorf("webfetch ceiling = %s", got)
	}
	if got := p.Ceiling().Of("task"); got != "allow" {
		t.Errorf("an undenied key = %s, want allow", got)
	}
	if !p.Denied("web") || p.Denied("agents") {
		t.Error("Denied")
	}
	if p.AddDeny("web") || !p.AddDeny("agents") || !p.RemoveDeny("agents") || p.RemoveDeny("agents") {
		t.Error("AddDeny/RemoveDeny report")
	}
}

func TestLiveOnlyTightens(t *testing.T) {
	live := NewLive(Permission{Deny: []string{"command"}})
	// A file that no longer denies it: ignored (loosening needs enroll).
	if ch := live.Tighten(Permission{}); ch.Any() || !live.Permission().Denied("command") {
		t.Errorf("a looser file changed something: %+v", live.Permission())
	}
	// A new deny: taken, and reported.
	if ch := live.Tighten(Permission{Deny: []string{"command", "web"}}); !ch.Tightened || !live.Permission().Denied("web") {
		t.Errorf("a new deny was not taken: %+v", live.Permission())
	}
	// Retired limits in a re-read file change nothing.
	if ch := live.Tighten(Permission{Limits: map[string]string{"edit": "never"}}); ch.Any() || live.Permission().Denied("edit") {
		t.Errorf("a retired limit was taken: %+v", live.Permission())
	}
}

func TestLiveLayers(t *testing.T) {
	l := NewLive(Permission{Deny: []string{"command"}}).Layers()
	if l.Ceiling.Of("bash") != "deny" || len(l.Deny) != 1 || l.Deny[0] != "command" {
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

// .env files left the explorer's default list (2026-11-03) but never the
// prompt list: a command's @.env would put the file in the prompt with no ask.
func TestEnvFilesShownInTheExplorerButNeverPulledIntoAPrompt(t *testing.T) {
	for _, g := range DefaultFileDeny {
		if g == ".env" || g == ".env.*" || g == ".envrc" {
			t.Errorf("DefaultFileDeny still holds %q", g)
		}
	}
	got := Policy{}.EffectivePromptFileDeny()
	if len(got) < 2 || got[0] != ".env" || got[1] != ".env.*" {
		t.Errorf("EffectivePromptFileDeny() = %v, want the .env patterns first", got)
	}
	// --no-default-file-deny drops the whole built-in secret list, prompts included
	// (the owner's explicit, amber choice; as before .env left the explorer list).
	dropped := Policy{NoDefaultFileDeny: true, FileDeny: []string{"*.secret"}}.EffectivePromptFileDeny()
	if len(dropped) != 1 || dropped[0] != "*.secret" {
		t.Errorf("EffectivePromptFileDeny(no defaults) = %v, want only the owner's globs", dropped)
	}
}
