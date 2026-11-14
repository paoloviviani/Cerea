package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const upgradeUsage = `galopin upgrade — upgrade this galopin from the Cerea it is enrolled with.

Usage:
  galopin upgrade [--yes] [--stop] [--creds PATH]

Downloads <cerea>/galopin/install.sh from the Cerea recorded at enroll time
(https, or http only on this computer) and runs it with --upgrade: it stops
galopin, backs up galopin's state and opencode's database, installs the new
galopin (and the opencode or goose this Cerea pins, when galopin installed
it), refreshes the browser runtime, and restarts the systemd unit. Enrollment
and settings are kept. It shows what will happen and asks first.

  --yes        Do not ask.
  --stop       Let the installer send SIGTERM to your own running 'galopin run'
               (a foreground one started by hand) before it upgrades.
  --creds PATH Credential file (default <config-dir>/galopin/credentials.json).
`

// upgradeEnv is everything 'galopin upgrade' reaches outside itself.
type upgradeEnv struct {
	fetch   func(ctx context.Context, url string) ([]byte, error)
	run     func(ctx context.Context, script string, args []string, env []string) error
	confirm func(question string) (bool, error)
	exe     func() (string, error)
	environ []string
	out     io.Writer
}

func realUpgradeEnv() *upgradeEnv {
	return &upgradeEnv{
		fetch: func(ctx context.Context, u string) ([]byte, error) {
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
			if err != nil {
				return nil, err
			}
			resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
			if err != nil {
				return nil, err
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				return nil, fmt.Errorf("%s answered %s", u, resp.Status)
			}
			return io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		},
		run: func(ctx context.Context, script string, args []string, env []string) error {
			cmd := exec.CommandContext(ctx, "sh", append([]string{script}, args...)...)
			cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
			cmd.Env = env
			return cmd.Run()
		},
		confirm: promptYes,
		exe:     os.Executable,
		environ: os.Environ(),
		out:     os.Stdout,
	}
}

func runUpgrade(args []string) error {
	fs := flagSetWithHelp("upgrade", upgradeUsage)
	var credsPath string
	yes := fs.Bool("yes", false, "")
	stop := fs.Bool("stop", false, "")
	fs.StringVar(&credsPath, "creds", "", "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("upgrade: unexpected arguments: %v", fs.Args())
	}
	if credsPath == "" {
		p, err := defaultCredsPath()
		if err != nil {
			return err
		}
		credsPath = p
	}
	creds, err := loadCredentials(credsPath)
	if err != nil {
		return fmt.Errorf("nothing to upgrade, run the normal install: %w", err)
	}
	return upgradeFrom(context.Background(), realUpgradeEnv(), creds.CereaOrigin, *yes, *stop, credsPath)
}

// upgradeOrigin checks the enrolled Cerea origin is one the installer may be
// fetched from: https, or http on this computer.
func upgradeOrigin(origin string) (string, error) {
	origin = strings.TrimRight(strings.TrimSpace(origin), "/")
	if origin == "" {
		return "", fmt.Errorf("this galopin recorded no Cerea origin; run the install line from the Pair a computer dialog with --upgrade instead")
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("the recorded Cerea origin %q is not a URL", origin)
	}
	switch {
	case u.Scheme == "https":
	case u.Scheme == "http" && isLoopbackHost(u.Hostname()):
	default:
		return "", fmt.Errorf("refusing to fetch the installer from %s: only https, or http on this computer", origin)
	}
	return origin, nil
}

func upgradeFrom(ctx context.Context, env *upgradeEnv, origin string, yes, stop bool, credsPath string) error {
	origin, err := upgradeOrigin(origin)
	if err != nil {
		return err
	}
	installURL := origin + "/galopin/install.sh"
	fmt.Fprintf(env.out, "galopin %s, enrolled with %s.\n\nThis will:\n"+
		"  1. download %s and run it with --upgrade\n"+
		"  2. stop galopin, back up its state and opencode's database\n"+
		"  3. install the new galopin (the previous binary is kept as galopin.prev)\n"+
		"  4. restart galopin if it runs as a systemd user unit\n\n"+
		"Enrollment and settings are kept.\n\n", agentVersion, origin, installURL)
	if !yes {
		ok, err := env.confirm("Upgrade now?")
		if err != nil {
			return err
		}
		if !ok {
			fmt.Fprintln(env.out, "Not upgraded.")
			return nil
		}
	}
	body, err := env.fetch(ctx, installURL)
	if err != nil {
		return fmt.Errorf("could not download the installer: %w", err)
	}
	if !strings.HasPrefix(string(body), "#!/bin/sh") {
		return fmt.Errorf("%s did not return an installer", installURL)
	}
	dir, err := os.MkdirTemp("", "galopin-upgrade-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	script := filepath.Join(dir, "install.sh")
	if err := os.WriteFile(script, body, 0o700); err != nil {
		return err
	}
	scriptArgs := []string{"--upgrade", "--creds", credsPath}
	if stop {
		scriptArgs = append(scriptArgs, "--stop")
	}
	// Replace the galopin that is running this command, wherever it lives.
	environ := env.environ
	if exe, err := env.exe(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		environ = append(append([]string{}, environ...), "GALOPIN_INSTALL_DIR="+filepath.Dir(exe))
	}
	return env.run(ctx, script, scriptArgs, environ)
}
