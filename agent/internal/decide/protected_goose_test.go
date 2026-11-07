package decide

import (
	"os"
	"path/filepath"
	"testing"
)

// The user's own goose holds the local-endpoint bearer and the proxy secret 'galopin
// goose setup' writes, and a write there could turn on GOOSE_MODE: auto (ADR 0110).
func TestProtectedCoversTheUsersGooseAndGalopinsOwnState(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "/xdg/config")
	t.Setenv("XDG_DATA_HOME", "/xdg/data")
	t.Setenv("GOOSE_PATH_ROOT", "/goose/root")
	pr := NewProtected("/home/u", "/state/galopin")
	paths := []string{
		"/home/u/.config/goose/config.yaml",
		"/home/u/.local/share/goose/sessions/x",
		"/home/u/Library/Application Support/Block/goose/config.yaml",
		"/xdg/config/goose/config.yaml",
		"/xdg/data/goose/sessions",
		"/goose/root/config/config.yaml",
	}
	for _, p := range paths {
		for _, key := range []string{"read", "edit"} {
			r := Request{Key: key, Patterns: []string{p}, Workspace: "/work"}
			if _, ok := pr.SecretHit(r); !ok {
				t.Errorf("%s %s: not a secrets hit", key, p)
			}
			if _, ok := pr.OwnHit(r); !ok {
				t.Errorf("%s %s: not an own-file hit", key, p)
			}
		}
	}
	// a command naming them, in either spelling
	for _, cmd := range []string{"cat ~/.config/goose/config.yaml", "cat /home/u/.config/goose/config.yaml"} {
		if _, ok := pr.SecretHit(Request{Key: "bash", Patterns: []string{cmd}, Workspace: "/work"}); !ok {
			t.Errorf("%q: not a secrets hit", cmd)
		}
	}
	// the endpoint's secret file lives in the state dir
	r := Request{Key: "read", Patterns: []string{"/state/galopin/local-agents.json"}, Workspace: "/work"}
	if _, ok := pr.OwnHit(r); !ok {
		t.Error("local-agents.json is not protected")
	}
	// and an ordinary file is still not
	if _, ok := pr.OwnHit(Request{Key: "edit", Patterns: []string{"/work/a.go"}, Workspace: "/work"}); ok {
		t.Error("an ordinary file is protected")
	}
}

// A protected directory reached through a symlink (a dotfiles repo linked into the
// workspace, ~/.config -> there) is still protected, for a path and for a command.
func TestProtectedFollowsSymlinks(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	work := filepath.Join(root, "work")
	dots := filepath.Join(work, "dotfiles")
	for _, d := range []string{filepath.Join(dots, "goose"), filepath.Join(dots, "galopin"), home} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// ~/.config -> <work>/dotfiles
	if err := os.Symlink(dots, filepath.Join(home, ".config")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", "")
	t.Setenv("GOOSE_PATH_ROOT", "")
	pr := NewProtected(home, filepath.Join(root, "state"))
	// reached by its real, workspace-side path
	for _, p := range []string{"dotfiles/goose/config.yaml", "dotfiles/galopin/credentials.json"} {
		r := Request{Key: "read", Patterns: []string{p}, Workspace: work}
		if _, ok := pr.OwnHit(r); !ok {
			t.Errorf("%s: not an own-file hit", p)
		}
	}
	if _, ok := pr.SecretHit(Request{Key: "read", Patterns: []string{"dotfiles/goose/config.yaml"}, Workspace: work}); !ok {
		t.Error("the goose config by its real path is not a secrets hit")
	}
	// reached by the link, with the symlink only in the argument's directory
	if err := os.Symlink(filepath.Join(home, ".config", "goose"), filepath.Join(work, "goose-link")); err != nil {
		t.Fatal(err)
	}
	if _, ok := pr.OwnHit(Request{Key: "read", Patterns: []string{"goose-link/config.yaml"}, Workspace: work}); !ok {
		t.Error("a link to the goose config is not protected")
	}
	if _, ok := pr.OwnHit(Request{Key: "edit", Patterns: []string{"README.md"}, Workspace: work}); ok {
		t.Error("an ordinary file is protected")
	}
}

func TestProtectedExtraOwnAndShellSpellings(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("GOOSE_PATH_ROOT", "")
	pr := NewProtected("/home/u", "/state", "/elsewhere/creds/goose")
	if _, ok := pr.OwnHit(Request{Key: "read", Patterns: []string{"/elsewhere/creds/goose/config/x"}, Workspace: "/w"}); !ok {
		t.Error("the goose root passed in is not protected")
	}
	for _, cmd := range []string{
		"cat $HOME/.config/goose/config.yaml",
		"cat ${HOME}/.config/goose/config.yaml",
		"cat ~/.config/goose/config.yaml",
	} {
		if _, ok := pr.SecretHit(Request{Key: "bash", Patterns: []string{cmd}, Workspace: "/w"}); !ok {
			t.Errorf("%q: not a secrets hit", cmd)
		}
	}
	if _, ok := pr.SecretHit(Request{Key: "bash", Patterns: []string{"cat $HOME/notes.txt"}, Workspace: "/w"}); ok {
		t.Error("an unrelated file under $HOME is a secrets hit")
	}
	// macOS: the filesystem ignores case
	pr.fold = true
	if _, ok := pr.SecretHit(Request{Key: "read", Patterns: []string{"/Home/U/.Config/Goose/config.yaml"}, Workspace: "/w"}); !ok {
		t.Error("case-insensitive path not matched with fold")
	}
	if _, ok := pr.SecretHit(Request{Key: "bash", Patterns: []string{"cat ~/.CONFIG/goose/config.yaml"}, Workspace: "/w"}); !ok {
		t.Error("case-insensitive command not matched with fold")
	}
}
