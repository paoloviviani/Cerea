package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"time"
)

const modelsUsage = `galopin models — manage the model list opencode offers.

Usage:
  galopin models refresh [--creds PATH]

  refresh   Re-discover the gateway's models (GET /v1/models) and rewrite
            only provider.pystino.models in the opencode.json enroll wrote
            (the path recorded in the credential file). Every other key of
            the file is kept. Prints which ids were added and removed. When
            discovery fails or lists no chat model, the file is left alone
            and the command exits non-zero. It signs in with the stored
            refresh credential: no login, no new machine id.
            A running 'galopin run' keeps the list it started with: restart
            it to pick the new one up ('run' refreshes by itself at start,
            unless --no-refresh-models).

  --creds   Credential file (default <config-dir>/galopin/credentials.json).
`

// modelsRefreshTimeout bounds discovery. 'run' pays it at every start, so it
// is short: a slow gateway must not hold up the agent, and the existing list
// is a fine fallback.
const modelsRefreshTimeout = 10 * time.Second

// placeholderModelID is the id buildOpencodeConfig writes when discovery
// found nothing (enroll --no-discover, or an unreachable gateway). It is not a
// model, so a refresh replaces it without reporting it as removed.
const placeholderModelID = "REPLACE-WITH-MODEL-ID"

func runModels(args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "-help" || args[0] == "--help" {
		fmt.Fprint(os.Stderr, modelsUsage)
		if len(args) == 0 {
			return exitError{code: 2}
		}
		return nil
	}
	if args[0] != "refresh" {
		return fmt.Errorf("unknown models command %q\n\n%s", args[0], modelsUsage)
	}
	fs := flagSetWithHelp("models refresh", modelsUsage)
	credsPath := fs.String("creds", "", "")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	path := *credsPath
	if path == "" {
		p, err := resolveDefaultCredsPath()
		if err != nil {
			return err
		}
		path = p
	}
	creds, err := loadCredentials(path)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), modelsRefreshTimeout+30*time.Second)
	defer cancel()
	// The same token path the shim uses: refreshCredential takes the
	// cross-process lock, adopts a rotation another process already did and
	// persists a rotated refresh token.
	token := func(context.Context) (string, error) { return accessTokenFor(path, creds) }
	diff, err := refreshModels(ctx, creds, token)
	if err != nil {
		return err
	}
	fmt.Fprint(os.Stderr, diff.Summary(creds.OpencodeConfig))
	for _, w := range diff.Warnings {
		fmt.Fprintf(os.Stderr, "warning: %s\n", w)
	}
	if diff.Changed() {
		fmt.Fprintln(os.Stderr, "a running 'galopin run' keeps its old list: restart it to pick this one up.")
	}
	return nil
}

// accessTokenFor returns a usable access token from the stored credential,
// refreshing only when the cached one is near expiry (the shim's own rule).
func accessTokenFor(credsPath string, creds *credentials) (string, error) {
	if creds.needsRefresh(time.Now()) {
		if err := refreshCredential(credsPath, creds); err != nil {
			return "", err
		}
	}
	return creds.AccessToken, nil
}

// modelsDiff is what a refresh changed in the models map.
type modelsDiff struct {
	Added, Removed []string
	Updated        int // same id, different entry (limits, name, modalities)
	Unchanged      int
	Warnings       []string
}

// Changed reports whether the file was (or would be) rewritten.
func (d *modelsDiff) Changed() bool {
	return len(d.Added)+len(d.Removed)+d.Updated > 0
}

// Summary is the short diff printed to the person.
func (d *modelsDiff) Summary(path string) string {
	var b strings.Builder
	if !d.Changed() {
		fmt.Fprintf(&b, "models already current in %s (%d unchanged).\n", path, d.Unchanged)
		return b.String()
	}
	fmt.Fprintf(&b, "updated models in %s\n", path)
	if len(d.Added) > 0 {
		fmt.Fprintf(&b, "  added:     %s\n", strings.Join(d.Added, ", "))
	}
	if len(d.Removed) > 0 {
		fmt.Fprintf(&b, "  removed:   %s\n", strings.Join(d.Removed, ", "))
	}
	if d.Updated > 0 {
		fmt.Fprintf(&b, "  changed:   %d (same id, new limits or name)\n", d.Updated)
	}
	fmt.Fprintf(&b, "  unchanged: %d\n", d.Unchanged)
	return b.String()
}

// refreshModels discovers the gateway's models and rewrites only
// provider.pystino.models of the opencode.json the credentials record. On any
// failure, or when discovery yields no chat model, the file is not touched:
// an empty list would leave opencode with nothing to offer, which is worse
// than a stale one.
func refreshModels(ctx context.Context, creds *credentials, token func(context.Context) (string, error)) (*modelsDiff, error) {
	if creds.OpencodeConfig == "" {
		return nil, fmt.Errorf("the credential file records no opencode.json (enrolled before that was recorded): re-run 'galopin enroll'")
	}
	if creds.Gateway == "" {
		return nil, fmt.Errorf("the credential file has no gateway: re-run 'galopin enroll'")
	}
	body, err := os.ReadFile(creds.OpencodeConfig)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", creds.OpencodeConfig, err)
	}
	ctx, cancel := context.WithTimeout(ctx, modelsRefreshTimeout)
	defer cancel()
	access, err := token(ctx)
	if err != nil {
		return nil, fmt.Errorf("signing in with the stored credential: %w", err)
	}
	// fetchModels folds every failure into nil, so "failed" and "listed
	// nothing" are the same outcome here, and both leave the file alone.
	entries := modelEntries(fetchModels(ctx, creds.Gateway, access))
	if len(entries) == 0 {
		return nil, fmt.Errorf("model discovery failed or listed no chat model (GET %s/models): %s left unchanged", strings.TrimSuffix(creds.Gateway, "/"), creds.OpencodeConfig)
	}

	// Parsed into raw messages level by level so every key refresh does not
	// own survives as it was.
	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", creds.OpencodeConfig, err)
	}
	var providers map[string]json.RawMessage
	var pystino map[string]json.RawMessage
	if err := json.Unmarshal(top["provider"], &providers); err != nil || providers["pystino"] == nil {
		return nil, fmt.Errorf("%s has no provider.pystino: not the file enroll wrote", creds.OpencodeConfig)
	}
	if err := json.Unmarshal(providers["pystino"], &pystino); err != nil {
		return nil, fmt.Errorf("parsing provider.pystino in %s: %w", creds.OpencodeConfig, err)
	}
	var old map[string]json.RawMessage
	if raw := pystino["models"]; raw != nil {
		if err := json.Unmarshal(raw, &old); err != nil {
			return nil, fmt.Errorf("parsing provider.pystino.models in %s: %w", creds.OpencodeConfig, err)
		}
	}

	diff := &modelsDiff{}
	fresh := make(map[string]json.RawMessage, len(entries))
	for id, entry := range entries {
		raw, err := json.Marshal(entry)
		if err != nil {
			return nil, err
		}
		fresh[id] = raw
		prev, had := old[id]
		switch {
		case !had:
			diff.Added = append(diff.Added, id)
		case jsonEqual(prev, raw):
			diff.Unchanged++
		default:
			diff.Updated++
		}
	}
	for id := range old {
		if _, ok := fresh[id]; !ok && id != placeholderModelID {
			diff.Removed = append(diff.Removed, id)
		}
	}
	slices.Sort(diff.Added)
	slices.Sort(diff.Removed)
	// enroll writes no default model, but a hand-edit might: say so rather
	// than leave opencode pointing at an id the gateway no longer serves.
	for _, key := range []string{"model", "small_model"} {
		var ref string
		if json.Unmarshal(top[key], &ref) != nil {
			continue
		}
		if id, ok := strings.CutPrefix(ref, "pystino/"); ok {
			if _, present := fresh[id]; !present {
				diff.Warnings = append(diff.Warnings, fmt.Sprintf("%q is %q, which the gateway no longer lists; left as is, pick another model", key, ref))
			}
		}
	}
	if !diff.Changed() && old[placeholderModelID] == nil {
		return diff, nil
	}

	modelsRaw, err := json.Marshal(fresh)
	if err != nil {
		return nil, err
	}
	pystino["models"] = modelsRaw
	if providers["pystino"], err = json.Marshal(pystino); err != nil {
		return nil, err
	}
	if top["provider"], err = json.Marshal(providers); err != nil {
		return nil, err
	}
	out, err := json.Marshal(top)
	if err != nil {
		return nil, err
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, out, "", "  "); err != nil {
		return nil, err
	}
	pretty.WriteByte('\n')
	// The file carries the shim secret; keep whatever mode it has, never
	// looser than enroll's 0600.
	mode := os.FileMode(0o600)
	if info, err := os.Stat(creds.OpencodeConfig); err == nil {
		mode = info.Mode().Perm() & 0o600
	}
	if err := writeFileAtomic(creds.OpencodeConfig, pretty.Bytes(), mode); err != nil {
		return nil, fmt.Errorf("writing %s: %w", creds.OpencodeConfig, err)
	}
	return diff, nil
}

// jsonEqual compares two JSON values by meaning, not by formatting.
func jsonEqual(a, b json.RawMessage) bool {
	var ca, cb bytes.Buffer
	if json.Compact(&ca, a) != nil || json.Compact(&cb, b) != nil {
		return false
	}
	var va, vb any
	if json.Unmarshal(ca.Bytes(), &va) != nil || json.Unmarshal(cb.Bytes(), &vb) != nil {
		return false
	}
	ja, _ := json.Marshal(va)
	jb, _ := json.Marshal(vb)
	return bytes.Equal(ja, jb)
}

// refreshModelsAtStart is `run`'s best-effort version: one warning line on
// any failure, and the existing file carries on. It runs before opencode is
// spawned, since opencode reads its config once at start.
func refreshModelsAtStart(ctx context.Context, creds *credentials, token func(context.Context) (string, error)) {
	diff, err := refreshModels(ctx, creds, token)
	if err != nil {
		logf("warning: model refresh skipped: %v", err)
		return
	}
	if diff.Changed() {
		logf("models refreshed: %d added, %d removed, %d changed", len(diff.Added), len(diff.Removed), diff.Updated)
	}
	for _, w := range diff.Warnings {
		logf("warning: %s", w)
	}
}
