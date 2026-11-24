package main

// `galopin setup TOOL` (backlog G20): make `galopin launch` the way you start a
// tool, without touching the tool's own configuration and without installing a
// service.
//
//   galopin setup claude              installs 'claude-galopin' beside galopin
//   galopin setup claude --default    also a shim named 'claude' in a galopin-owned
//                                     directory the user puts first on PATH
//   galopin setup goose --desktop     writes the provider into goose's own config
//                                     (desktop apps, editor plug-ins)
//   galopin setup TOOL --remove       deletes what setup created, nothing else
//
// Every file setup writes starts with a marker line; a file without it is never
// overwritten or removed.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

var setupTools = []string{"opencode", "goose", "vibe", "claude"}

const setupUsage = `galopin setup — make 'galopin launch' your default way to start a tool.

Usage:
  galopin setup TOOL [--default] [--remove]
  galopin setup TOOL --desktop [--default] [--no-connectors] [--remove] [--creds PATH] [--state-dir PATH]

TOOL is opencode, goose, vibe or claude.

setup TOOL
  Installs a small command, TOOL-galopin (for example claude-galopin), in galopin's
  install directory (the one holding the galopin binary; GALOPIN_INSTALL_DIR
  overrides). It runs 'galopin launch TOOL' with your arguments, so the tool goes
  through the gateway, with the Cerea connectors and the same per-launch proxy
  secret as 'galopin launch'. Nothing in the tool's own configuration is touched and
  no service is installed.
  --default   Also install a shim named TOOL itself in a directory galopin owns
              (<install dir>/galopin-shims). Put that directory first on your PATH
              and typing the tool's name goes through the gateway: setup prints the
              exact line to add; it never edits your shell files. Inside that shim
              galopin finds the real tool by leaving its own directory out of PATH.
  --remove    Deletes the TOOL-galopin command and the shim, and the directory when
              it is empty: only files setup wrote (each starts with a marker line).
  A file of the same name that setup did not write is never overwritten or removed.
  Running it again is safe.

setup TOOL --desktop
  For desktop apps and editor plug-ins that need an HTTP provider: writes galopin's
  provider into the tool's own configuration (today: goose Desktop, the goose CLI and
  the goose editor extensions) with Cerea's models and billing through galopin's local
  proxy, and the "Cerea connectors" extension. It works only while galopin's proxy
  runs ('galopin run' left open, or the service); setup offers 'galopin service
  install' as a next step and never installs it. Here --default makes the provider
  goose's default provider and first model; --no-connectors leaves the extension out;
  --remove undoes it. claude has no desktop provider to write: use plain setup.
  --creds / --state-dir: as for 'galopin run'.

--default has two meanings, by mode: without --desktop it installs the TOOL shim for
your PATH; with --desktop it makes the provider the tool's default provider.

Calls the tool makes through the Cerea connectors are governed by the tool's own
approval rules (convenience, not enforcement): galopin's Plan/Ask/Allow modes and
review log do not apply to a tool you start yourself.
`

const setupMarker = "# galopin-setup:"

func runSetup(args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "-help" || args[0] == "--help" {
		fmt.Fprint(os.Stderr, setupUsage)
		if len(args) == 0 {
			return exitError{code: 2, err: errors.New("setup: which tool? (" + strings.Join(setupTools, ", ") + ")")}
		}
		return nil
	}
	tool, rest := args[0], args[1:]
	if !isSetupTool(tool) {
		return exitError{code: 2, err: fmt.Errorf("setup: unknown tool %q (supported: %s)", tool, strings.Join(setupTools, ", "))}
	}
	fs := flagSetWithHelp("setup "+tool, setupUsage)
	def := fs.Bool("default", false, "")
	remove := fs.Bool("remove", false, "")
	desktop := fs.Bool("desktop", false, "")
	noConnectors := fs.Bool("no-connectors", false, "")
	credsPath := fs.String("creds", "", "")
	stateFlag := fs.String("state-dir", "", "")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	if !*desktop && (*noConnectors || *credsPath != "" || *stateFlag != "") {
		return errors.New("--no-connectors, --creds and --state-dir belong to --desktop; plain setup writes only the command")
	}
	if !*desktop {
		if *remove && *def {
			return errors.New("--remove takes no other option")
		}
		return setupLaunch(os.Stderr, tool, *def, *remove)
	}
	return setupDesktop(tool, *def, *remove, *noConnectors, *credsPath, *stateFlag)
}

func isSetupTool(t string) bool {
	for _, s := range setupTools {
		if s == t {
			return true
		}
	}
	return false
}

// --- launch by default -------------------------------------------------------

// setupInstallDir is where TOOL-galopin goes: GALOPIN_INSTALL_DIR, else the
// directory of this galopin binary (~/.local/bin for the installer).
func setupInstallDir() (string, error) {
	if d := os.Getenv("GALOPIN_INSTALL_DIR"); d != "" {
		return filepath.Abs(d)
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	return filepath.Dir(exe), nil
}

// setupShimsDirName is the galopin-owned directory of --default shims.
const setupShimsDirName = "galopin-shims"

func setupShimsDir() (string, error) {
	d, err := setupInstallDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, setupShimsDirName), nil
}

// setupGalopinPath is the galopin binary the commands exec.
func setupGalopinPath() (string, error) {
	if d := os.Getenv("GALOPIN_INSTALL_DIR"); d != "" {
		if p := filepath.Join(d, "galopin"); fileExists(p) {
			abs, err := filepath.Abs(p)
			return abs, err
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	return exe, nil
}

// shimScript is the body of both kinds of command. The marker is its second
// line (hasSetupMarker looks only there); the shims directory is recorded in it
// at setup time, so launch never has to re-derive it from where the binary
// happens to live (a symlink, a Homebrew Cellar path). The user's arguments
// follow "--": they belong to the tool, never to galopin's own flag parsing.
func shimScript(galopin, tool, shimsDir string) string {
	q := func(v string) string { return "'" + strings.ReplaceAll(v, "'", `'\''`) + "'" }
	return "#!/bin/sh\n" +
		setupMarker + " " + tool + " (written by 'galopin setup " + tool + "'; remove with 'galopin setup " + tool + " --remove')\n" +
		"GALOPIN_SHIMS_DIR=" + q(shimsDir) + "\nexport GALOPIN_SHIMS_DIR\n" +
		"exec " + q(galopin) + " launch " + tool + ` -- "$@"` + "\n"
}

// hasSetupMarker is true when content is a file setup wrote: the marker opens
// its second line.
func hasSetupMarker(content []byte) bool {
	lines := strings.SplitN(string(content), "\n", 3)
	return len(lines) >= 2 && strings.HasPrefix(lines[1], setupMarker)
}

// isSetupShim reads the head of path and says whether it is a file setup wrote.
func isSetupShim(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	head := make([]byte, 512)
	n, _ := f.Read(head)
	return hasSetupMarker(head[:n])
}

// writeOwnedFile writes body at path unless a file there is not ours.
func writeOwnedFile(path, body string) (changed bool, err error) {
	if old, rerr := os.ReadFile(path); rerr == nil {
		if !hasSetupMarker(old) {
			return false, fmt.Errorf("%s exists and was not written by galopin: leaving it alone (remove or rename it, then run setup again)", path)
		}
		if string(old) == body {
			return false, nil
		}
	} else if !os.IsNotExist(rerr) {
		return false, rerr
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, err
	}
	if err := writeFileAtomic(path, []byte(body), 0o755); err != nil {
		return false, err
	}
	return true, os.Chmod(path, 0o755)
}

// removeOwnedFile deletes path only when it carries our marker.
func removeOwnedFile(path string) (removed bool, err error) {
	old, rerr := os.ReadFile(path)
	if os.IsNotExist(rerr) {
		return false, nil
	}
	if rerr != nil {
		return false, rerr
	}
	if !hasSetupMarker(old) {
		return false, fmt.Errorf("%s was not written by galopin: left in place", path)
	}
	return true, os.Remove(path)
}

func setupLaunch(out io.Writer, tool string, makeDefault, remove bool) error {
	dir, err := setupInstallDir()
	if err != nil {
		return err
	}
	shims := filepath.Join(dir, setupShimsDirName)
	cmdPath := filepath.Join(dir, tool+"-galopin")
	shimPath := filepath.Join(shims, tool)
	if remove {
		var firstErr error
		removedAny := false
		for _, p := range []string{cmdPath, shimPath} {
			ok, err := removeOwnedFile(p)
			if err != nil && firstErr == nil {
				firstErr = err
			}
			if ok {
				removedAny = true
				fmt.Fprintf(out, "removed %s\n", p)
			}
		}
		_ = os.Remove(shims) // only when empty
		if !removedAny && firstErr == nil {
			fmt.Fprintf(out, "nothing to remove: 'galopin setup %s' had not been run here.\n", tool)
		}
		if removedAny {
			fmt.Fprintln(out, "If you added the galopin-shims line to your shell profile, remove it there too.")
		}
		return firstErr
	}
	galopin, err := setupGalopinPath()
	if err != nil {
		return err
	}
	body := shimScript(galopin, tool, shims)
	oldCmd, hadCmd := []byte(nil), false
	if b, rerr := os.ReadFile(cmdPath); rerr == nil {
		oldCmd, hadCmd = b, true
	}
	if makeDefault {
		// Check both targets before writing either.
		for _, p := range []string{cmdPath, shimPath} {
			if old, rerr := os.ReadFile(p); rerr == nil && !hasSetupMarker(old) {
				return fmt.Errorf("%s exists and was not written by galopin: leaving it alone (remove or rename it, then run setup again)", p)
			}
		}
	}
	changed, err := writeOwnedFile(cmdPath, body)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "%s %s\n", verb(changed), cmdPath)
	fmt.Fprintf(out, "Run '%s-galopin' instead of '%s': same tool, through the gateway (and Cerea's connectors). Its own configuration is untouched.\n", tool, tool)
	if makeDefault {
		changed, err := writeOwnedFile(shimPath, body)
		if err != nil {
			// The pair is all or nothing: put the command back as it was.
			if hadCmd {
				_ = writeFileAtomic(cmdPath, oldCmd, 0o755)
			} else {
				_ = os.Remove(cmdPath)
			}
			return err
		}
		fmt.Fprintf(out, "%s %s\n", verb(changed), shimPath)
		fmt.Fprintln(out, "To make typing '"+tool+"' go through the gateway, put that directory first on your PATH (galopin does not edit your shell files). Add this line to your shell profile:")
		fmt.Fprintf(out, "\n  export PATH=\"%s:$PATH\"\n\n", shims)
		if pathHasFirst(originalPath, shims) {
			fmt.Fprintln(out, "It is already first on your PATH in this shell.")
		} else {
			fmt.Fprintln(out, "Then open a new shell (or run 'hash -r'). Undo with 'galopin setup "+tool+" --remove'.")
		}
	} else {
		fmt.Fprintf(out, "To make plain '%s' go through the gateway too: 'galopin setup %s --default'.\n", tool, tool)
	}
	fmt.Fprintln(out, "Calls to the Cerea connectors follow the tool's own approval rules (convenience, not enforcement). No service was installed; 'galopin run' is not needed for the gateway.")
	return nil
}

func verb(changed bool) string {
	if changed {
		return "wrote"
	}
	return "already in place:"
}

func pathHasFirst(path, dir string) bool {
	first, _, _ := strings.Cut(path, string(os.PathListSeparator))
	return first != "" && filepath.Clean(first) == filepath.Clean(dir)
}

// launchDepthEnv is set by 'galopin launch' for the tool it starts: a launch
// inside a launch (a --default shim found again from inside the tool) is refused
// instead of recursing.
const launchDepthEnv = "GALOPIN_LAUNCH_DEPTH"

// shimsDirEnv is how a shim tells galopin which directory it was set up in.
const shimsDirEnv = "GALOPIN_SHIMS_DIR"

// sameDir reports whether two paths are the same directory, through symlinks.
func sameDir(a, b string) bool {
	ia, err1 := os.Stat(a)
	ib, err2 := os.Stat(b)
	if err1 == nil && err2 == nil {
		return os.SameFile(ia, ib)
	}
	ra, e1 := filepath.EvalSymlinks(a)
	rb, e2 := filepath.EvalSymlinks(b)
	if e1 == nil && e2 == nil {
		return ra == rb
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

// stripShimsFromPath removes galopin's shim directory from PATH, in this
// process (and so in everything it starts), for EVERY galopin command: a
// --default shim named 'claude' or 'opencode' otherwise gets resolved as the
// real tool (by launch, or by the supervised engine under 'run') and loops. An
// entry goes when it is the directory the shim recorded (GALOPIN_SHIMS_DIR), the
// one beside this binary, the same directory through a symlink, or is named
// galopin-shims (galopin's own name for it).
// originalPath is PATH as the user's shell gave it, before stripShimsFromPath
// (called first thing in main) removed the shims directory: setup needs it to say
// whether that directory is already first.
var originalPath = os.Getenv("PATH")

func stripShimsFromPath() {
	var known []string
	if d := os.Getenv(shimsDirEnv); d != "" {
		known = append(known, d)
	}
	if d, err := setupShimsDir(); err == nil {
		known = append(known, d)
	}
	var keep []string
	for _, e := range filepath.SplitList(os.Getenv("PATH")) {
		drop := e != "" && filepath.Base(filepath.Clean(e)) == setupShimsDirName
		for _, k := range known {
			if e != "" && sameDir(e, k) {
				drop = true
			}
		}
		if !drop {
			keep = append(keep, e)
		}
	}
	_ = os.Setenv("PATH", strings.Join(keep, string(os.PathListSeparator)))
}

// refuseSetupShim is the second line of defence: a resolved tool binary that is
// one of setup's shims would exec galopin again.
func refuseSetupShim(tool, bin string) error {
	if isSetupShim(bin) {
		return fmt.Errorf("%s resolves to %s, a shim 'galopin setup' wrote (it would start galopin again): pass --%s PATH to the real %s, or take the shims directory off your PATH", tool, bin, tool, tool)
	}
	return nil
}

// --- desktop apps ------------------------------------------------------------

// desktopSetup is how one tool's desktop app or editor plug-in gets galopin's
// provider: write it into the tool's own configuration, or take it out again.
type desktopSetup struct {
	apply  func(ctx context.Context, creds *credentials, credsPath, stateDir string, makeDefault, connectors bool) error
	remove func(stateDir string) error
}

var desktopSetups = map[string]desktopSetup{
	"goose": {
		apply: func(ctx context.Context, creds *credentials, credsPath, stateDir string, makeDefault, connectors bool) error {
			cfgDir, err := gooseUserConfigDir()
			if err != nil {
				return err
			}
			return gooseSetup(ctx, creds, credsPath, stateDir, cfgDir, makeDefault, connectors)
		},
		remove: func(stateDir string) error {
			cfgDir, err := gooseUserConfigDir()
			if err != nil {
				return err
			}
			return gooseSetupRemove(cfgDir, stateDir)
		},
	},
}

func setupDesktop(tool string, makeDefault, remove, noConnectors bool, credsFlag, stateFlag string) error {
	d, ok := desktopSetups[tool]
	if !ok {
		switch tool {
		case "claude":
			return fmt.Errorf("setup claude --desktop: Claude Code has no desktop provider to write (its apps take no custom HTTP provider); use 'galopin setup claude' for a claude-galopin command")
		default:
			return fmt.Errorf("setup %s --desktop: no desktop app or editor plug-in of %s is wired to galopin's proxy yet; use 'galopin setup %s' for a %s-galopin command", tool, tool, tool, tool)
		}
	}
	if remove && (makeDefault || noConnectors) {
		return errors.New("--remove takes no other option")
	}
	path := credsFlag
	if path == "" {
		p, err := resolveDefaultCredsPath()
		if err != nil {
			return err
		}
		path = p
	}
	stateDir := resolveStateDir(stateFlag, path)
	if remove {
		return d.remove(stateDir)
	}
	creds, err := loadCredentials(path)
	if err != nil {
		return err
	}
	if err := d.apply(context.Background(), creds, path, stateDir, makeDefault, !noConnectors); err != nil {
		return err
	}
	desktopServiceOffer(os.Stderr, tool)
	return nil
}

// desktopServiceOffer says plainly that a desktop app works only while the
// proxy runs, and offers the service as an explicit next step.
func desktopServiceOffer(out io.Writer, tool string) {
	fmt.Fprintf(out, "\nNote: %s reaches the gateway through galopin's local proxy, so it works only while that runs: 'galopin run' left open in a terminal, or the service.\n", tool)
	if svc, err := realServiceEnv(); err == nil {
		if _, serr := os.Stat(svc.unitPath()); serr == nil || fileExists(svc.plistPath()) {
			fmt.Fprintln(out, "The galopin service is installed here ('galopin status' shows whether it runs).")
			return
		}
	}
	fmt.Fprintln(out, "To keep it running at login without a terminal, run: galopin service install   (optional; setup did not install it, and 'galopin service uninstall' removes it)")
}
