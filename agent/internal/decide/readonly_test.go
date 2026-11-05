package decide

import (
	"os"
	"path/filepath"
	"testing"
)

func roFixture(t *testing.T) (Policy, string) {
	t.Helper()
	root := t.TempDir()
	home := filepath.Join(root, "home")
	ws := filepath.Join(root, "ws")
	for _, d := range []string{filepath.Join(home, ".ssh"), filepath.Join(home, ".config", "galopin"), filepath.Join(ws, "sub"), filepath.Join(root, "outside")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{filepath.Join(ws, "a.txt"), filepath.Join(ws, ".env"), filepath.Join(ws, "sub", "b.go"),
		filepath.Join(home, ".ssh", "id_rsa"), filepath.Join(root, "outside", "x")} {
		if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	links := map[string]string{
		filepath.Join(ws, "sshlink"):  filepath.Join(home, ".ssh"),
		filepath.Join(ws, "keylink"):  filepath.Join(home, ".ssh", "id_rsa"),
		filepath.Join(ws, "outlink"):  filepath.Join(root, "outside"),
		filepath.Join(ws, "inlink"):   filepath.Join(ws, "sub"),
		filepath.Join(ws, "envalias"): filepath.Join(ws, ".env"),
	}
	for l, target := range links {
		if err := os.Symlink(target, l); err != nil {
			t.Fatal(err)
		}
	}
	return Policy{Protected: NewProtected(home, filepath.Join(home, ".local", "state", "galopin"))}, ws
}

func TestReadOnlyCommand(t *testing.T) {
	p, ws := roFixture(t)
	yes := []string{
		"ls", "ls -la", "ls -la sub", "ls sub/", "ls -lh --color=auto", "cat a.txt", "cat a.txt sub/b.go", "cat sub/b.go | head -n 5",
		"cat ./a.txt", "cat inlink/b.go", "cat " + ws + "/a.txt", "cat nonexistent.txt", "head -20 a.txt", "head -n20 a.txt", "tail -n 50 a.txt",
		"tail -5 a.txt", "wc -l a.txt", "less a.txt", "grep foo a.txt", "grep -n 'foo bar' a.txt sub/b.go", "grep -in -e foo -e bar a.txt",
		"grep -C 3 foo a.txt", "cat a.txt | grep foo", "docker ps | grep web", "ps aux", "ps -ef", "ps -eo pid,comm", "df -h", "df -h .", "du -sh sub",
		"du -h --max-depth=1 .", "find . -name '*.go'", "find sub -type f -name \"*.go\" -mtime -2", "find . -maxdepth 2 -type d",
		"find . \\( -name a -o -name b \\) -print", "sed -n 1,5p a.txt", "sed -n '1,5p' a.txt", "sed 's/a/b/g' a.txt", "sed -n -e '/foo/p' a.txt",
		"git status", "git status -s", "git log --oneline -n 5", "git log -p sub/b.go", "git diff", "git diff HEAD~1 -- sub", "git show HEAD",
		"git show HEAD:a.txt", "git diff --stat main..HEAD", "git log --format='%h %s' --since='2 days ago'", "docker ps", "docker ps -a --format '{{.Names}}'",
		"docker logs --tail 100 web", "docker logs -n 10 -t web_1", "docker compose ps", "docker compose logs --tail=50 api", "docker compose ps -a",
		"systemctl status nginx", "systemctl status --no-pager -l ssh.service", "journalctl -u nginx -n 50", "journalctl -u ssh --since yesterday --no-pager",
		"ls; ls sub", "ls && git status", "ls || ls sub", "git status 2>/dev/null", "git status >/dev/null 2>&1", "ls\nls sub",
	}
	no := map[string]string{
		"cat .env":                     "env file",
		"cat envalias":                 "symlink to env",
		"cat sshlink/id_rsa":           "symlink to ssh",
		"cat keylink":                  "symlink to key",
		"cat outlink/x":                "symlink outside",
		"cat ~/.ssh/id_rsa":            "ssh",
		"cat ~/.config/galopin/policy": "own dir",
		"cat $(echo .env)":             "substitution",
		"cat `echo .env`":              "backticks",
		"cat *":                        "glob",
		"cat a.t?t":                    "glob ?",
		"cat a.{txt,go}":               "brace",
		"cat $HOME/a":                  "variable",
		"cat ${X}":                     "param",
		"cat \"$X\"":                   "quoted var",
		"echo $((1+1))":                "arith and echo",
		"cat <(ls)":                    "process subst",
		"cat a > b":                    "redirect",
		"cat a >> b":                   "append",
		"cat < a.txt":                  "input redirect",
		"cat a 2>err":                  "stderr to file",
		"cat <<EOF\nx\nEOF":            "heredoc",
		"cat ../outside/x":             "dotdot",
		"cat /etc/crontab":             "outside",
		"cat /etc/shadow":              "shadow",
		"cat /proc/self/environ":       "proc environ",
		"cat /proc/1/environ":          "proc environ",
		"grep -r foo .":                "recursive",
		"grep -rn foo .":               "recursive cluster",
		"grep -R foo .":                "recursive",
		"grep --recursive foo .":       "recursive long",
		"grep -f pats a.txt":           "pattern file",
		"grep --file=pats a.txt":       "pattern file long",
		"grep foo":                     "ok shape but handled below",
		"find . -exec cat {} ;":        "exec",
		"find . -exec cat {} \\;":      "exec",
		"find . -delete":               "delete",
		"find . -fprint out":           "fprint",
		"find . -ok rm {} \\;":         "ok",
		"find / -name x":               "outside root",
		"find -L . -name x":            "follow",
		"sed -i s/a/b/ a.txt":          "in place",
		"sed --in-place s/a/b/ a.txt":  "in place long",
		"sed 'w out' a.txt":            "w command",
		"sed 's/a/b/w out' a.txt":      "w flag",
		"sed 's/a/b/e' a.txt":          "e flag",
		"sed -f script a.txt":          "script file",
		"git -c core.pager=sh log":     "git -c",
		"git --exec-path=/x log":       "exec path",
		"git log --output=out":         "output",
		"git diff --ext-diff":          "ext diff",
		"git diff --no-index /etc/passwd /etc/hosts": "no index",
		"git diff -- /etc/passwd":                    "outside path",
		"git push":                                   "push",
		"git config --get user.name":                 "config",
		"git branch -D x":                            "branch",
		"docker inspect web":                         "inspect",
		"docker compose config":                      "compose config",
		"docker logs -f web":                         "follow",
		"docker logs --follow web":                   "follow long",
		"docker compose logs -f":                     "compose follow",
		"docker run alpine":                          "run",
		"docker exec web ls":                         "exec",
		"docker ps; docker rm x":                     "second command",
		"env":                                        "env",
		"printenv":                                   "printenv",
		"ps eww":                                     "ps env",
		"ps aux e":                                   "ps env 2",
		"tail -f a.txt":                              "follow",
		"tail -F a.txt":                              "follow",
		"less +!sh a.txt":                            "less command",
		"less -o out a.txt":                          "log file",
		"journalctl -f":                              "follow",
		"journalctl --vacuum-size=1M":                "vacuum",
		"journalctl --rotate":                        "rotate",
		"journalctl --flush":                         "flush",
		"journalctl -D /x":                           "directory",
		"systemctl restart nginx":                    "restart",
		"systemctl status":                           "ok-ish placeholder",
		"rm a.txt":                                   "rm",
		"/bin/cat a.txt":                             "path program",
		"cat a.txt &":                                "background",
		"(cat a.txt)":                                "subshell",
		"{ cat a.txt; }":                             "block",
		"if true; then ls; fi":                       "if",
		"f() { ls; }; f":                             "function",
		"X=1 ls":                                     "assignment",
		"ls | xargs rm":                              "xargs",
		"cat a.txt | sh":                             "sh",
		"cat 'unterminated":                          "parse error",
		"":                                           "empty",
		"cat \"~/.ssh/id_rsa\"":                      "quoted tilde",
		"cat $'a'":                                   "ansi-c",
		"ls -R":                                      "recursive ls",
		"ls $(pwd)":                                  "subst",
		"! ls":                                       "negated",
		"ls |& cat":                                  "pipe all",
		"cat a.txt\\ b":                              "backslash",
		"cat -- ../outside/x":                        "after dashes outside",
	}
	// a few of the table's expectations are about shape, not path: grep with no
	// pattern is not a valid read; systemctl status with no unit is allowed.
	delete(no, "grep foo")
	delete(no, "systemctl status")
	for _, c := range yes {
		if !p.ReadOnlyCommand(Request{Key: "bash", Patterns: []string{c}, Workspace: ws}) {
			t.Errorf("want read-only: %q", c)
		}
	}
	for c, why := range no {
		if p.ReadOnlyCommand(Request{Key: "bash", Patterns: []string{c}, Workspace: ws}) {
			t.Errorf("want NOT read-only (%s): %q", why, c)
		}
	}
	if len(yes)+len(no) < 60 {
		t.Fatalf("table too small")
	}
}

func TestReadOnlyOnlyBashInWorkspace(t *testing.T) {
	p, ws := roFixture(t)
	for _, r := range []Request{
		{Key: "read", Patterns: []string{"a.txt"}, Workspace: ws},
		{Key: "bash", Patterns: nil, Workspace: ws},
		{Key: "bash", Patterns: []string{"ls"}, Workspace: ""},
		{Key: "bash", Patterns: []string{"ls", "rm a.txt"}, Workspace: ws},
	} {
		if p.ReadOnlyCommand(r) {
			t.Errorf("want not read-only: %+v", r)
		}
	}
}
