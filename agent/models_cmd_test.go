package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeModelsGateway serves GET /v1/models from a mutable list, plus a token
// endpoint, and counts the calls to each.
type fakeModelsGateway struct {
	*httptest.Server
	models   atomic.Value // []map[string]any
	status   atomic.Int32
	modelHit atomic.Int32
	tokenHit atomic.Int32
}

func newFakeModelsGateway(t *testing.T, ids ...string) *fakeModelsGateway {
	t.Helper()
	g := &fakeModelsGateway{}
	g.setModels(ids...)
	g.status.Store(http.StatusOK)
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		g.modelHit.Add(1)
		if s := int(g.status.Load()); s != http.StatusOK {
			http.Error(w, "nope", s)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": g.models.Load()})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		g.tokenHit.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "fresh", "refresh_token": "rotated", "expires_in": 3600, "token_type": "Bearer",
		})
	})
	g.Server = httptest.NewServer(mux)
	t.Cleanup(g.Close)
	return g
}

func (g *fakeModelsGateway) setModels(ids ...string) {
	list := []map[string]any{}
	for _, id := range ids {
		list = append(list, map[string]any{"id": id, "display_name": id, "context_window": 1000, "max_output_tokens": 100})
	}
	g.models.Store(list)
}

// refreshRig is a credential file and the opencode.json it records, in a temp
// dir, with extra keys the refresh must leave alone.
func refreshRig(t *testing.T, g *fakeModelsGateway, models string) (credsPath, configPath string) {
	t.Helper()
	dir := t.TempDir()
	credsPath = filepath.Join(dir, "credentials.json")
	configPath = filepath.Join(dir, "opencode.json")
	cfg := `{
  "$schema": "https://opencode.ai/config.json",
  "enabled_providers": ["pystino"],
  "model": "pystino/old",
  "permission": {"edit": "ask"},
  "provider": {"pystino": {
    "npm": "@ai-sdk/openai-compatible", "name": "Pystino Gateway",
    "options": {"baseURL": "http://127.0.0.1:41871/v1", "apiKey": "secret"},
    "models": ` + models + `}}
}`
	if err := os.WriteFile(configPath, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	writeCreds(t, credsPath, &credentials{
		Issuer: g.URL, TokenEndpoint: g.URL + "/token", ClientID: "c", Gateway: g.URL + "/v1",
		RefreshToken: "rt", AccessToken: "at", ExpiresIn: 3600, ObtainedAt: time.Now().Unix(),
		OpencodeConfig: configPath,
	})
	return credsPath, configPath
}

func readJSONFile(t *testing.T, path string) map[string]any {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func modelIDs(t *testing.T, path string) map[string]bool {
	t.Helper()
	cfg := readJSONFile(t, path)
	models := cfg["provider"].(map[string]any)["pystino"].(map[string]any)["models"].(map[string]any)
	ids := map[string]bool{}
	for id := range models {
		ids[id] = true
	}
	return ids
}

func cachedToken(context.Context) (string, error) { return "at", nil }

func TestRefreshModelsAddsRemovesAndKeepsOtherKeys(t *testing.T) {
	g := newFakeModelsGateway(t, "keep", "new")
	_, configPath := refreshRig(t, g, `{"keep": {"name": "keep", "limit": {"context": 1000, "output": 100}}, "old": {"name": "old", "limit": {"context": 1, "output": 1}}}`)
	creds, err := loadCredentials(filepath.Join(filepath.Dir(configPath), "credentials.json"))
	if err != nil {
		t.Fatal(err)
	}

	diff, err := refreshModels(context.Background(), creds, cachedToken)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(diff.Added, ",") != "new" || strings.Join(diff.Removed, ",") != "old" || diff.Unchanged != 1 {
		t.Fatalf("diff = %+v", diff)
	}
	ids := modelIDs(t, configPath)
	if len(ids) != 2 || !ids["keep"] || !ids["new"] {
		t.Fatalf("models = %v", ids)
	}
	cfg := readJSONFile(t, configPath)
	if cfg["model"] != "pystino/old" || cfg["$schema"] == nil || cfg["enabled_providers"] == nil || cfg["permission"].(map[string]any)["edit"] != "ask" {
		t.Fatalf("other keys not preserved: %v", cfg)
	}
	opts := cfg["provider"].(map[string]any)["pystino"].(map[string]any)["options"].(map[string]any)
	if opts["apiKey"] != "secret" || opts["baseURL"] != "http://127.0.0.1:41871/v1" {
		t.Fatalf("provider options not preserved: %v", opts)
	}
	if len(diff.Warnings) != 1 || !strings.Contains(diff.Warnings[0], "pystino/old") {
		t.Fatalf("want a warning that the default model is gone, got %v", diff.Warnings)
	}
	if info, _ := os.Stat(configPath); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode())
	}
}

func TestRefreshModelsReplacesPlaceholder(t *testing.T) {
	g := newFakeModelsGateway(t, "real")
	_, configPath := refreshRig(t, g, `{"REPLACE-WITH-MODEL-ID": {"name": "x", "limit": {"context": 1, "output": 1}}}`)
	creds, _ := loadCredentials(filepath.Join(filepath.Dir(configPath), "credentials.json"))
	diff, err := refreshModels(context.Background(), creds, cachedToken)
	if err != nil {
		t.Fatal(err)
	}
	if len(diff.Removed) != 0 || len(diff.Added) != 1 {
		t.Fatalf("diff = %+v", diff)
	}
	if ids := modelIDs(t, configPath); len(ids) != 1 || !ids["real"] {
		t.Fatalf("models = %v", ids)
	}
}

func TestRefreshModelsFailureLeavesFileUntouched(t *testing.T) {
	for name, setup := range map[string]func(g *fakeModelsGateway){
		"gateway error": func(g *fakeModelsGateway) { g.status.Store(http.StatusBadGateway) },
		"no models":     func(g *fakeModelsGateway) { g.setModels() },
		"embeddings only": func(g *fakeModelsGateway) {
			g.models.Store([]map[string]any{{"id": "emb", "kind": "embedding"}})
		},
	} {
		t.Run(name, func(t *testing.T) {
			g := newFakeModelsGateway(t, "x")
			credsPath, configPath := refreshRig(t, g, `{"old": {"name": "old", "limit": {"context": 1, "output": 1}}}`)
			before, _ := os.ReadFile(configPath)
			setup(g)
			creds, _ := loadCredentials(credsPath)
			if _, err := refreshModels(context.Background(), creds, cachedToken); err == nil {
				t.Fatal("want an error")
			}
			after, _ := os.ReadFile(configPath)
			if string(before) != string(after) {
				t.Fatalf("file changed:\n%s", after)
			}
		})
	}
}

// The command takes its token from the stored refresh credential and persists
// the rotated refresh token, through the shim's own refresh code.
func TestRunModelsRefreshUsesStoredCredential(t *testing.T) {
	g := newFakeModelsGateway(t, "new")
	credsPath, configPath := refreshRig(t, g, `{"old": {"name": "old", "limit": {"context": 1, "output": 1}}}`)
	// Expired access token: forces a refresh.
	creds, _ := loadCredentials(credsPath)
	creds.ObtainedAt = 1
	writeCreds(t, credsPath, creds)

	if err := runModels([]string{"refresh", "--creds", credsPath}); err != nil {
		t.Fatal(err)
	}
	if g.tokenHit.Load() != 1 {
		t.Fatalf("token endpoint hit %d times", g.tokenHit.Load())
	}
	if got := readCreds(t, credsPath); got.RefreshToken != "rotated" {
		t.Fatalf("rotated refresh token not persisted: %q", got.RefreshToken)
	}
	if ids := modelIDs(t, configPath); len(ids) != 1 || !ids["new"] {
		t.Fatalf("models = %v", ids)
	}
}

func TestRunModelsRefreshExitsNonZeroOnFailure(t *testing.T) {
	g := newFakeModelsGateway(t)
	credsPath, _ := refreshRig(t, g, `{"old": {"name": "old", "limit": {"context": 1, "output": 1}}}`)
	if err := runModels([]string{"refresh", "--creds", credsPath}); err == nil {
		t.Fatal("want an error when discovery lists nothing")
	}
}

// run's start-up refresh warns and carries on: it returns, never panics, and
// leaves the file as it was.
func TestRefreshModelsAtStartIsNonFatal(t *testing.T) {
	g := newFakeModelsGateway(t, "x")
	credsPath, configPath := refreshRig(t, g, `{"old": {"name": "old", "limit": {"context": 1, "output": 1}}}`)
	before, _ := os.ReadFile(configPath)
	g.status.Store(http.StatusInternalServerError)
	creds, _ := loadCredentials(credsPath)
	refreshModelsAtStart(context.Background(), creds, cachedToken)
	// A token failure is just as harmless.
	refreshModelsAtStart(context.Background(), creds, func(context.Context) (string, error) {
		return "", context.DeadlineExceeded
	})
	after, _ := os.ReadFile(configPath)
	if string(before) != string(after) {
		t.Fatal("file changed on a failed refresh")
	}
}

func TestRefreshModelsAtStartRefreshes(t *testing.T) {
	g := newFakeModelsGateway(t, "x", "y")
	credsPath, configPath := refreshRig(t, g, `{"x": {"name": "x", "limit": {"context": 1000, "output": 100}}}`)
	creds, _ := loadCredentials(credsPath)
	refreshModelsAtStart(context.Background(), creds, cachedToken)
	if ids := modelIDs(t, configPath); len(ids) != 2 || !ids["y"] {
		t.Fatalf("models = %v", ids)
	}
}

func TestEnrollDefaultsComeFromExistingCredentials(t *testing.T) {
	dir := t.TempDir()
	creds := filepath.Join(dir, "credentials.json")
	// Revoked: tokens cleared, which loadCredentials would refuse. Re-enroll
	// must still read the recorded settings.
	writeCreds(t, creds, &credentials{
		Issuer: "https://idp", Gateway: "https://gw/v1", Group: "team", ClientID: "my-client",
		CereaOrigin: "https://cerea", ShimPort: 41900, OpencodeConfig: "/x/opencode.json",
	})
	opts := &enrollOptions{creds: creds, clientID: "opencode-enrollment", shimPort: defaultShimPort, gateway: "https://explicit"}
	if !applyRecordedDefaults(opts, map[string]bool{"gateway": true}) {
		t.Fatal("recorded file not found")
	}
	if opts.issuer != "https://idp" || opts.cerea != "https://cerea" || opts.clientID != "my-client" ||
		opts.shimPort != 41900 || opts.output != "/x/opencode.json" || opts.group != "team" || !opts.groupRecorded {
		t.Fatalf("defaults not applied: %+v", opts)
	}
	if opts.gateway != "https://explicit" {
		t.Fatalf("explicit flag lost: %q", opts.gateway)
	}

	// An explicit flag naming the default value still wins.
	opts = &enrollOptions{creds: creds, clientID: "opencode-enrollment", shimPort: defaultShimPort}
	applyRecordedDefaults(opts, map[string]bool{"client-id": true, "group": true})
	if opts.clientID != "opencode-enrollment" || opts.groupRecorded {
		t.Fatalf("flags not respected: %+v", opts)
	}

	if applyRecordedDefaults(&enrollOptions{creds: filepath.Join(dir, "none.json")}, nil) {
		t.Fatal("a missing file is not a re-enroll")
	}
}

// A recorded group that is no longer billable falls back to the prompt (here
// the gateway offers exactly one, taken silently); an explicit one still fails.
func TestPickGroupStaleRecordedGroupFallsBack(t *testing.T) {
	srv := fakeEnrollServer(t)
	got, err := pickGroup(context.Background(), srv.URL+"/v1", "at", "gone", true)
	if err != nil || got != "team" {
		t.Fatalf("recorded stale group: %q, %v", got, err)
	}
	if _, err := pickGroup(context.Background(), srv.URL+"/v1", "at", "gone", false); err == nil {
		t.Fatal("explicit stale group must fail")
	}
}
