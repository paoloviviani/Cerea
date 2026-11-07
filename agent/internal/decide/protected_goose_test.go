package decide

import "testing"

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
