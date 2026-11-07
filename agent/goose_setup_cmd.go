package main

// `galopin goose setup` (ADR 0110, amendment): put galopin's proxy into the
// user's OWN goose, so goose Desktop, the goose CLI and the editor extensions
// use Cerea's models and billing, and offer them Cerea's connectors. Writes only
// goose's documented extension points: a declarative custom provider
// (<goose config>/custom_providers/galopin.json) and, for the connectors, one
// extension entry in config.yaml. The default provider is changed only with
// --default.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const gooseSetupUsage = `galopin goose — use galopin's proxy from your own goose.

Usage:
  galopin goose setup [--default] [--no-connectors] [--creds PATH] [--state-dir PATH]
  galopin goose setup --remove [--creds PATH] [--state-dir PATH]

  setup    Add the provider "galopin" to YOUR goose config (goose Desktop, the
           goose CLI and the goose editor extensions read it): Cerea's models and
           billing through galopin's local proxy, with the proxy's secret and
           this machine's model list. Also adds one goose extension, "Cerea
           connectors": a local MCP endpoint of galopin's for your own agents,
           serving this machine's connectors (mcp.json) and, while galopin is
           linked to Cerea, the Cerea connectors you switched on for local agents
           (Workspace, Agents). Safe to run again: it updates what it wrote.
  --default  Also make "galopin" goose's default provider and first model.
           Without it your default is untouched; pick the provider in goose.
  --no-connectors  Do not add the "Cerea connectors" extension.
  --remove Undo setup: delete the provider file and the extension entry, and
           restore the default provider if --default had changed it.
  --creds  Credential file (default <config-dir>/galopin/credentials.json).
  --state-dir  galopin's state directory (default: beside --creds), where setup
           records what it changed and the endpoint's secret; the same as 'run' uses.

The proxy must be running for goose to reach it: keep 'galopin run' (or
'galopin serve') going. 'galopin models refresh' updates the model list here.

One driver at a time: goose Desktop and the editor extensions share their sessions
with galopin's (the same goose session store), but a turn you drive there bypasses
Cerea's Plan / Ask / Allow, its review log and its machine rules. goose's own
approval mode applies there, and calls to the "Cerea connectors" extension are
never governed by Cerea's modes either.
`

func runGoose(args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "-help" || args[0] == "--help" {
		fmt.Fprint(os.Stderr, gooseSetupUsage)
		if len(args) == 0 {
			return exitError{code: 2}
		}
		return nil
	}
	if args[0] != "setup" {
		return fmt.Errorf("unknown goose command %q\n\n%s", args[0], gooseSetupUsage)
	}
	fs := flagSetWithHelp("goose setup", gooseSetupUsage)
	credsPath := fs.String("creds", "", "")
	makeDefault := fs.Bool("default", false, "")
	remove := fs.Bool("remove", false, "")
	noConnectors := fs.Bool("no-connectors", false, "")
	stateFlag := fs.String("state-dir", "", "")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	if *remove && (*makeDefault || *noConnectors) {
		return fmt.Errorf("--remove takes no other option")
	}
	path := *credsPath
	if path == "" {
		p, err := resolveDefaultCredsPath()
		if err != nil {
			return err
		}
		path = p
	}
	cfgDir, err := gooseUserConfigDir()
	if err != nil {
		return err
	}
	stateDir := resolveStateDir(*stateFlag, path)
	if *remove {
		return gooseSetupRemove(cfgDir, stateDir)
	}
	creds, err := loadCredentials(path)
	if err != nil {
		return err
	}
	return gooseSetup(context.Background(), creds, path, stateDir, cfgDir, *makeDefault, !*noConnectors)
}

func gooseProviderPath(cfgDir string) string {
	return filepath.Join(cfgDir, "custom_providers", gooseProviderID+".json")
}

// readGooseProviderModels reads model id -> context limit from a provider file;
// an absent or unreadable file is no models.
func readGooseProviderModels(path string) (map[string]int, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var spec gooseProviderSpec
	if err := json.Unmarshal(body, &spec); err != nil {
		return nil, err
	}
	out := map[string]int{}
	for _, m := range spec.Models {
		out[m.Name] = m.ContextLimit
	}
	return out, nil
}

func gooseSetup(ctx context.Context, creds *credentials, credsPath, stateDir, cfgDir string, makeDefault, connectors bool) error {
	if creds.ShimPort == 0 || creds.ShimSecret == "" {
		return fmt.Errorf("the credential file records no proxy port or secret: re-run 'galopin enroll'")
	}
	if creds.Mode == modeConnectors {
		return fmt.Errorf("this machine was enrolled with --connectors-only: it has no proxy for goose to use")
	}
	models, err := discoverForGoose(ctx, creds, credsPath)
	if err != nil {
		return err
	}
	provider, err := gooseProviderJSON(fmt.Sprintf("127.0.0.1:%d", creds.ShimPort), creds.ShimSecret, models, false)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(cfgDir, "custom_providers"), 0o700); err != nil {
		return err
	}
	if err := writeFileAtomic(gooseProviderPath(cfgDir), provider, 0o600); err != nil {
		return fmt.Errorf("writing the goose provider: %w", err)
	}
	fmt.Fprintf(os.Stderr, "wrote provider %q (%d models) to %s\n", gooseProviderID, len(models), gooseProviderPath(cfgDir))

	cfgPath := filepath.Join(cfgDir, "config.yaml")
	body, _ := os.ReadFile(cfgPath)
	sc, err := loadGooseSidecar(stateDir)
	if err != nil {
		return err
	}
	var ext *gooseExtSpec
	if connectors {
		la, err := ensureLocalAgentsConfig(stateDir)
		if err != nil {
			return err
		}
		e := newGooseExt(la.URL(), la.Secret)
		ext = &e
	}
	if makeDefault || connectors {
		text, err := applyGooseConfig(string(body), sc, makeDefault, gooseProviderID, gooseDefaultModel(models), ext)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(cfgDir, 0o700); err != nil {
			return err
		}
		if err := sc.save(stateDir); err != nil {
			return err
		}
		if err := writeFileAtomic(cfgPath, []byte(text), 0o600); err != nil {
			return fmt.Errorf("writing %s: %w", cfgPath, err)
		}
		if makeDefault {
			fmt.Fprintf(os.Stderr, "made %q (model %s) goose's default provider\n", gooseProviderID, gooseDefaultModel(models))
		}
		if ext != nil {
			fmt.Fprintf(os.Stderr, "added the goose extension \"Cerea connectors\" (%s)\n", ext.URI)
		}
	}
	fmt.Fprintln(os.Stderr, "note: the proxy must be running for goose to reach it ('galopin run' or 'galopin serve').")
	if connectors {
		fmt.Fprintln(os.Stderr, "note: the \"Cerea connectors\" endpoint is served by 'galopin run'; without a Cerea link it offers only this machine's connectors.")
	}
	fmt.Fprintln(os.Stderr, "note: one driver at a time. A turn driven from goose bypasses Cerea's Plan / Ask / Allow and its review log; goose's own approval applies.")
	return nil
}

// discoverForGoose lists the gateway's models for the setup provider; when the
// gateway cannot be reached it falls back to the engine config's list.
func discoverForGoose(ctx context.Context, creds *credentials, credsPath string) ([]gooseModel, error) {
	cctx, cancel := context.WithTimeout(ctx, modelsRefreshTimeout+30*time.Second)
	defer cancel()
	token := func(context.Context) (string, error) { return accessTokenFor(credsPath, creds) }
	if access, err := token(cctx); err == nil {
		fctx, fcancel := context.WithTimeout(cctx, modelsRefreshTimeout)
		defer fcancel()
		if gm := gooseModels(fetchModels(fctx, creds.Gateway, access, creds.Group)); len(gm) > 0 {
			return gm, nil
		}
	}
	// Fall back to what the engine config (or an earlier setup) already holds.
	for _, p := range []string{
		filepath.Join(gooseRootFor(credsPath), "config", "custom_providers", gooseProviderID+".json"),
	} {
		if old, err := readGooseProviderModels(p); err == nil && len(old) > 0 {
			var out []gooseModel
			for id, c := range old {
				if id != placeholderModelID {
					out = append(out, gooseModel{ID: id, Context: c})
				}
			}
			if len(out) > 0 {
				fmt.Fprintln(os.Stderr, "warning: model discovery failed; using the model list galopin already has")
				sortGooseModels(out)
				return out, nil
			}
		}
	}
	return nil, fmt.Errorf("model discovery failed or listed no chat model (GET %s/models): nothing written", strings.TrimSuffix(creds.Gateway, "/"))
}

func gooseSetupRemove(cfgDir, stateDir string) error {
	removed := false
	if err := os.Remove(gooseProviderPath(cfgDir)); err == nil {
		removed = true
		fmt.Fprintf(os.Stderr, "removed %s\n", gooseProviderPath(cfgDir))
	} else if !os.IsNotExist(err) {
		return err
	}
	cfgPath := filepath.Join(cfgDir, "config.yaml")
	if body, err := os.ReadFile(cfgPath); err == nil {
		sc, err := loadGooseSidecar(stateDir)
		if err != nil {
			return err
		}
		text, changed, err := removeGooseConfig(string(body), sc)
		if err != nil {
			return err
		}
		if changed {
			if err := writeFileAtomic(cfgPath, []byte(text), 0o600); err != nil {
				return err
			}
			removed = true
			fmt.Fprintf(os.Stderr, "removed what 'galopin goose setup' added to %s\n", cfgPath)
		}
	}
	removeGooseSidecar(stateDir)
	// The endpoint's secret is no longer in any goose config: retire it, so the
	// next setup mints a new one and a restarted 'run' opens no endpoint.
	_ = os.Remove(filepath.Join(stateDir, localAgentsFileName))
	if !removed {
		fmt.Fprintln(os.Stderr, "nothing to remove: 'galopin goose setup' had not been run here.")
	}
	return nil
}

// refreshGooseSetupProvider updates the provider 'galopin goose setup' wrote,
// if it is there: `galopin models refresh` calls it. It never creates one.
func refreshGooseSetupProvider(ctx context.Context, creds *credentials, credsPath string) {
	cfgDir, err := gooseUserConfigDir()
	if err != nil {
		return
	}
	path := gooseProviderPath(cfgDir)
	if _, err := os.Stat(path); err != nil {
		return
	}
	models, err := discoverForGoose(ctx, creds, credsPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: your goose provider was not refreshed: %v\n", err)
		return
	}
	provider, err := gooseProviderJSON(fmt.Sprintf("127.0.0.1:%d", creds.ShimPort), creds.ShimSecret, models, false)
	if err != nil {
		return
	}
	if err := writeFileAtomic(path, provider, 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "warning: your goose provider was not refreshed: %v\n", err)
		return
	}
	fmt.Fprintf(os.Stderr, "updated the \"galopin\" provider in your goose config (%d models)\n", len(models))
}
