package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"galopin/internal/policy"
)

const resetUsage = `galopin reset — return this machine's policy to the defaults.

Usage:
  galopin reset [--yes] [--creds PATH] [--state-dir PATH]

Writes the policy a fresh 'galopin enroll' with no options would write: every
permission class at its default limit, the safe directories at their default
list, the file editor, terminal, command shell and background subagents on,
project config off, no workspace-root confinement. Credentials and the
pairing with Cerea are not touched. A running 'galopin run' keeps the stricter
of what it has and the defaults until it is restarted: loosening needs a
restart, as everywhere.

  --yes        Do not ask for confirmation.
  --creds PATH Credential file (default <config-dir>/galopin/credentials.json).
  --state-dir PATH  Where policy.json lives (default: beside --creds).
`

func runReset(args []string) error {
	fs := flagSetWithHelp("reset", resetUsage)
	var credsPath, stateDir string
	yes := fs.Bool("yes", false, "")
	fs.StringVar(&credsPath, "creds", "", "")
	fs.StringVar(&stateDir, "state-dir", "", "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("reset: unexpected arguments: %v", fs.Args())
	}
	dir, err := policyStateDir(credsPath, stateDir)
	if err != nil {
		return err
	}
	return resetPolicy(filepath.Join(dir, policyFileName), *yes, promptYes)
}

// promptYes asks a yes/no question on the terminal; anything but y or yes is no.
func promptYes(question string) (bool, error) {
	answer, err := promptLine(question + " [y/N]: ")
	if err != nil {
		return false, err
	}
	a := strings.ToLower(strings.TrimSpace(answer))
	return a == "y" || a == "yes", nil
}

func resetPolicy(path string, yes bool, confirm func(string) (bool, error)) error {
	if !yes {
		ok, err := confirm("This returns the machine's permission and feature settings to the defaults (credentials and pairing are kept). Continue?")
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("reset: cancelled, nothing changed")
		}
	}
	pol := freshEnrollPolicy()
	if err := policy.Save(path, pol); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "policy reset to the defaults:")
	fmt.Fprintln(os.Stderr, permissionPolicySummary(pol))
	return nil
}
