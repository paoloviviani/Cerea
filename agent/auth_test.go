package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// fakeAuthIssuer is an IdP (discovery, device flow, token) and a gateway
// (billing groups) in one, with knobs: the token response, the billable
// group list and the groups status, so a test can stage "the group is gone"
// without a second server. Just enough for auth login to run offline.
type fakeAuthIssuer struct {
	*httptest.Server
	tokenHits atomic.Int32
	groupHits atomic.Int32
	modelHits atomic.Int32
	// sawModelBillTo records the x-bill-to the /models fetch carried (A):
	// a settable knob, because the gateway filters the listing by group.
	sawModelBillTo atomic.Value // string
	access         atomic.Value // string
	refresh        atomic.Value // string
	billable       atomic.Value // []string
	groupStatus    atomic.Int32
	noDefault      atomic.Bool // no group carries is_default: the user's console default was never set
}

func newFakeAuthIssuer(t *testing.T) *fakeAuthIssuer {
	t.Helper()
	f := &fakeAuthIssuer{}
	f.access.Store("at")
	f.refresh.Store("rt")
	f.billable.Store([]string{"team"})
	f.groupStatus.Store(http.StatusOK)
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
		f.tokenHits.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": f.access.Load(), "refresh_token": f.refresh.Load(),
			"expires_in": 3600, "token_type": "Bearer",
		})
	})
	mux.HandleFunc("/v1/billing/groups", func(w http.ResponseWriter, r *http.Request) {
		f.groupHits.Add(1)
		if s := int(f.groupStatus.Load()); s != http.StatusOK {
			http.Error(w, "nope", s)
			return
		}
		billable := f.billable.Load().([]string)
		data := make([]map[string]any, len(billable))
		for i, name := range billable {
			data[i] = map[string]any{"id": fmt.Sprintf("g%d", i), "name": name, "is_default": i == 0 && !f.noDefault.Load()}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
	})
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		f.modelHits.Add(1)
		f.sawModelBillTo.Store(r.Header.Get("x-bill-to"))
		// The listing reflects the group the request was billed to, as the
		// real gateway's does: the model id carries it, so a test can tell
		// whose catalogue a refresh actually read.
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []gatewayModel{{
			ID: "model-for-" + r.Header.Get("x-bill-to"), DisplayName: "Model",
			ContextWindow: 8192, MaxOutputTokens: 4096,
		}}})
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	f.Server = srv
	return f
}

// authRig is a recorded enrollment whose settings point at the fake issuer:
// tokens that have expired long ago, a sentinel opencode.json (login must
// never touch it) and a machine id (login must never rotate it).
func authRig(t *testing.T, issuer *fakeAuthIssuer) (dir, credsPath, configPath string) {
	t.Helper()
	dir = t.TempDir()
	credsPath = filepath.Join(dir, credentialsFileName)
	configPath = filepath.Join(dir, opencodeConfigFileName)
	if err := os.WriteFile(configPath, []byte(`{"provider":{"pystino":{"options":{"apiKey":"secret"}}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	writeCreds(t, credsPath, &credentials{
		Issuer: issuer.URL, TokenEndpoint: issuer.URL + "/token",
		ClientID: "opencode-enrollment", Gateway: issuer.URL + "/v1", Group: "team",
		RefreshToken: "old-rt", AccessToken: "old-at", ExpiresIn: 300,
		ObtainedAt: time.Now().Add(-10 * time.Hour).Unix(),
		ShimPort:   41871, ShimSecret: "s",
		CereaOrigin: "https://cerea.example", OpencodeConfig: configPath,
	})
	return dir, credsPath, configPath
}

// keepTokenFields pins which fields a login is allowed to change.
func keepTokenFields(t *testing.T, before, after credentials) {
	t.Helper()
	if before.Issuer != after.Issuer || before.TokenEndpoint != after.TokenEndpoint ||
		before.RevocationEndpoint != after.RevocationEndpoint || before.ClientID != after.ClientID ||
		before.Gateway != after.Gateway || before.Group != after.Group ||
		before.ShimPort != after.ShimPort || before.ShimSecret != after.ShimSecret ||
		before.CereaOrigin != after.CereaOrigin || before.OpencodeConfig != after.OpencodeConfig {
		t.Fatalf("login changed a non-token field:\nbefore: %+v\nafter:  %+v", before, after)
	}
}

// keepAllButBilling pins every field except the billing mode and group: what
// 'auth group' may change, and nothing else — tokens included, since a set
// on a live credential must not trigger a refresh as a side effect.
func keepAllButBilling(t *testing.T, before, after credentials) {
	t.Helper()
	before.Group, after.Group = "", ""
	before.BillToDefault, after.BillToDefault = false, false
	if before != after {
		t.Fatalf("the billing change touched more than the billing fields:\nbefore: %+v\nafter:  %+v", before, after)
	}
}

// rigFresh is authRig with a token that does not need refreshing, so a
// command's own fetches are the only requests and the token fields stay put.
func rigFresh(t *testing.T, issuer *fakeAuthIssuer) (dir, credsPath, configPath string) {
	t.Helper()
	dir, credsPath, configPath = authRig(t, issuer)
	creds := readCreds(t, credsPath)
	creds.ObtainedAt = time.Now().Unix()
	writeCreds(t, credsPath, &creds)
	return dir, credsPath, configPath
}

func fileBytes(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

// TestAuthLoginRewritesTokensKeepsEverythingElse drives the whole command:
// the tokens are replaced with what the IdP just issued, every other field
// byte-identical, the machine id never rotated, opencode.json untouched, the
// file still 0600, and the recorded group verified against the gateway.
func TestAuthLoginRewritesTokensKeepsEverythingElse(t *testing.T) {
	issuer := newFakeAuthIssuer(t)
	_, credsPath, configPath := authRig(t, issuer)
	machineID := filepath.Join(filepath.Dir(credsPath), machineIDFileName)
	if err := os.WriteFile(machineID, []byte("machine-1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	machineBefore := fileBytes(t, machineID)
	configBefore := fileBytes(t, configPath)
	before := readCreds(t, credsPath)

	if err := runAuth([]string{"login", "--creds", credsPath, "--device"}); err != nil {
		t.Fatal(err)
	}

	after := readCreds(t, credsPath)
	if after.AccessToken != "at" || after.RefreshToken != "rt" || after.ExpiresIn != 3600 {
		t.Fatalf("token fields not rewritten: access %q refresh %q expires %d",
			after.AccessToken, after.RefreshToken, after.ExpiresIn)
	}
	keepTokenFields(t, before, after)
	if after.ObtainedAt < time.Now().Unix()-60 || after.ObtainedAt > time.Now().Unix() {
		t.Fatalf("obtained_at not renewed: %d", after.ObtainedAt)
	}
	if id := fileBytes(t, machineID); id != machineBefore {
		t.Fatalf("machine id rotated: %q → %q", machineBefore, id)
	}
	if cfg := fileBytes(t, configPath); cfg != configBefore {
		t.Fatalf("opencode.json changed:\n%s", cfg)
	}
	if info, err := os.Stat(credsPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, err %v", info, err)
	}
	if got := int(issuer.groupHits.Load()); got != 1 {
		t.Fatalf("billing groups hit %d times, want 1 (the token is verified)", got)
	}
}

// The owner's `galopin auth refresh`: the exact same command, accepted.
func TestAuthRefreshAliasRunsLogin(t *testing.T) {
	issuer := newFakeAuthIssuer(t)
	_, credsPath, _ := authRig(t, issuer)
	before := readCreds(t, credsPath)

	if err := runAuth([]string{"refresh", "--creds", credsPath, "--device"}); err != nil {
		t.Fatal(err)
	}
	keepTokenFields(t, before, readCreds(t, credsPath))
}

// A missing file, or one that does not record an issuer or client id, is a
// refusal that names the way in — never a half-signin against a guess.
func TestAuthLoginRefusesMissingFileAndMissingSettings(t *testing.T) {
	dir := t.TempDir()

	err := runAuth([]string{"login", "--creds", filepath.Join(dir, credentialsFileName)})
	if err == nil || !strings.Contains(err.Error(), "galopin enroll") {
		t.Fatalf("missing file: err = %v, want a refusal naming 'galopin enroll'", err)
	}

	path := filepath.Join(dir, "partial.json")
	if werr := os.WriteFile(path, []byte(`{"client_id":"c","group":"team"}`), 0o600); werr != nil {
		t.Fatal(werr)
	}
	if err = runAuth([]string{"login", "--creds", path, "--device"}); err == nil ||
		!strings.Contains(err.Error(), "galopin enroll") {
		t.Fatalf("missing issuer: err = %v, want a refusal naming 'galopin enroll'", err)
	}
}

// A revoked machine must re-enroll, by design: its machine id is refused for
// good, so a fresh token for it is worthless. Nothing is signed in and
// nothing is written.
func TestAuthLoginRefusesRevokedMachine(t *testing.T) {
	issuer := newFakeAuthIssuer(t)
	dir, credsPath, _ := authRig(t, issuer)
	machineID := filepath.Join(dir, machineIDFileName)
	if err := os.WriteFile(machineID, []byte("machine-1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeRevokedMarker(dir, "machine-1"); err != nil {
		t.Fatal(err)
	}
	before := fileBytes(t, credsPath)

	err := runAuth([]string{"login", "--creds", credsPath, "--device"})
	if err == nil || !strings.Contains(err.Error(), "re-enroll") {
		t.Fatalf("revoked: err = %v, want a refusal naming re-enroll", err)
	}
	if issuer.tokenHits.Load() != 0 {
		t.Fatalf("the IdP was hit %d times on a revoked machine", issuer.tokenHits.Load())
	}
	if cfg := fileBytes(t, credsPath); cfg != before {
		t.Fatalf("credential file changed on a revoked machine:\n%s", cfg)
	}
}

// A group the gateway no longer does business with is reported, the enroll
// advice is given, and nothing is written for a login the shim could not use.
func TestAuthLoginRefusesGroupNoLongerBillable(t *testing.T) {
	issuer := newFakeAuthIssuer(t)
	_, credsPath, _ := authRig(t, issuer)
	issuer.billable.Store([]string{"other-group"})
	before := fileBytes(t, credsPath)

	err := runAuth([]string{"login", "--creds", credsPath, "--device"})
	if err == nil || !strings.Contains(err.Error(), "team") || !strings.Contains(err.Error(), "galopin enroll") {
		t.Fatalf("stale group: err = %v, want group name plus enroll advice", err)
	}
	if cfg := fileBytes(t, credsPath); cfg != before {
		t.Fatalf("credential file rewritten despite the stale group:\n%s", cfg)
	}
}

// The write happens under the same cross-process lock the shim refreshes
// under (R7): while the lock is held, the login has verified everything and
// still holds — releasing the lock releases the write.
func TestAuthLoginTakesTheSameLockAsTheShim(t *testing.T) {
	issuer := newFakeAuthIssuer(t)
	_, credsPath, _ := authRig(t, issuer)
	before := fileBytes(t, credsPath)

	lock, err := os.OpenFile(credsPath+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() {
		done <- runAuth([]string{"login", "--creds", credsPath, "--device"})
	}()

	// The sign-in has its credential (token endpoint hit); the billing check
	// and the write are then due — the write must stay behind the lock.
	deadline := time.Now().Add(10 * time.Second)
	for issuer.tokenHits.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	time.Sleep(600 * time.Millisecond)
	if got := fileBytes(t, credsPath); got != before {
		t.Fatalf("wrote while the lock was held:\n%s", got)
	}
	_ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("login after the lock was released: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("login never finished after the lock was released")
	}
	after := readCreds(t, credsPath)
	if after.AccessToken == "old-at" {
		t.Fatal("tokens not rewritten after the lock was released")
	}
}

// status is read-only: it answers, prints the state of the file and the
// shim's last verdict, and leaves the whole directory as it found it.
func TestAuthStatusIsReadOnly(t *testing.T) {
	issuer := newFakeAuthIssuer(t)
	dir, credsPath, _ := authRig(t, issuer)
	// An access token that reads as a JWT carrying the user's email, so the
	// user line has a value to show.
	creds := readCreds(t, credsPath)
	creds.AccessToken = fakeJWT("user@example.com")
	writeCreds(t, credsPath, &creds)
	if err := writeStatusFile(statusPathFor(credsPath), healthStatus{
		State: stateExpired, CheckedAt: time.Now().Add(-time.Hour),
		Message: "invalid_grant from the IdP",
	}); err != nil {
		t.Fatal(err)
	}
	snapshot := func() map[string]string {
		out := map[string]string{}
		if err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			out[strings.TrimPrefix(path, dir+"/")] = fileBytes(t, path)
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return out
	}
	before := snapshot()

	// An access token that parses as a JWT, so the user line has a value.
	stdout := capturestdout(t, func() {
		if err := runAuth([]string{"status", "--creds", credsPath}); err != nil {
			t.Fatalf("status: %v", err)
		}
	})

	for _, want := range []string{
		issuer.URL, "user@example.com", "team", "expired", "invalid_grant",
		"refresh credential: present", "not revoked",
	} {
		if !strings.Contains(stdout, want) {
			t.Errorf("status output %q lacks %q", stdout, want)
		}
	}
	if after := snapshot(); len(after) != len(before) {
		t.Fatalf("status created or removed files: %d → %d", len(before), len(after))
	} else {
		for name, content := range before {
			if after[name] != content {
				t.Errorf("status changed %s", name)
			}
		}
	}
}

// capturestdout temporarily replaces os.Stdout and returns what fn printed.
func capturestdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	orig := os.Stdout
	os.Stdout = w
	printed := make(chan string, 1)
	go func() {
		data, _ := io.ReadAll(r)
		printed <- string(data)
	}()
	fn()
	os.Stdout = orig
	_ = w.Close()
	return <-printed
}

// fakeJWT is an unvalidated-looking access token carrying an email claim:
// what a JWT-issuing IdP puts in credentials.json, and what status reads the
// user out of.
func fakeJWT(email string) string {
	payload, _ := json.Marshal(map[string]string{"email": email, "sub": "user-7"})
	return "eyJoZWFkZXIiOn0." + base64.RawURLEncoding.EncodeToString(payload) + ".c2ln"
}

// 'auth group' with no argument lists the billable groups with the current
// one marked, states the mode, and changes nothing.
func TestAuthGroupListsAndMarksTheCurrentGroup(t *testing.T) {
	issuer := newFakeAuthIssuer(t)
	issuer.billable.Store([]string{"team", "other-group"})
	_, credsPath, _ := rigFresh(t, issuer)
	before := fileBytes(t, credsPath)

	var stdout string
	out := capturestdout(t, func() {
		if err := runAuth([]string{"group", "--creds", credsPath}); err != nil {
			t.Fatalf("auth group: %v", err)
		}
	})
	stdout = out

	if !strings.Contains(stdout, "pinned: team") || !strings.Contains(stdout, "team (current)") {
		t.Errorf("listing %q lacks the mode line and the current marker", stdout)
	}
	if !strings.Contains(stdout, "other-group") || strings.Contains(stdout, "other-group (current)") {
		t.Errorf("listing %q mislabels other-group", stdout)
	}
	if cfg := fileBytes(t, credsPath); cfg != before {
		t.Fatalf("a listing rewrote the credential file:\n%s", cfg)
	}
}

// 'auth group NAME' moves the billing to NAME: validated against the live
// list, only the group field rewritten, and the models map re-discovered for
// the new group — because the visible models depend on it (A).
func TestAuthGroupSetsAValidGroupAndRefreshesModels(t *testing.T) {
	issuer := newFakeAuthIssuer(t)
	issuer.billable.Store([]string{"team", "other-group"})
	_, credsPath, configPath := rigFresh(t, issuer)
	before := readCreds(t, credsPath)

	if err := runAuth([]string{"group", "--creds", credsPath, "other-group"}); err != nil {
		t.Fatal(err)
	}

	after := readCreds(t, credsPath)
	if after.Group != "other-group" {
		t.Fatalf("group = %q, want other-group", after.Group)
	}
	keepAllButBilling(t, before, after)
	if saw := issuer.sawModelBillTo.Load().(string); saw != "other-group" {
		t.Errorf("the model refresh billed to %q, want other-group", saw)
	}
	if cfg := fileBytes(t, configPath); !strings.Contains(cfg, "model-for-other-group") {
		t.Fatalf("opencode.json was not re-discovered for the new group:\n%s", cfg)
	}
}

// An explicit name that is not billable is an error listing the choices —
// the same rule pickGroup applies — and nothing is written or re-discovered.
func TestAuthGroupRefusesAnUnbillableName(t *testing.T) {
	issuer := newFakeAuthIssuer(t)
	issuer.billable.Store([]string{"team", "other-group"})
	_, credsPath, configPath := rigFresh(t, issuer)
	before := fileBytes(t, credsPath)
	configBefore := fileBytes(t, configPath)

	err := runAuth([]string{"group", "--creds", credsPath, "somewhere-else"})
	if err == nil || !strings.Contains(err.Error(), "somewhere-else") ||
		!strings.Contains(err.Error(), "not billable") || !strings.Contains(err.Error(), "other-group") {
		t.Fatalf("unbillable name: err = %v, want the name, the rule and the choices", err)
	}
	if cfg := fileBytes(t, credsPath); cfg != before {
		t.Fatalf("credential file written despite the refusal:\n%s", cfg)
	}
	if cfg := fileBytes(t, configPath); cfg != configBefore {
		t.Fatalf("models rewritten despite the refusal:\n%s", cfg)
	}
	if issuer.modelHits.Load() != 0 {
		t.Errorf("model discovery ran %d times despite the refusal", issuer.modelHits.Load())
	}
}

// No credential file, nothing to change: the refusal names the way in.
func TestAuthGroupRefusesWithoutEnrollment(t *testing.T) {
	dir := t.TempDir()
	err := runAuth([]string{"group", "--creds", filepath.Join(dir, credentialsFileName), "team"})
	if err == nil || !strings.Contains(err.Error(), "galopin enroll") {
		t.Fatalf("no file: err = %v, want a refusal naming 'galopin enroll'", err)
	}
}
