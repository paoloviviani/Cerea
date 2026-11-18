package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// refreshVibeConfig re-discovers the gateway's models and rewrites galopin's own Vibe
// config from them. It never acts on a failed or empty discovery: an empty list would
// leave Vibe with nothing to offer.
func refreshVibeConfig(ctx context.Context, creds *credentials, credsPath string, token func(context.Context) (string, error)) (*modelsDiff, error) {
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
	vm := vibeModels(models)
	home := vibeHomeFor(credsPath)
	path := filepath.Join(home, "config.toml")
	if len(vm) == 0 {
		return nil, fmt.Errorf("model discovery failed or listed no chat model (GET %s/models): %s left unchanged", strings.TrimSuffix(creds.Gateway, "/"), path)
	}
	old, _ := readVibeModels(path)
	diff := vibeModelsDiff(old, vm)
	if err := writeVibeEngineConfig(home, creds, models); err != nil {
		return nil, err
	}
	return diff, nil
}

func refreshVibeAtStart(ctx context.Context, creds *credentials, credsPath string, token func(context.Context) (string, error)) {
	diff, err := refreshVibeConfig(ctx, creds, credsPath, token)
	if err != nil {
		logf("warning: model refresh skipped: %v", err)
		return
	}
	if diff.Changed() {
		logf("models refreshed: %d added, %d removed, %d changed", len(diff.Added), len(diff.Removed), diff.Updated)
	}
}

// refreshVibeModelsCmd is `galopin models refresh` for a Vibe machine.
func refreshVibeModelsCmd(ctx context.Context, creds *credentials, credsPath string, token func(context.Context) (string, error)) error {
	diff, err := refreshVibeConfig(ctx, creds, credsPath, token)
	if err != nil {
		return err
	}
	fmt.Fprint(os.Stderr, diff.Summary(filepath.Join(vibeHomeFor(credsPath), "config.toml")))
	if diff.Changed() {
		fmt.Fprintln(os.Stderr, "a running 'galopin run' keeps its old list: restart it to pick this one up.")
	}
	return nil
}
