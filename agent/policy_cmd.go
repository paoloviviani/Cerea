package main

import (
	"fmt"
	"os"
	"path/filepath"

	"galopin/internal/policy"
)

const policyUsage = `galopin policy — show or locally tighten this machine's policy.

Usage:
  galopin policy show [--creds PATH] [--state-dir PATH]
  galopin policy set [options] [--creds PATH] [--state-dir PATH]

'set' may only TIGHTEN the policy: turn files or the terminal off, lower
maxTerminals, or add to the file deny list. This file is never writable
over the link (PROTOCOL.md §4); the local CLI keeps that same one-way
shape, so loosening anything back — files or terminal back on, a higher
maxTerminals, dropping a deny entry — refuses and names the 'enroll'
re-run that does it instead.

  --no-files          Turn the /code explorer off.
  --no-terminal       Turn the terminal off.
  --max-terminals N   Lower the concurrent-terminal cap (must be less than
                      the current value).
  --file-deny GLOB    Add GLOB to the deny list (repeatable).
  --creds PATH        Credential file (default <config-dir>/galopin/credentials.json).
  --state-dir PATH    Where policy.json lives (default: beside --creds).
`

func runPolicy(args []string) error {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, policyUsage)
		return fmt.Errorf("policy: expected 'show' or 'set'")
	}
	switch args[0] {
	case "show":
		return runPolicyShow(args[1:])
	case "set":
		return runPolicySet(args[1:])
	case "-h", "-help", "--help", "help":
		fmt.Print(policyUsage)
		return nil
	default:
		return fmt.Errorf("policy: unknown subcommand %q (want 'show' or 'set')", args[0])
	}
}

// policyStateDir resolves where policy.json lives: --state-dir if given,
// else beside --creds (or the default creds path) — the same rule 'run'
// itself uses.
func policyStateDir(credsPath, stateDir string) (string, error) {
	if stateDir != "" {
		return stateDir, nil
	}
	if credsPath == "" {
		var err error
		credsPath, err = defaultCredsPath()
		if err != nil {
			return "", err
		}
	}
	return filepath.Dir(credsPath), nil
}

func runPolicyShow(args []string) error {
	fs := flagSetWithHelp("policy show", policyUsage)
	var credsPath, stateDir string
	fs.StringVar(&credsPath, "creds", "", "")
	fs.StringVar(&stateDir, "state-dir", "", "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := policyStateDir(credsPath, stateDir)
	if err != nil {
		return err
	}
	pol, err := policy.Load(filepath.Join(dir, policyFileName))
	if err != nil {
		return err
	}
	fmt.Println(filesPolicySummary(pol))
	fmt.Println(terminalPolicySummary(pol))
	fmt.Printf("autoAccept: %s\n", pol.AutoAccept)
	fmt.Printf("allowFreeModels: %v\n", pol.AllowFreeModels)
	fmt.Printf("workspaceRoots: %v\n", pol.WorkspaceRoots)
	return nil
}

func runPolicySet(args []string) error {
	fs := flagSetWithHelp("policy set", policyUsage)
	var credsPath, stateDir string
	noFiles := fs.Bool("no-files", false, "")
	noTerminal := fs.Bool("no-terminal", false, "")
	maxTerminals := fs.Int("max-terminals", 0, "")
	var fileDeny []string
	fs.Var(stringListFlag{&fileDeny}, "file-deny", "")
	fs.StringVar(&credsPath, "creds", "", "")
	fs.StringVar(&stateDir, "state-dir", "", "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("policy set: unexpected arguments: %v", fs.Args())
	}

	dir, err := policyStateDir(credsPath, stateDir)
	if err != nil {
		return err
	}
	path := filepath.Join(dir, policyFileName)
	pol, err := policy.Load(path)
	if err != nil {
		return err
	}

	changed := false
	if *noFiles {
		pol.Files = policy.FilesOff
		changed = true
	}
	if *noTerminal {
		pol.Terminal = policy.TerminalDenied
		changed = true
	}
	if *maxTerminals != 0 {
		current := pol.EffectiveMaxTerminals()
		if *maxTerminals >= current {
			return fmt.Errorf("--max-terminals %d does not tighten the current cap of %d: re-run enroll with --max-terminals %d to raise it", *maxTerminals, current, *maxTerminals)
		}
		pol.MaxTerminals = *maxTerminals
		changed = true
	}
	if len(fileDeny) > 0 {
		pol.FileDeny = append(pol.FileDeny, fileDeny...)
		changed = true
	}
	if !changed {
		return fmt.Errorf("policy set: nothing to change (see 'galopin policy set -h')")
	}
	if err := policy.Save(path, pol); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, filesPolicySummary(pol))
	fmt.Fprintln(os.Stderr, terminalPolicySummary(pol))
	return nil
}
