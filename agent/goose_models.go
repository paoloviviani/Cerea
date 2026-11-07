package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// refreshGooseConfig re-discovers the gateway's models and rewrites galopin's
// own goose config from them. It never touches a failed or empty discovery's
// result: an empty list would leave goose with nothing to offer.
func refreshGooseConfig(ctx context.Context, creds *credentials, credsPath string, token func(context.Context) (string, error)) (*modelsDiff, error) {
	if creds.Gateway == "" {
		return nil, fmt.Errorf("the credential file has no gateway: re-run 'galopin enroll'")
	}
	ctx, cancel := context.WithTimeout(ctx, modelsRefreshTimeout)
	defer cancel()
	access, err := token(ctx)
	if err != nil {
		return nil, fmt.Errorf("signing in with the stored credential: %w", err)
	}
	models := fetchModels(ctx, creds.Gateway, access, creds.Group)
	gm := gooseModels(models)
	root := gooseRootFor(credsPath)
	path := filepath.Join(root, "config", "custom_providers", gooseProviderID+".json")
	if len(gm) == 0 {
		return nil, fmt.Errorf("model discovery failed or listed no chat model (GET %s/models): %s left unchanged", strings.TrimSuffix(creds.Gateway, "/"), path)
	}
	old, _ := readGooseProviderModels(path)
	diff := diffModelIDs(old, gm)
	if err := writeGooseEngineConfig(root, creds, models); err != nil {
		return nil, err
	}
	return diff, nil
}

// diffModelIDs compares a previous model-id list with the new one.
func diffModelIDs(old map[string]int, now []gooseModel) *modelsDiff {
	d := &modelsDiff{}
	seen := map[string]bool{}
	for _, m := range now {
		seen[m.ID] = true
		prev, had := old[m.ID]
		switch {
		case !had:
			d.Added = append(d.Added, m.ID)
		case prev != m.Context:
			d.Updated++
		default:
			d.Unchanged++
		}
	}
	for id := range old {
		if !seen[id] && id != placeholderModelID {
			d.Removed = append(d.Removed, id)
		}
	}
	slices.Sort(d.Added)
	slices.Sort(d.Removed)
	return d
}

func refreshGooseAtStart(ctx context.Context, creds *credentials, credsPath string, token func(context.Context) (string, error)) {
	diff, err := refreshGooseConfig(ctx, creds, credsPath, token)
	if err != nil {
		logf("warning: model refresh skipped: %v", err)
		return
	}
	if diff.Changed() {
		logf("models refreshed: %d added, %d removed, %d changed", len(diff.Added), len(diff.Removed), diff.Updated)
	}
}

// refreshGooseModelsCmd is `galopin models refresh` for a goose machine, which
// also updates the provider 'galopin goose setup' put in the user's own goose
// config, when there is one.
func refreshGooseModelsCmd(ctx context.Context, creds *credentials, credsPath string, token func(context.Context) (string, error)) error {
	diff, err := refreshGooseConfig(ctx, creds, credsPath, token)
	if err != nil {
		return err
	}
	fmt.Fprint(os.Stderr, diff.Summary(filepath.Join(gooseRootFor(credsPath), "config", "custom_providers", gooseProviderID+".json")))
	if diff.Changed() {
		fmt.Fprintln(os.Stderr, "a running 'galopin run' keeps its old list: restart it to pick this one up.")
	}
	return nil
}
