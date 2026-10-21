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

func TestParseProfilesNewShape(t *testing.T) {
	ps, err := parseProfiles([]byte(`{"default":"deep","profiles":{"fast":{"model":"p/fast"},"deep":{"model":"p/deep"}}}`))
	if err != nil || len(ps.Profiles) != 2 || ps.Default == nil || *ps.Default != "deep" || ps.Profiles["fast"].Model != "p/fast" {
		t.Fatalf("new shape: %v %+v", err, ps)
	}
	ps, err = parseProfiles([]byte(`{"default":null,"profiles":{}}`))
	if err != nil || ps.Default != nil || len(ps.Profiles) != 0 {
		t.Fatalf("empty: %v %+v", err, ps)
	}
}

func TestParseProfilesMigratesTheOldShape(t *testing.T) {
	old := `{"profiles":{
		"careful":{"model":"p/m","mode":"ask","notes":"be careful","description":"d"},
		"ro":{"mode":"plan"},
		"worker":{"notes":"just notes"},
		"Bad Name":{"model":"p/x"},
		"blank":{"model":"  "}}}`
	ps, err := parseProfiles([]byte(old))
	if err != nil {
		t.Fatal(err)
	}
	if len(ps.Profiles) != 1 || ps.Profiles["careful"].Model != "p/m" {
		t.Fatalf("only entries with a model survive: %+v", ps.Profiles)
	}
	if ps.Default != nil {
		t.Errorf("the old shape has no default: %v", *ps.Default)
	}
	// A default that names nothing is no default.
	ps, _ = parseProfiles([]byte(`{"default":"ghost","profiles":{"a":{"model":"p/m"}}}`))
	if ps.Default != nil {
		t.Errorf("a dangling default must be dropped")
	}
	if _, err := parseProfiles([]byte(`nope`)); err == nil {
		t.Error("not JSON must be an error")
	}
	// Built-in names are not special: the old built-ins are gone.
	dir := t.TempDir()
	ps, err = loadProfiles(dir)
	if err != nil || len(ps.Profiles) != 0 || ps.Default != nil {
		t.Fatalf("no file means no profiles: %v %+v", err, ps)
	}
}

func TestParseProfilesBoundsTheCount(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"profiles":{`)
	for i := 0; i < maxProfileCount+5; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`"p` + string(rune('a'+i/26)) + string(rune('a'+i%26)) + `":{"model":"m"}`)
	}
	b.WriteString(`}}`)
	ps, err := parseProfiles([]byte(b.String()))
	if err != nil || len(ps.Profiles) != maxProfileCount {
		t.Fatalf("n = %d err = %v", len(ps.Profiles), err)
	}
}

func TestValidateProfileSet(t *testing.T) {
	offered := map[string]bool{"p/m": true}
	str := func(s string) *string { return &s }
	if err := validateProfileSet(profileSet{Default: str("a"), Profiles: map[string]delegateProfile{"a": {Model: "p/m"}}}, offered); err != nil {
		t.Fatalf("valid: %v", err)
	}
	if err := validateProfileSet(profileSet{Profiles: map[string]delegateProfile{}}, offered); err != nil {
		t.Fatalf("empty is valid: %v", err)
	}
	many := map[string]delegateProfile{}
	for i := 0; i <= maxProfileCount; i++ {
		many["p"+strings.Repeat("x", i%20)+string(rune('a'+i%26))+string(rune('a'+i/26))] = delegateProfile{Model: "p/m"}
	}
	bad := map[string]profileSet{
		"bad name":      {Profiles: map[string]delegateProfile{"Bad Name": {Model: "p/m"}}},
		"empty name":    {Profiles: map[string]delegateProfile{"": {Model: "p/m"}}},
		"no model":      {Profiles: map[string]delegateProfile{"a": {}}},
		"not offered":   {Profiles: map[string]delegateProfile{"a": {Model: "p/other"}}},
		"dangling":      {Default: str("b"), Profiles: map[string]delegateProfile{"a": {Model: "p/m"}}},
		"default empty": {Default: str(""), Profiles: map[string]delegateProfile{"a": {Model: "p/m"}}},
		"too many":      {Profiles: many},
	}
	for name, s := range bad {
		if err := validateProfileSet(s, offered); err == nil {
			t.Errorf("%s: accepted", name)
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

func (r *coordRig) offer(models ...string) {
	r.t.Helper()
	r.cb.models = nil
	for _, m := range models {
		r.cb.models = append(r.cb.models, backend.Model{ID: m, ProviderID: policy.GatewayProviderID})
	}
}

func (r *coordRig) handle(op, args string) (map[string]any, error) {
	r.t.Helper()
	res, operr := r.mc.Handle(context.Background(), op, json.RawMessage(args))
	if operr != nil {
		return nil, operr
	}
	body, _ := json.Marshal(res)
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		r.t.Fatal(err)
	}
	return m, nil
}

func TestProfilesSetListAndPersist(t *testing.T) {
	r := newCoordRig(t, nil)
	r.offer("pystino/fast", "pystino/deep")
	got, err := r.handle("profiles.list", `{}`)
	if err != nil || got["default"] != nil || len(got["profiles"].(map[string]any)) != 0 {
		t.Fatalf("initial list: %v %v", got, err)
	}
	set := `{"default":"deep","profiles":{"fast":{"model":"pystino/fast"},"deep":{"model":"pystino/deep"}}}`
	got, err = r.handle("profiles.set", set)
	if err != nil || got["default"] != "deep" {
		t.Fatalf("set: %v %v", got, err)
	}
	body, rerr := os.ReadFile(filepath.Join(r.stateDir, profilesFileName))
	if rerr != nil {
		t.Fatal(rerr)
	}
	ps, perr := parseProfiles(body)
	if perr != nil || len(ps.Profiles) != 2 || *ps.Default != "deep" {
		t.Fatalf("file: %s %v", body, perr)
	}
	if fi, _ := os.Stat(filepath.Join(r.stateDir, profilesFileName)); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v", fi.Mode().Perm())
	}
	entries, _ := os.ReadDir(r.stateDir)
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp") {
			t.Errorf("temp file left behind: %s", e.Name())
		}
	}
	got, err = r.handle("profiles.list", `{}`)
	if err != nil || got["default"] != "deep" || got["profiles"].(map[string]any)["fast"].(map[string]any)["model"] != "pystino/fast" {
		t.Fatalf("list after set: %v %v", got, err)
	}
	// Replace, not merge; clearing the default.
	got, err = r.handle("profiles.set", `{"default":null,"profiles":{"fast":{"model":"pystino/fast"}}}`)
	if err != nil || got["default"] != nil || len(got["profiles"].(map[string]any)) != 1 {
		t.Fatalf("replace: %v %v", got, err)
	}
	// And the empty set removes everything.
	if _, err := r.handle("profiles.set", `{"default":null,"profiles":{}}`); err != nil {
		t.Fatal(err)
	}
}

func TestProfilesSetRefuses(t *testing.T) {
	r := newCoordRig(t, nil)
	r.offer("pystino/fast")
	bad := map[string]string{
		"model not offered": `{"default":null,"profiles":{"a":{"model":"pystino/ghost"}}}`,
		"no model":          `{"default":null,"profiles":{"a":{}}}`,
		"bad name":          `{"default":null,"profiles":{"A b":{"model":"pystino/fast"}}}`,
		"dangling default":  `{"default":"z","profiles":{"a":{"model":"pystino/fast"}}}`,
		"unknown field":     `{"default":null,"profiles":{"a":{"model":"pystino/fast","mode":"plan"}}}`,
		"no profiles":       `{"default":null}`,
		"extra top":         `{"default":null,"profiles":{},"x":1}`,
		"not json":          `[`,
	}
	for name, args := range bad {
		_, err := r.handle("profiles.set", args)
		if err == nil || !strings.Contains(err.Error(), "") {
			t.Errorf("%s: accepted", name)
			continue
		}
		if oe, ok := err.(interface{ Error() string }); !ok || oe == nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(r.stateDir, profilesFileName)); !os.IsNotExist(err) {
		t.Errorf("a refused set must write nothing: %v", err)
	}
}

func TestProfilesSetModelMustBeOneTheMachineOffers(t *testing.T) {
	// Free models off: a non-gateway model is not offered, so it is refused
	// even though the backend lists it.
	r := newCoordRig(t, nil)
	r.cb.models = []backend.Model{{ID: "free/model", ProviderID: "other"}}
	if _, err := r.handle("profiles.set", `{"default":null,"profiles":{"a":{"model":"free/model"}}}`); err == nil {
		t.Fatal("a model the machine hides must be refused")
	}
	r2 := newCoordRig(t, func(p *policy.Policy) { p.AllowFreeModels = true })
	r2.cb.models = []backend.Model{{ID: "free/model", ProviderID: "other"}}
	if _, err := r2.handle("profiles.set", `{"default":null,"profiles":{"a":{"model":"free/model"}}}`); err != nil {
		t.Fatalf("offered with free models on: %v", err)
	}
}

func TestProfilesOpsUnsupportedWithoutAgentTools(t *testing.T) {
	r := newCoordRig(t, nil)
	r.mc.agentTools = nil
	for _, op := range []string{"profiles.list", "profiles.set"} {
		_, operr := r.mc.Handle(context.Background(), op, json.RawMessage(`{"profiles":{}}`))
		if operr == nil || operr.Code != "unsupported" {
			t.Errorf("%s: %+v", op, operr)
		}
	}
}

func TestProfilesListReportsAnUnparseableFile(t *testing.T) {
	r := newCoordRig(t, nil)
	r.writeProfiles(`nope`)
	if _, err := r.handle("profiles.list", `{}`); err == nil {
		t.Fatal("a broken file must be reported, not shown as empty")
	}
}

func TestHelloAdvertisesDelegateProfiles(t *testing.T) {
	on := buildHello(allCapsBackend{}, policy.Default()).Machine.Capabilities
	if !on["delegateProfiles"] {
		t.Errorf("machine capabilities = %v", on)
	}
	pol := policy.Default()
	pol.AgentTools = policy.TerminalDenied
	off := buildHello(allCapsBackend{}, pol).Machine.Capabilities
	if off["delegateProfiles"] {
		t.Errorf("agent tools off must hide profiles: %v", off)
	}
}

func spawnArgs(extra map[string]any) map[string]any {
	m := map[string]any{"title": "T", "prompt": "p"}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func TestSpawnWithoutProfileUsesTheDefaultsModel(t *testing.T) {
	r := newCoordRig(t, nil)
	r.offer("pystino/fast", "pystino/deep")
	r.writeProfiles(`{"default":"deep","profiles":{"fast":{"model":"pystino/fast"},"deep":{"model":"pystino/deep"}}}`)
	out, err := r.call("caller", "session_spawn", spawnArgs(nil))
	if err != nil {
		t.Fatal(err)
	}
	res := resultOf(t, out)
	if r.cb.created[0].ModelID != "pystino/deep" || res["profile"] != "deep" || res["model"] != "pystino/deep" {
		t.Errorf("created = %+v res = %v", r.cb.created[0], res)
	}
	// The card names the profile (and so its model).
	var card map[string]any
	for _, a := range r.asks() {
		if a.Tool == "session_spawn" {
			card = a.Metadata
		}
	}
	if card["profile"] != "deep" || card["modelId"] != "pystino/deep" {
		t.Errorf("card = %v", card)
	}
	// A named profile beats the default; "" is the default.
	if _, err := r.call("caller", "session_spawn", spawnArgs(map[string]any{"profile": "fast"})); err != nil {
		t.Fatal(err)
	}
	if got := r.cb.created[1].ModelID; got != "pystino/fast" {
		t.Errorf("named profile model = %q", got)
	}
	if _, err := r.call("caller", "session_spawn", spawnArgs(map[string]any{"profile": ""})); err != nil {
		t.Fatal(err)
	}
	if got := r.cb.created[2].ModelID; got != "pystino/deep" {
		t.Errorf("empty profile model = %q", got)
	}
}

func TestSpawnWithoutDefaultUsesTheSpawnersModel(t *testing.T) {
	r := newCoordRig(t, nil)
	r.offer("pystino/fast")
	// Profiles but no default, and then no profiles at all.
	for _, body := range []string{`{"default":null,"profiles":{"fast":{"model":"pystino/fast"}}}`, ""} {
		if body != "" {
			r.writeProfiles(body)
		}
		before := len(r.cb.created)
		out, err := r.call("caller", "session_spawn", spawnArgs(nil))
		if err != nil {
			t.Fatal(err)
		}
		res := resultOf(t, out)
		if res["profile"] != nil || res["model"] != nil {
			t.Errorf("no profile expected: %v", res)
		}
		if got := r.cb.created[before].ModelID; got != r.cb.sessions["caller"].ModelID {
			t.Errorf("child model = %q, want the spawner's %q", got, r.cb.sessions["caller"].ModelID)
		}
	}
}

func TestSpawnDefaultModelNotInWorkspaceIsRefused(t *testing.T) {
	r := newCoordRig(t, nil)
	r.offer("pystino/other")
	r.writeProfiles(`{"default":"ghost","profiles":{"ghost":{"model":"pystino/gone"}}}`)
	before := len(r.cb.created)
	if _, err := r.call("caller", "session_spawn", spawnArgs(nil)); err == nil || len(r.cb.created) != before {
		t.Fatalf("a default whose model the workspace lacks must refuse before anything starts: %v", err)
	}
}

func TestModeIsNotAProfileAnymore(t *testing.T) {
	// An old file's mode and notes are ignored; the delegate runs with its
	// spawner's word and the prompt is the brief as written.
	r := newCoordRig(t, nil)
	r.offer("pystino/fast")
	r.writeProfiles(`{"profiles":{"fast":{"model":"pystino/fast","mode":"plan","notes":"NOTES"}}}`)
	out, err := r.call("caller", "session_spawn", spawnArgs(map[string]any{"profile": "fast"}))
	if err != nil {
		t.Fatal(err)
	}
	res := resultOf(t, out)
	child := res["sessionId"].(string)
	if res["permissionMode"] != "ask" || r.cb.PermissionMode(child) != permrules.Ask {
		t.Errorf("word = %v / %s", res["permissionMode"], r.cb.PermissionMode(child))
	}
	p := r.prompts()
	if text := p[len(p)-1].prompt.Text; text != "p" {
		t.Errorf("prompt = %q", text)
	}
}

func TestProfileNeverRaisesPermissionAboveSpawner(t *testing.T) {
	r := newCoordRig(t, nil) // the caller is on Ask
	r.offer("pystino/fast")
	r.writeProfiles(`{"default":"fast","profiles":{"fast":{"model":"pystino/fast"}}}`)
	out, err := r.call("caller", "session_spawn", spawnArgs(nil))
	if err != nil {
		t.Fatal(err)
	}
	child := resultOf(t, out)["sessionId"].(string)
	if got := r.cb.PermissionMode(child); got != permrules.Ask {
		t.Errorf("child word = %s, want ask", got)
	}
}

func TestProfileStillGoesThroughTheCardAndCeiling(t *testing.T) {
	r := newCoordRig(t, withMax("session_spawn", "ask"))
	r.offer("pystino/fast")
	r.writeProfiles(`{"default":"fast","profiles":{"fast":{"model":"pystino/fast"}}}`)
	allowCaller(t, r)
	if _, err := r.call("caller", "session_spawn", spawnArgs(nil)); err != nil {
		t.Fatal(err)
	}
	if a := r.asks(); len(a) != 1 || a[0].Tool != "session_spawn" {
		t.Fatalf("asks = %+v, want one session_spawn card", a)
	}
	r2 := newCoordRig(t, nil)
	r2.offer("pystino/fast")
	r2.writeProfiles(`{"default":"fast","profiles":{"fast":{"model":"pystino/fast"}}}`)
	r2.cb.answer = func(backend.PermissionRequest) (backend.Decision, string) { return backend.DecisionReject, "no" }
	if _, err := r2.call("caller", "session_spawn", spawnArgs(nil)); err == nil {
		t.Fatal("declined spawn must be refused")
	}
	if len(r2.cb.created) != 0 {
		t.Fatalf("declined spawn created %d session(s)", len(r2.cb.created))
	}
}

func TestPlanCallerCannotSpawnWithAnyProfile(t *testing.T) {
	r := newCoordRig(t, nil)
	r.offer("pystino/fast")
	_ = r.cb.SetPermissionMode(context.Background(), "", "caller", permrules.Deny)
	r.writeProfiles(`{"default":"fast","profiles":{"fast":{"model":"pystino/fast"}}}`)
	if _, err := r.call("caller", "session_spawn", spawnArgs(nil)); err == nil {
		t.Fatal("a Plan session must not spawn")
	}
}

func TestSpawnPlanModeIsTheReadOnlyOption(t *testing.T) {
	r := newCoordRig(t, nil)
	r.cb.modes = []backend.Mode{{ID: "plan"}, {ID: "build"}}
	out, err := r.call("caller", "session_spawn", spawnArgs(map[string]any{"mode": "plan"}))
	if err != nil {
		t.Fatal(err)
	}
	if res := resultOf(t, out); res["mode"] != "plan" {
		t.Errorf("res = %v", res)
	}
}

func TestUnknownProfileIsRefusedWithTheList(t *testing.T) {
	r := newCoordRig(t, nil)
	_, err := r.call("caller", "session_spawn", spawnArgs(map[string]any{"profile": "nope"}))
	if err == nil || !strings.Contains(err.Error(), "no profiles") || len(r.cb.created) != 0 {
		t.Fatalf("err = %v, created = %d", err, len(r.cb.created))
	}
	r.offer("pystino/fast")
	r.writeProfiles(`{"profiles":{"fast":{"model":"pystino/fast"}}}`)
	_, err = r.call("caller", "session_spawn", spawnArgs(map[string]any{"profile": "nope"}))
	if err == nil || !strings.Contains(err.Error(), "fast") || len(r.cb.created) != 0 {
		t.Fatalf("err = %v, created = %d", err, len(r.cb.created))
	}
	// The built-in names are gone.
	for _, n := range []string{"worker", "reviewer", "explorer"} {
		if _, err := r.call("caller", "session_spawn", spawnArgs(map[string]any{"profile": n})); err == nil {
			t.Errorf("built-in %q must not exist", n)
		}
	}
	r.writeProfiles(`nope`)
	_, err = r.call("caller", "session_spawn", spawnArgs(map[string]any{"profile": "fast"}))
	if err == nil || !strings.Contains(err.Error(), "profiles cannot be used") {
		t.Fatalf("a broken profiles file must refuse: %v", err)
	}
}

func TestProfileModelObeysTheFreeModelGate(t *testing.T) {
	r := newCoordRig(t, nil) // free models are not allowed
	r.cb.models = []backend.Model{{ID: "free/fast"}}
	r.writeProfiles(`{"default":"fast","profiles":{"fast":{"model":"free/fast"}}}`)
	if _, err := r.call("caller", "session_spawn", spawnArgs(nil)); err == nil || len(r.cb.created) != 0 {
		t.Fatalf("err = %v, created = %d", err, len(r.cb.created))
	}
}

func TestSessionProfilesLists(t *testing.T) {
	r := newCoordRig(t, nil)
	r.writeProfiles(`{"default":"b","profiles":{"b":{"model":"m/b"},"a":{"model":"m/a"}}}`)
	out, err := r.call("caller", "session_profiles", map[string]any{"note": ""})
	if err != nil {
		t.Fatal(err)
	}
	res := resultOf(t, out)
	if res["default"] != "b" || res["profiles"].(map[string]any)["a"].(map[string]any)["model"] != "m/a" {
		t.Errorf("res = %v", res)
	}
	if a := r.asks(); len(a) != 0 {
		t.Errorf("listing raised a card: %+v", a)
	}
}
