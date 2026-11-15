package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
)

// twoGroupServer lists two billable groups; defaultName is the console
// default ("" for none).
func twoGroupServer(t *testing.T, defaultName string) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{
			{"id": "g1", "name": "alpha", "is_default": defaultName == "alpha"},
			{"id": "g2", "name": `be"ta; $(x)`, "is_default": defaultName != "" && defaultName != "alpha"},
		}})
	}))
	t.Cleanup(srv.Close)
	return srv.URL + "/v1"
}

// With no terminal (the Mac app has none), several groups and a default pick
// the default instead of reading stdin.
func TestPickGroupNonInteractivePicksDefault(t *testing.T) {
	gw := twoGroupServer(t, "alpha")
	got, err := pickGroup(context.Background(), gw, "at", "", false, groupChoice{nonInteractive: true})
	if err != nil || got != "alpha" {
		t.Fatalf("got %q, %v", got, err)
	}
}

// With no default it fails, naming the groups and the way out.
func TestPickGroupNonInteractiveNoDefaultListsNames(t *testing.T) {
	gw := twoGroupServer(t, "")
	_, err := pickGroup(context.Background(), gw, "at", "", false, groupChoice{nonInteractive: true})
	if err == nil {
		t.Fatal("must fail")
	}
	for _, want := range []string{"alpha", "--group NAME", "default"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("%q missing from %v", want, err)
		}
	}
	if strings.Contains(err.Error(), "EOF") {
		t.Fatal(err)
	}
}

// The choice command gets the default then the names as plain arguments, and
// its answer must be one of the names.
func TestPickGroupChoiceCmd(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	gw := twoGroupServer(t, "alpha")
	// $1 = default, $2.. = names; print the second name, which holds shell metacharacters.
	pick := []string{"sh", "-c", `printf '%s' "$3"`, "sh"}
	got, err := pickGroup(context.Background(), gw, "at", "", false, groupChoice{cmd: pick, nonInteractive: true})
	if err != nil || got != `be"ta; $(x)` {
		t.Fatalf("got %q, %v", got, err)
	}
	echoDefault := []string{"sh", "-c", `printf '%s' "$1"`, "sh"}
	if got, err = pickGroup(context.Background(), gw, "at", "", false, groupChoice{cmd: echoDefault}); err != nil || got != "alpha" {
		t.Fatalf("default not passed first: %q, %v", got, err)
	}
	if _, err = pickGroup(context.Background(), gw, "at", "", false, groupChoice{cmd: []string{"sh", "-c", "printf nonsense", "sh"}}); err == nil {
		t.Fatal("an answer that is no group must fail")
	}
	if _, err = pickGroup(context.Background(), gw, "at", "", false, groupChoice{cmd: []string{"sh", "-c", "exit 1", "sh"}}); err == nil {
		t.Fatal("a cancelled choice must fail")
	}
}

// An explicit --group is still used without any prompt.
func TestPickGroupExplicitWins(t *testing.T) {
	gw := twoGroupServer(t, "alpha")
	got, err := pickGroup(context.Background(), gw, "at", `be"ta; $(x)`, false, groupChoice{nonInteractive: true})
	if err != nil || got != `be"ta; $(x)` {
		t.Fatalf("got %q, %v", got, err)
	}
}
