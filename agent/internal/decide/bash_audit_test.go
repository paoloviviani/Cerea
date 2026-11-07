package decide

import (
	"path/filepath"
	"testing"

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
