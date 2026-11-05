package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"galopin/internal/decide"
	"galopin/internal/permrules"
	"galopin/internal/policy"
)

// parseOrNil reads KEY=ACTION values already validated once; nil on an error.
func parseOrNil(values []string) map[string]string {
	m, err := parseKeyActions("permission-rule", values)
	if err != nil {
		return nil
	}
	return m
}

const policyUsage = `galopin policy — show or locally tighten this machine's policy.

Usage:
  galopin policy show [--creds PATH] [--state-dir PATH]
  galopin policy set [options] [--creds PATH] [--state-dir PATH]

'set' may only TIGHTEN the policy: turn files, file writes, the terminal, command
shell or agent tools off, lower a permission class limit, lower maxTerminals, or add to the file deny list. This file is
never writable over the link (PROTOCOL.md §4); the local CLI keeps that
same one-way shape, so loosening anything back — files, terminal or
command shell or file writes back on, a higher maxTerminals, dropping a deny entry —
refuses and names the 'enroll' re-run that does it instead.

  --no-files          Turn the /code explorer off.
  --no-file-write     Stop the /code editor from saving files here.
  --no-terminal       Turn the terminal off.
  --no-command-shell  Refuse every command whose template expands shell,
                      and every command whose shell is unknown.
  --no-agent-tools    Stop installing the session_* and schedule_* agent tools
                      into opencode (takes effect at the next 'run').
   --no-project-config  Stop loading a repo's own opencode config (the default
                       on a fresh enroll; takes effect at the next 'run').
   --no-background-subagents  Stop allowing background subagents (they are
                       allowed on a fresh enroll; takes effect at the next 'run').
   --no-auto-accept    Does nothing (accepted for one more release): auto-accept
                       no longer exists.
   --limit CLASS=VALUE  Lower a permission class (edit, command, web, outside,
                       secrets, agents, tools, loop) to never, ask (or stop for
                       loop) (repeatable). Takes effect on a running machine
                       within seconds: opencode is restarted so nothing it kept
                       in memory outlives it. 'policy show' lists the classes.
   --permission-max KEY=ACTION, --permission-rule KEY=ACTION  Deprecated aliases
                       (one more release), mapped onto the class of KEY.
   --no-safe-dir PATH  Remove PATH from this machine's safe directories — the
                       directories outside the workspace whose contents never
                       ask (repeatable). A local set may only remove: adding
                       one needs 'enroll --safe-dir'.
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
	fmt.Println(fileWritePolicySummary(pol))
	fmt.Println(terminalPolicySummary(pol))
	fmt.Println(commandShellPolicySummary(pol))
	fmt.Println(agentToolsPolicySummary(pol))
	fmt.Println(projectConfigPolicySummary(pol, false))
	fmt.Println(backgroundSubagentsPolicySummary(pol))
	fmt.Println(permissionPolicySummary(pol))
	fmt.Printf("allowFreeModels: %v\n", pol.AllowFreeModels)
	fmt.Printf("workspaceRoots: %v\n", pol.WorkspaceRoots)
	return nil
}

func runPolicySet(args []string) error {
	fs := flagSetWithHelp("policy set", policyUsage)
	var credsPath, stateDir string
	noFiles := fs.Bool("no-files", false, "")
	noFileWrite := fs.Bool("no-file-write", false, "")
	noTerminal := fs.Bool("no-terminal", false, "")
	noCommandShell := fs.Bool("no-command-shell", false, "")
	noAgentTools := fs.Bool("no-agent-tools", false, "")
	noProjectConfig := fs.Bool("no-project-config", false, "")
	noBackground := fs.Bool("no-background-subagents", false, "")
	noAutoAccept := fs.Bool("no-auto-accept", false, "")
	var permMax, permRules, limits []string
	fs.Var(stringListFlag{&limits}, "limit", "")
	fs.Var(stringListFlag{&permMax}, "permission-max", "")
	fs.Var(stringListFlag{&permRules}, "permission-rule", "")
	var noSafeDirs []string
	fs.Var(stringListFlag{&noSafeDirs}, "no-safe-dir", "")
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
	if *noFileWrite {
		pol.FileWrite = policy.FileWriteDenied
		changed = true
	}
	if *noFiles {
		pol.Files = policy.FilesOff
		changed = true
	}
	if *noTerminal {
		pol.Terminal = policy.TerminalDenied
		changed = true
	}
	if *noCommandShell {
		pol.CommandShell = policy.TerminalDenied
		changed = true
	}
	if *noAgentTools {
		pol.AgentTools = policy.TerminalDenied
		changed = true
	}
	if *noProjectConfig {
		pol.ProjectConfig = policy.TerminalDenied
		changed = true
	}
	if *noBackground {
		pol.BackgroundSubagents = policy.TerminalDenied
		changed = true
	}
	if *noAutoAccept {
		fmt.Fprintln(os.Stderr, "warning: --no-auto-accept does nothing any more: auto-accept was replaced by the Deny / Ask / Allow selector, and there is no machine setting for it to turn off.")
	}
	if len(permMax) > 0 || len(permRules) > 0 {
		lims, _, notices, err := legacyLimits(permMax, permRules)
		if err != nil {
			return err
		}
		for _, n := range notices {
			fmt.Fprintln(os.Stderr, "note: "+n)
		}
		for _, c := range decide.Classes {
			l, ok := lims[c]
			if !ok {
				continue
			}
			ch, err := pol.Permission.TightenLimit(c, l)
			if err != nil {
				return err
			}
			changed = changed || ch
		}
		for k, v := range parseOrNil(permRules) {
			if permrules.Action(v) == permrules.Allow {
				return fmt.Errorf("--permission-rule %s=allow does not tighten: re-run enroll to loosen it", k)
			}
		}
		changed = true
	}
	if len(limits) > 0 {
		lims, err := parseLimitFlags(limits)
		if err != nil {
			return err
		}
		for _, c := range decide.Classes {
			l, ok := lims[c]
			if !ok {
				continue
			}
			ch, err := pol.Permission.TightenLimit(c, l)
			if err != nil {
				return err
			}
			changed = changed || ch
		}
		changed = true
	}
	if len(noSafeDirs) > 0 {
		effective := pol.Permission.EffectiveSafeDirs()
		dropped := map[string]bool{}
		for _, d := range noSafeDirs {
			found := false
			for _, have := range effective {
				found = found || have == d
			}
			if !found {
				return fmt.Errorf("--no-safe-dir %s is not among this machine's safe directories (%s): nothing to remove", d,
					strings.Join(policy.DisplaySafeDirs(effective), ", "))
			}
			dropped[d] = true
		}
		kept := make([]string, 0, len(effective))
		for _, d := range effective {
			if !dropped[d] {
				kept = append(kept, d)
			}
		}
		// The list is written explicitly even when it shrinks to none: an
		// absent field reads as the default list again.
		pol.Permission.SafeDirs = &kept
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
	if w := pol.Permission.IncoherentCeiling(); w != "" && (len(permMax) > 0 || len(permRules) > 0 || len(limits) > 0) {
		fmt.Fprintln(os.Stderr, "warning: "+w+".")
	}
	if err := policy.Save(path, pol); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, filesPolicySummary(pol))
	fmt.Fprintln(os.Stderr, fileWritePolicySummary(pol))
	fmt.Fprintln(os.Stderr, terminalPolicySummary(pol))
	fmt.Fprintln(os.Stderr, commandShellPolicySummary(pol))
	fmt.Fprintln(os.Stderr, agentToolsPolicySummary(pol))
	fmt.Fprintln(os.Stderr, projectConfigPolicySummary(pol, false))
	fmt.Fprintln(os.Stderr, backgroundSubagentsPolicySummary(pol))
	fmt.Fprintln(os.Stderr, permissionPolicySummary(pol))
	return nil
}
