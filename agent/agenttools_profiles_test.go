package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/internal/backend"
	"galopin/internal/permrules"
	"galopin/internal/policy"
)

func TestParseProfilesValidates(t *testing.T) {
	ok, err := parseProfiles([]byte(`{"profiles":{"careful":{"model":"p/m","mode":"Ask","notes":"be careful"},"ro":{"mode":"plan"}}}`))
	if err != nil || len(ok) != 2 || ok["careful"].Model != "p/m" {
		t.Fatalf("valid file: %v %+v", err, ok)
	}
	bad := map[string]string{
		"unknown field":  `{"profiles":{"a":{"modle":"x"}}}`,
		"unknown top":    `{"profiles":{},"x":1}`,
		"bad name":       `{"profiles":{"Bad Name":{}}}`,
		"empty name":     `{"profiles":{"":{}}}`,
		"bad mode":       `{"profiles":{"a":{"mode":"yolo"}}}`,
		"deny is a word": `{"profiles":{"a":{"mode":"deny"}}}`,
		"notes too long": `{"profiles":{"a":{"notes":"` + strings.Repeat("x", maxProfileNotes+1) + `"}}}`,
		"model spaces":   `{"profiles":{"a":{"model":"a b"}}}`,
		"not json":       `nope`,
	}
	for name, body := range bad {
		if _, err := parseProfiles([]byte(body)); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestLoadProfilesLaysFileOverBuiltins(t *testing.T) {
	dir := t.TempDir()
	ps, err := loadProfiles(dir)
	if err != nil || ps["reviewer"].Mode != "plan" || ps["worker"].Notes == "" {
		t.Fatalf("built-ins: %v %+v", err, ps)
	}
	os.WriteFile(filepath.Join(dir, profilesFileName), []byte(`{"profiles":{"reviewer":{"mode":"ask","notes":"mine"},"extra":{}}}`), 0o600)
	ps, err = loadProfiles(dir)
	if err != nil || ps["reviewer"].Notes != "mine" || ps["reviewer"].Mode != "ask" || len(ps) != 4 {
		t.Fatalf("overlay: %v %+v", err, ps)
	}
	os.WriteFile(filepath.Join(dir, profilesFileName), []byte(`{"profiles":{"x":{"mode":"bogus"}}}`), 0o600)
	if _, err := loadProfiles(dir); err == nil {
		t.Fatal("an invalid file must be an error, not silently the built-ins")
	}
}

func TestClampWord(t *testing.T) {
	A, K, D := permrules.Allow, permrules.Ask, permrules.Deny
	cases := []struct {
		profile, spawner, want permrules.Action
		clamped                bool
	}{
		{"", A, A, false}, {"", K, K, false}, {"", D, D, false},
		{A, A, A, false}, {A, K, K, true}, {A, D, D, true},
		{K, A, K, false}, {K, K, K, false}, {K, D, D, true},
		{D, A, D, false}, {D, K, D, false}, {D, D, D, false},
	}
	for _, c := range cases {
		got, cl := clampWord(c.profile, c.spawner)
		if got != c.want || cl != c.clamped {
			t.Errorf("clampWord(%q,%q) = %q,%v want %q,%v", c.profile, c.spawner, got, cl, c.want, c.clamped)
		}
	}
}

func (r *coordRig) writeProfiles(body string) {
	r.t.Helper()
	if err := os.WriteFile(filepath.Join(r.stateDir, profilesFileName), []byte(body), 0o600); err != nil {
		r.t.Fatal(err)
	}
}

func resultOf(t *testing.T, out string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatalf("not JSON: %q", out)
	}
	return m
}

func TestSpawnWithReviewerProfile(t *testing.T) {
	r := newCoordRig(t, nil)
	allowCaller(t, r)
	mustGrant(t, r, "caller", []string{"session_read"})
	out, err := r.call("caller", "session_spawn", map[string]any{"title": "Check", "prompt": "check the parser", "profile": "reviewer"})
	if err != nil {
		t.Fatal(err)
	}
	res := resultOf(t, out)
	child := res["sessionId"].(string)
	if res["profile"] != "reviewer" || res["permissionMode"] != "deny" {
		t.Errorf("result = %v", res)
	}
	if got := r.cb.PermissionMode(child); got != permrules.Deny {
		t.Errorf("child word = %s, want deny (plan)", got)
	}
	if got := r.cb.Coordination(child); len(got) != 0 {
		t.Errorf("a stricter profile must not inherit the grant, got %v", got)
	}
	p := r.prompts()
	text := p[len(p)-1].prompt.Text
	if !strings.HasPrefix(text, "You are a reviewer") || !strings.HasSuffix(text, "check the parser") {
		t.Errorf("prompt = %q", text)
	}
}

func TestProfileNeverRaisesAboveSpawner(t *testing.T) {
	r := newCoordRig(t, nil) // the caller is on Ask
	r.writeProfiles(`{"profiles":{"loose":{"mode":"allow","notes":"n"}}}`)
	out, err := r.call("caller", "session_spawn", map[string]any{"title": "T", "prompt": "p", "profile": "loose"})
	if err != nil {
		t.Fatal(err)
	}
	res := resultOf(t, out)
	child := res["sessionId"].(string)
	if got := r.cb.PermissionMode(child); got != permrules.Ask {
		t.Errorf("child word = %s, want ask", got)
	}
	if res["profileModeClamped"] == nil {
		t.Errorf("the clamp must be reported: %v", res)
	}
	var card map[string]any
	for _, a := range r.asks() {
		if a.Tool == "session_spawn" {
			card = a.Metadata
		}
	}
	if card["profileModeClamped"] != true || card["permissionMode"] != "ask" {
		t.Errorf("card metadata = %v", card)
	}
}

func TestProfileStillGoesThroughTheCardAndCeiling(t *testing.T) {
	// The ceiling caps session_spawn at ask: even an Allow caller with a
	// profile gets the card.
	r := newCoordRig(t, withMax("session_spawn", "ask"))
	allowCaller(t, r)
	if _, err := r.call("caller", "session_spawn", map[string]any{"title": "T", "prompt": "p", "profile": "worker"}); err != nil {
		t.Fatal(err)
	}
	if a := r.asks(); len(a) != 1 || a[0].Tool != "session_spawn" {
		t.Fatalf("asks = %+v, want one session_spawn card", a)
	}
	// And a declined card spawns nothing.
	r2 := newCoordRig(t, nil)
	r2.cb.answer = func(backend.PermissionRequest) (backend.Decision, string) { return backend.DecisionReject, "no" }
	if _, err := r2.call("caller", "session_spawn", map[string]any{"title": "T", "prompt": "p", "profile": "worker"}); err == nil {
		t.Fatal("declined spawn must be refused")
	}
	if len(r2.cb.created) != 0 {
		t.Fatalf("declined spawn created %d session(s)", len(r2.cb.created))
	}
}

func TestPlanCallerCannotSpawnWithAnyProfile(t *testing.T) {
	r := newCoordRig(t, nil)
	_ = r.cb.SetPermissionMode(context.Background(), "", "caller", permrules.Deny)
	r.writeProfiles(`{"profiles":{"loose":{"mode":"allow"}}}`)
	if _, err := r.call("caller", "session_spawn", map[string]any{"title": "T", "prompt": "p", "profile": "loose"}); err == nil {
		t.Fatal("a Plan session must not spawn")
	}
}

func TestUnknownProfileIsRefusedWithTheList(t *testing.T) {
	r := newCoordRig(t, nil)
	_, err := r.call("caller", "session_spawn", map[string]any{"title": "T", "prompt": "p", "profile": "nope"})
	if err == nil || !strings.Contains(err.Error(), "reviewer") || len(r.cb.created) != 0 {
		t.Fatalf("err = %v, created = %d", err, len(r.cb.created))
	}
	r.writeProfiles(`{"profiles":{"x":{"mode":"bogus"}}}`)
	_, err = r.call("caller", "session_spawn", map[string]any{"title": "T", "prompt": "p", "profile": "worker"})
	if err == nil || !strings.Contains(err.Error(), "profiles cannot be used") {
		t.Fatalf("a broken profiles file must refuse a profile spawn: %v", err)
	}
	// With no profile named, spawning is unaffected by the file.
	if _, err := r.call("caller", "session_spawn", map[string]any{"title": "T", "prompt": "p"}); err != nil {
		t.Fatalf("plain spawn: %v", err)
	}
}

func TestProfileModel(t *testing.T) {
	r := newCoordRig(t, func(p *policy.Policy) { p.AllowFreeModels = true })
	r.cb.models = []backend.Model{{ID: "gw/fast"}}
	r.writeProfiles(`{"profiles":{"fast":{"model":"gw/fast"},"ghost":{"model":"gw/none"}}}`)
	if _, err := r.call("caller", "session_spawn", map[string]any{"title": "T", "prompt": "p", "profile": "fast"}); err != nil {
		t.Fatal(err)
	}
	if got := r.cb.created[0].ModelID; got != "gw/fast" {
		t.Errorf("child model = %q", got)
	}
	n := len(r.cb.created)
	if _, err := r.call("caller", "session_spawn", map[string]any{"title": "T", "prompt": "p", "profile": "ghost"}); err == nil || len(r.cb.created) != n {
		t.Fatalf("a model the workspace lacks must be refused before anything starts: %v", err)
	}
}

func TestSessionProfilesLists(t *testing.T) {
	r := newCoordRig(t, nil)
	r.writeProfiles(`{"profiles":{"zed":{"description":"last","mode":"ask"}}}`)
	out, err := r.call("caller", "session_profiles", map[string]any{"note": ""})
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]any
	if err := json.Unmarshal([]byte(out), &rows); err != nil || len(rows) != 4 {
		t.Fatalf("rows = %v %v", rows, err)
	}
	if rows[0]["name"] != "explorer" || rows[3]["name"] != "zed" || rows[3]["mode"] != "ask" {
		t.Errorf("rows = %v", rows)
	}
	if a := r.asks(); len(a) != 0 {
		t.Errorf("listing raised a card: %+v", a)
	}
}

func TestProfileModelObeysTheFreeModelGate(t *testing.T) {
	r := newCoordRig(t, nil) // free models are not allowed
	r.cb.models = []backend.Model{{ID: "gw/fast"}}
	r.writeProfiles(`{"profiles":{"fast":{"model":"gw/fast"}}}`)
	if _, err := r.call("caller", "session_spawn", map[string]any{"title": "T", "prompt": "p", "profile": "fast"}); err == nil || len(r.cb.created) != 0 {
		t.Fatalf("err = %v, created = %d", err, len(r.cb.created))
	}
}
