package trayapp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"galopin/internal/appstatus"
)

// Runner runs a command with extra environment (KEY=VALUE) on top of the
// process's, feeding each output line to onLine (may be nil), and returns the
// combined output. Tests swap it for a fake.
type Runner func(ctx context.Context, name string, args, env []string, onLine func(string)) (string, error)

// ExecRunner is the real Runner.
func ExecRunner(ctx context.Context, name string, args, env []string, onLine func(string)) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), env...)
	pr, pw, err := os.Pipe()
	if err != nil {
		return "", err
	}
	cmd.Stdout, cmd.Stderr = pw, pw
	if err := cmd.Start(); err != nil {
		pr.Close()
		pw.Close()
		return "", err
	}
	pw.Close()
	var all strings.Builder
	sc := bufio.NewScanner(pr)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		all.WriteString(sc.Text() + "\n")
		if onLine != nil {
			onLine(sc.Text())
		}
	}
	pr.Close()
	err = cmd.Wait()
	return all.String(), err
}

// App is the tray's doing-things half.
type App struct {
	Layout Layout
	Paths  Paths
	UID    int
	Run    Runner
	Now    func() time.Time
	// Getenv reads the app's environment (nil: os.Getenv). Only GALOPIN_MCP_CONFIG is read.
	Getenv func(string) string
}

func (a *App) env() []string { return []string{"PATH=" + a.Layout.PathEnv(a.Paths.Home)} }

// Snapshot gathers what the menu depends on. Nothing it reads holds a secret
// except credentials.json, from which only the Cerea origin is taken.
func (a *App) Snapshot(ctx context.Context, busy bool) Input {
	in := Input{Now: a.Now(), Busy: busy}
	creds := filepath.Join(a.Paths.StateDir(), "credentials.json")
	if body, err := os.ReadFile(creds); err == nil {
		in.HasCredentials = true
		var c struct {
			Cerea string `json:"cerea_origin"`
		}
		_ = json.Unmarshal(body, &c)
		in.CredsCerea = c.Cerea
	}
	in.Status, in.StatusOK = readStatus(a.Paths.StateDir())
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := a.Run(cctx, "launchctl", LaunchctlPrint(a.UID), nil, nil)
	in.ServiceLoaded = err == nil
	_, err = os.Stat(a.Paths.TrayPlist())
	in.LoginItem = err == nil
	return in
}

func readStatus(stateDir string) (appstatus.Status, bool) {
	s, err := appstatus.Read(stateDir)
	return s, err == nil
}

// StartService writes the service's LaunchAgent file if it is missing or out of
// date (the app may have moved) and loads it. Loading a loaded job is a no-op.
func (a *App) StartService(ctx context.Context) error {
	if err := a.writeFile(a.Paths.ServicePlist(), ServicePlistXML(a.Layout, a.Paths)); err != nil {
		return err
	}
	if _, err := a.Run(ctx, "launchctl", LaunchctlPrint(a.UID), nil, nil); err == nil {
		return nil
	}
	out, err := a.Run(ctx, "launchctl", LaunchctlBootstrap(a.UID, a.Paths.ServicePlist()), nil, nil)
	if err != nil {
		return errors.New(FriendlyError("Starting", out))
	}
	return nil
}

// StopService unloads the service (it runs again when the app next starts it).
func (a *App) StopService(ctx context.Context) error {
	out, err := a.Run(ctx, "launchctl", LaunchctlBootout(a.UID), nil, nil)
	if err != nil {
		return errors.New(FriendlyError("Stopping", out))
	}
	return nil
}

// RestartService makes a running service pick up new credentials.
func (a *App) RestartService(ctx context.Context) error {
	_, _ = a.Run(ctx, "launchctl", LaunchctlBootout(a.UID), nil, nil)
	return a.StartService(ctx)
}

// SetLoginItem turns "Start at login" on or off.
func (a *App) SetLoginItem(on bool) error {
	if !on {
		if err := os.Remove(a.Paths.TrayPlist()); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return a.writeFile(a.Paths.TrayPlist(), TrayPlistXML(a.Layout))
}

// InstallAgents is what the installer asks for: both LaunchAgent files, the
// login item on. It loads nothing; the app does that when it opens.
func (a *App) InstallAgents() error {
	if err := a.writeFile(a.Paths.ServicePlist(), ServicePlistXML(a.Layout, a.Paths)); err != nil {
		return err
	}
	return a.SetLoginItem(true)
}

func (a *App) writeFile(path, body string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(a.Paths.Log()), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(body), 0o644)
}

// Pair signs this Mac in to a Cerea with the device flow. showCode is called
// once, when the sign-in page and code are known (galopin opens the page
// itself). On success the service is restarted so it uses the new pairing.
func (a *App) Pair(ctx context.Context, address string, agent bool, showCode func(SignIn)) error {
	var s SignIn
	shown := false
	onLine := func(l string) {
		if ParseSignInLine(l, &s) && s.Code != "" && !shown {
			shown = true
			showCode(s)
		}
	}
	out, err := a.Run(ctx, a.Layout.CLI(), PairArgs(address, agent), a.env(), onLine)
	if err != nil {
		return errors.New(FriendlyError("Pairing", out))
	}
	return a.RestartService(ctx)
}

// SetupBrowser sets the browser runtime up and offers it to Cerea, with the
// bundled Node first on PATH.
func (a *App) SetupBrowser(ctx context.Context) error {
	if out, err := a.Run(ctx, a.Layout.CLI(), BrowserSetupArgs(), a.env(), nil); err != nil {
		return errors.New(FriendlyError("Setting up the browser", out))
	}
	if out, err := a.Run(ctx, a.Layout.CLI(), BrowserEnableArgs(), a.env(), nil); err != nil {
		return errors.New(FriendlyError("Turning the browser on", out))
	}
	return nil
}

// AppleScriptQuote makes s safe inside an AppleScript string literal.
func AppleScriptQuote(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}

// AskAddress shows a small native prompt; ok is false when the user cancels.
func (a *App) AskAddress(ctx context.Context, def string) (string, bool) {
	if def == "" {
		def = "https://"
	}
	script := `text returned of (display dialog "Address of your Cerea:" default answer ` + AppleScriptQuote(def) +
		` with title ` + AppleScriptQuote(AppName) + ` buttons {"Cancel", "Pair"} default button "Pair")`
	out, err := a.Run(ctx, "osascript", []string{"-e", script}, nil, nil)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(out), true
}

// Alert shows a message with an OK button.
func (a *App) Alert(ctx context.Context, msg string) {
	script := `display dialog ` + AppleScriptQuote(msg) + ` with title ` + AppleScriptQuote(AppName) +
		` buttons {"OK"} default button "OK"`
	_, _ = a.Run(ctx, "osascript", []string{"-e", script}, nil, nil)
}

// ShowCode tells the user the code to type on the sign-in page. It blocks
// until the dialog is closed, so call it from its own goroutine.
func (a *App) ShowCode(ctx context.Context, s SignIn) {
	a.Alert(ctx, fmt.Sprintf("A web page opened for you to sign in. If it asks for a code, type:\n\n%s", s.Code))
}

// OpenURL opens a web address in the default browser.
func (a *App) OpenURL(ctx context.Context, u string) {
	_, _ = a.Run(ctx, "open", []string{u}, nil, nil)
}

// ShowLogs opens the log in Console.
func (a *App) ShowLogs(ctx context.Context) {
	_, _ = a.Run(ctx, "open", []string{"-a", "Console", a.Paths.Log()}, nil, nil)
}

// FirstRun does, once per Mac, what the installer would have done for a user
// who opened the downloaded zip instead: turn "Start at login" on and write the
// service's LaunchAgent file. It reports whether this was the first run.
func (a *App) FirstRun() (bool, error) {
	marker := filepath.Join(a.Paths.StateDir(), "tray-first-run")
	if _, err := os.Stat(marker); err == nil {
		return false, nil
	}
	if err := a.InstallAgents(); err != nil {
		return true, err
	}
	return true, os.WriteFile(marker, []byte("1\n"), 0o600)
}

// EditedNote is shown after the connectors file is opened.
const EditedNote = "Saved changes are picked up automatically."

// mcpTemplate is the minimal valid mcp.json, so there is something to open.
const mcpTemplate = `{"mcpServers": {}}` + "\n"

// McpConfigPath is the connectors file galopin reads: $GALOPIN_MCP_CONFIG
// (a leading ~ is the home folder, a relative path is taken from the home
// folder here) or <state dir>/mcp.json.
func (a *App) McpConfigPath() string {
	getenv := a.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	raw := getenv("GALOPIN_MCP_CONFIG")
	if raw == "" {
		return filepath.Join(a.Paths.StateDir(), "mcp.json")
	}
	if raw == "~" || strings.HasPrefix(raw, "~/") {
		raw = filepath.Join(a.Paths.Home, raw[1:])
	}
	if !filepath.IsAbs(raw) {
		raw = filepath.Join(a.Paths.Home, raw)
	}
	return raw
}

// EditConnectors makes sure the connectors file exists (created 0600 from a
// small template when missing, never overwritten) and opens it in TextEdit.
func (a *App) EditConnectors(ctx context.Context) error {
	path := a.McpConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	switch {
	case err == nil:
		_, werr := f.WriteString(mcpTemplate)
		if cerr := f.Close(); werr == nil {
			werr = cerr
		}
		if werr != nil {
			return werr
		}
	case !os.IsExist(err):
		return err
	}
	if out, err := a.Run(ctx, "open", []string{"-e", path}, nil, nil); err != nil {
		return errors.New(FriendlyError("Opening the connectors file", out))
	}
	return nil
}
