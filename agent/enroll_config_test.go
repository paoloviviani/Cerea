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
)

// lastModelsBillTo records the x-bill-to the most recent /v1/models fetch
// carried (A): the tests here run sequentially, so one slot is enough.
var lastModelsBillTo atomic.Value

// fakeEnrollServer is an IdP (discovery, device flow, token) and a gateway
// (billing groups) in one: just enough for enroll to run to the end offline.
func fakeEnrollServer(t *testing.T) *httptest.Server {
	return fakeEnrollServerWithDefault(t, true)
}

// fakeEnrollServerWithDefault stages whether the user's console default
// billing group is set: with none, --default-group must refuse.
func fakeEnrollServerWithDefault(t *testing.T, hasDefault bool) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	var srv *httptest.Server
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"token_endpoint":                srv.URL + "/token",
			"device_authorization_endpoint": srv.URL + "/device",
		})
	})
	mux.HandleFunc("/device", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"device_code": "dc", "user_code": "UC", "verification_uri": srv.URL + "/verify", "interval": 1,
		})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at", "refresh_token": "rt", "expires_in": 3600, "token_type": "Bearer",
		})
	})
	mux.HandleFunc("/v1/billing/groups", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"id": "g1", "name": "team", "is_default": hasDefault}}})
	})
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		lastModelsBillTo.Store(r.Header.Get("x-bill-to"))
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"id": "gw-model", "display_name": "Gateway Model", "context_window": 100000, "max_output_tokens": 8000}}})
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func enrollInto(t *testing.T, srv *httptest.Server, creds, output string) *credentials {
	t.Helper()
	return enrollIntoDiscover(t, srv, creds, output, false)
}

func enrollIntoDiscover(t *testing.T, srv *httptest.Server, creds, output string, discover bool) *credentials {
	t.Helper()
	opts := &enrollOptions{
		discover: discover,
		issuer:   srv.URL, gateway: srv.URL, clientID: "opencode-enrollment",
		device: true, group: "team", output: output, creds: creds,
		shimPort: defaultShimPort, yes: true, maxTerminals: 8,
	}
	if err := enroll(context.Background(), opts); err != nil {
		t.Fatalf("enroll: %v", err)
	}
	got, err := loadCredentials(creds)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestEnrollDefaultOutputIsBesideTheCredentialsAndRecorded(t *testing.T) {
	srv := fakeEnrollServer(t)
	root := t.TempDir()
	elsewhere := t.TempDir()
	t.Chdir(elsewhere) // the person's cwd: the old default wrote ./opencode.json here
	creds := filepath.Join(root, "galopin", "credentials.json")

	got := enrollInto(t, srv, creds, "")

	want := filepath.Join(root, "galopin", "opencode.json")
	if got.OpencodeConfig != want {
		t.Fatalf("recorded opencode_config = %q, want %q", got.OpencodeConfig, want)
	}
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("opencode.json not at the galopin dir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(elsewhere, "opencode.json")); err == nil {
		t.Fatal("enroll still wrote ./opencode.json into the cwd")
	}
	// run, with no flag, resolves to it.
	if path, warn := resolveOpencodeConfig("", got); path != want || warn != "" {
		t.Fatalf("run resolves %q (warning %q), want %q silently", path, warn, want)
	}
}

func TestEnrollExplicitRelativeOutputIsRecordedAbsolute(t *testing.T) {
	srv := fakeEnrollServer(t)
	root := t.TempDir()
	t.Chdir(root)
	creds := filepath.Join(root, "state", "credentials.json")

	got := enrollInto(t, srv, creds, "rel/own.json")

	want := filepath.Join(root, "rel", "own.json")
	if got.OpencodeConfig != want {
		t.Fatalf("recorded opencode_config = %q, want %q", got.OpencodeConfig, want)
	}
	if info, err := os.Stat(want); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("explicit output missing or not 0600: %v %v", info, err)
	}
	// A re-enroll to the default replaces the recorded path.
	again := enrollInto(t, srv, creds, "")
	if again.OpencodeConfig != filepath.Join(root, "state", "opencode.json") {
		t.Fatalf("re-enroll recorded %q", again.OpencodeConfig)
	}
}

func TestResolveOpencodeConfigOrder(t *testing.T) {
	dir := t.TempDir()
	recorded := filepath.Join(dir, "opencode.json")
	if err := os.WriteFile(recorded, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}

	// 1. The flag always wins, even over a recorded, existing file.
	path, warn := resolveOpencodeConfig("/flag/path.json", &credentials{OpencodeConfig: recorded})
	if path != "/flag/path.json" || warn != "" {
		t.Errorf("flag: got %q, %q", path, warn)
	}
	// ...and a flag silences the warning for a pre-fix machine.
	if path, warn = resolveOpencodeConfig("/flag/path.json", &credentials{}); path != "/flag/path.json" || warn != "" {
		t.Errorf("flag on an old machine: got %q, %q", path, warn)
	}
	// 2. Then the recorded path.
	if path, warn = resolveOpencodeConfig("", &credentials{OpencodeConfig: recorded}); path != recorded || warn != "" {
		t.Errorf("recorded: got %q, %q", path, warn)
	}
	// 3. Else today's behaviour, with one warning that names the problem and both fixes.
	path, warn = resolveOpencodeConfig("", &credentials{})
	if path != "" {
		t.Errorf("old machine: path = %q, want empty (opencode's own discovery)", path)
	}
	for _, need := range []string{"enrolled before", "no pystino provider", "galopin enroll", "--opencode-config"} {
		if !strings.Contains(warn, need) {
			t.Errorf("warning %q lacks %q", warn, need)
		}
	}
	// A recorded file that has since gone is the same fallback, naming the file.
	gone := filepath.Join(dir, "gone.json")
	path, warn = resolveOpencodeConfig("", &credentials{OpencodeConfig: gone})
	if path != "" || !strings.Contains(warn, gone) || !strings.Contains(warn, "--opencode-config") {
		t.Errorf("missing recorded file: got %q, %q", path, warn)
	}
}

func TestCredentialsWithoutOpencodeConfigStillLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	old := `{"issuer":"https://idp","token_endpoint":"https://idp/token","client_id":"c","gateway":"https://gw/v1","group":"g","refresh_token":"rt","access_token":"at","expires_in":3600,"obtained_at_unix":1}`
	if err := os.WriteFile(path, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	creds, err := loadCredentials(path)
	if err != nil {
		t.Fatalf("a file written before the field must load: %v", err)
	}
	if creds.OpencodeConfig != "" {
		t.Errorf("OpencodeConfig = %q, want empty", creds.OpencodeConfig)
	}
	// And saving it back does not invent the field.
	if err := saveCredentials(path, creds); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(path)
	if strings.Contains(string(body), "opencode_config") {
		t.Errorf("empty field serialised: %s", body)
	}
}

// --default-group enrolls the machine to bill wherever the person's console
// default points: the mode is recorded, no group is pinned, and the model
// discovery sends no x-bill-to, so the list follows the default exactly as
// billing will (A).
func TestEnrollDefaultGroupRecordsTheModeAndSendsNoHeader(t *testing.T) {
	srv := fakeEnrollServer(t)
	root := t.TempDir()
	creds := filepath.Join(root, "credentials.json")
	output := filepath.Join(root, "opencode.json")
	opts := &enrollOptions{
		discover: true, issuer: srv.URL, gateway: srv.URL, clientID: "opencode-enrollment",
		device: true, output: output, creds: creds,
		shimPort: defaultShimPort, yes: true, maxTerminals: 8,
		defaultGroup: true,
	}
	if err := enroll(context.Background(), opts); err != nil {
		t.Fatalf("enroll --default-group: %v", err)
	}
	got, err := loadCredentials(creds)
	if err != nil {
		t.Fatal(err)
	}
	if !got.BillToDefault || got.Group != "" {
		t.Fatalf("bill_to_default = %v, group = %q; want true and empty", got.BillToDefault, got.Group)
	}
	if saw, _ := lastModelsBillTo.Load().(string); saw != "" {
		t.Errorf("model discovery billed to %q; following-default must send no header", saw)
	}
}

// Both ways of naming the billing at once is a contradiction: refuse before
// anything is signed in or written.
func TestEnrollRefusesGroupAndDefaultGroupTogether(t *testing.T) {
	dir := t.TempDir()
	err := runEnroll([]string{
		"--group", "team", "--default-group",
		"--issuer", "https://idp.example", "--gateway", "https://gw.example/v1",
		"--creds", filepath.Join(dir, "credentials.json"), "--yes",
	})
	if err == nil || !strings.Contains(err.Error(), "--default-group") || !strings.Contains(err.Error(), "--group") {
		t.Fatalf("both flags: err = %v, want a refusal naming both", err)
	}
}

// Following the default with no default set would 403 every request ("No
// billing group is set for this key or user"), so enroll refuses up front
// and says where to set one.
func TestEnrollDefaultGroupRefusesWithoutADefault(t *testing.T) {
	srv := fakeEnrollServerWithDefault(t, false)
	dir := t.TempDir()
	opts := &enrollOptions{
		discover: false, issuer: srv.URL, gateway: srv.URL, clientID: "opencode-enrollment",
		device: true, output: filepath.Join(dir, "opencode.json"), creds: filepath.Join(dir, "credentials.json"),
		shimPort: defaultShimPort, yes: true, maxTerminals: 8,
		defaultGroup: true,
	}
	err := enroll(context.Background(), opts)
	if err == nil || !strings.Contains(err.Error(), "default") {
		t.Fatalf("no console default: err = %v, want a refusal naming the default", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "credentials.json")); !os.IsNotExist(statErr) {
		t.Errorf("credentials written despite the refusal: %v", statErr)
	}
}

// Re-enrolling carries the mode over just as it carries the group, and an
// explicit --group switches the machine back to pinned.
func TestReEnrollCarriesTheBillingModeOver(t *testing.T) {
	rec := &credentials{Group: "", BillToDefault: true}
	path := filepath.Join(t.TempDir(), "credentials.json")
	if err := saveCredentials(path, rec); err != nil {
		t.Fatal(err)
	}
	opts := &enrollOptions{creds: path}
	if !applyRecordedDefaults(opts, map[string]bool{}) {
		t.Fatal("the recorded file was not found")
	}
	if !opts.defaultGroup || opts.group != "" {
		t.Fatalf("recorded follow-default: defaultGroup = %v, group = %q", opts.defaultGroup, opts.group)
	}

	// An explicit --group pins again, overriding the recorded mode.
	opts = &enrollOptions{creds: path, group: "team"}
	applyRecordedDefaults(opts, map[string]bool{"group": true})
	if err := reconcileBillingMode(opts, map[string]bool{"group": true}); err != nil {
		t.Fatal(err)
	}
	if opts.defaultGroup {
		t.Fatal("an explicit --group must switch the machine back to pinned")
	}
	if opts.group != "team" {
		t.Fatalf("group = %q, want the explicit team", opts.group)
	}
}
