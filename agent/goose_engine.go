package main

// goose as a supported engine (ADR 0110): galopin runs `goose acp` through its
// ACP backend with a config galopin writes, never the user's.
//
//	<state dir>/goose/                GOOSE_PATH_ROOT of the supervised goose
//	  config/config.yaml              provider, model, approve mode, telemetry off
//	  config/custom_providers/galopin.json   OpenAI-compatible, galopin's proxy + secret
//	  data/sessions -> the user's own goose session store (amendment: sessions are
//	                  shared with goose Desktop and the editor extensions)
//	  state/                          logs
//
// The session store is the one thing deliberately shared: everything else goose
// reads (config, extensions, secrets) is galopin's.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	backendacp "galopin/internal/backend/acp"
	"galopin/internal/policy"
	"galopin/packaging"
)

const (
	engineOpencode = "opencode"
	engineGoose    = "goose"

	// backendGoose is run's internal backend kind for a goose machine.
	backendGoose = "goose"

	// goose's provider id for galopin's proxy, in the engine's own config and
	// in the user's (galopin goose setup).
	gooseProviderID = "galopin"
	// The ACP agent modes: approve asks before every tool call, chat has no
	// tools. Every other mode skips asks and is hidden (acp Config.HiddenModes).
	gooseModeApprove = "approve"
)

// gooseHiddenModes are goose's modes that stop asking (auto: never; smart_approve:
// only for "sensitive" tools by goose's own judgement).
var gooseHiddenModes = []string{"auto", "smart_approve"}

func validEngine(e string) bool { return e == "" || e == engineOpencode || e == engineGoose }

// gooseRootFor is the supervised goose's GOOSE_PATH_ROOT, beside the credentials.
func gooseRootFor(credsPath string) string {
	return filepath.Join(filepath.Dir(credsPath), "goose")
}

// gooseModel is one entry of the generated provider's models list.
type gooseModel struct {
	ID      string
	Context int
}

// gooseModels turns the gateway catalogue into goose's models (chat models
// only, sorted by id so the file is stable).
func gooseModels(models []gatewayModel) []gooseModel {
	var out []gooseModel
	for _, m := range models {
		if m.ID == "" || (m.Kind != "" && m.Kind != "chat") {
			continue
		}
		ctx := m.ContextWindow
		if ctx <= 0 {
			ctx = defaultContextWindow
		}
		out = append(out, gooseModel{ID: m.ID, Context: ctx})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// gooseProviderSpec is what goose's declarative custom-provider file holds.
// The file is goose's own format (a custom_providers/<name>.json, goose 1.57).
type gooseProviderSpec struct {
	Name                    string            `json:"name"`
	Engine                  string            `json:"engine"`
	DisplayName             string            `json:"display_name"`
	Description             string            `json:"description"`
	BaseURL                 string            `json:"base_url"`
	Models                  []gooseModelSpec  `json:"models"`
	SupportsStreaming       bool              `json:"supports_streaming"`
	RequiresAuth            bool              `json:"requires_auth"`
	Headers                 map[string]string `json:"headers,omitempty"`
	SessionIDHeaderOverride string            `json:"session_id_header_override,omitempty"`
}

type gooseModelSpec struct {
	Name         string `json:"name"`
	ContextLimit int    `json:"context_limit"`
}

// gooseProviderJSON renders the provider file for the proxy at shimAddr. The
// secret rides as an Authorization header (requires_auth false: goose then asks
// for no key), so the one file is all any goose needs. sessionHeader makes goose
// send its own session id as x-session-id, which the proxy uses to tag usage by
// the exact session; it is for the engine's file only (the user's own sessions
// are not Cerea's).
func gooseProviderJSON(shimAddr, secret string, models []gooseModel, sessionHeader bool) ([]byte, error) {
	spec := gooseProviderSpec{
		Name:              gooseProviderID,
		Engine:            "openai",
		DisplayName:       "Cerea (galopin proxy)",
		Description:       "Models and billing of the Cerea gateway, through galopin's local proxy. galopin must be running ('galopin run' or 'galopin serve').",
		BaseURL:           "http://" + shimAddr + "/v1/chat/completions",
		SupportsStreaming: true,
		RequiresAuth:      false,
		Headers:           map[string]string{"Authorization": "Bearer " + secret},
	}
	if sessionHeader {
		spec.SessionIDHeaderOverride = "x-session-id"
	}
	for _, m := range models {
		spec.Models = append(spec.Models, gooseModelSpec{Name: m.ID, ContextLimit: m.Context})
	}
	if len(spec.Models) == 0 {
		spec.Models = []gooseModelSpec{{Name: placeholderModelID, ContextLimit: defaultContextWindow}}
	}
	body, err := json.MarshalIndent(spec, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(body, '\n'), nil
}

func gooseDefaultModel(models []gooseModel) string {
	if len(models) == 0 {
		return placeholderModelID
	}
	return models[0].ID
}

// gooseEngineConfigYAML is the supervised goose's config.yaml. GOOSE_MODE is
// also set in the environment (goose_engine.go gooseEnv): both say approve.
func gooseEngineConfigYAML(defaultModel string) string {
	return "# Written by galopin (enroll / run / models refresh); edits are overwritten.\n" +
		"GOOSE_PROVIDER: " + gooseProviderID + "\n" +
		"GOOSE_MODEL: " + defaultModel + "\n" +
		"GOOSE_MODE: " + gooseModeApprove + "\n" +
		"GOOSE_DISABLE_KEYRING: true\n" +
		"GOOSE_TELEMETRY_ENABLED: false\n"
}

// writeGooseEngineConfig writes (or rewrites) the supervised goose's config
// under root from the credentials' proxy and the discovered models, and makes
// its session store the user's own.
func writeGooseEngineConfig(root string, creds *credentials, models []gatewayModel) error {
	if creds.ShimPort == 0 || creds.ShimSecret == "" {
		return fmt.Errorf("the credential file records no proxy port or secret: re-run 'galopin enroll'")
	}
	gm := gooseModels(models)
	provider, err := gooseProviderJSON(fmt.Sprintf("127.0.0.1:%d", creds.ShimPort), creds.ShimSecret, gm, true)
	if err != nil {
		return err
	}
	for _, d := range []string{"config/custom_providers", "data", "state"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o700); err != nil {
			return err
		}
	}
	if err := writeFileAtomic(filepath.Join(root, "config", "custom_providers", gooseProviderID+".json"), provider, 0o600); err != nil {
		return fmt.Errorf("writing goose provider: %w", err)
	}
	if err := writeFileAtomic(filepath.Join(root, "config", "config.yaml"), []byte(gooseEngineConfigYAML(gooseDefaultModel(gm))), 0o600); err != nil {
		return fmt.Errorf("writing goose config: %w", err)
	}
	return linkGooseSessions(root)
}

// gooseUserDataDir is where the user's own goose keeps its data: the session
// store is <it>/sessions. It follows goose's own rule: GOOSE_PATH_ROOT/data,
// else XDG_DATA_HOME or ~/.local/share, then "goose".
func gooseUserDataDir() (string, error) {
	if r := os.Getenv("GOOSE_PATH_ROOT"); r != "" {
		return filepath.Join(r, "data"), nil
	}
	if x := os.Getenv("XDG_DATA_HOME"); x != "" && filepath.IsAbs(x) {
		return filepath.Join(x, "goose"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "goose"), nil
}

// gooseUserConfigDir is the user's own goose config directory (setup writes
// there; the engine never does).
func gooseUserConfigDir() (string, error) {
	if r := os.Getenv("GOOSE_PATH_ROOT"); r != "" {
		return filepath.Join(r, "config"), nil
	}
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" && filepath.IsAbs(x) {
		return filepath.Join(x, "goose"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "goose"), nil
}

// linkGooseSessions makes <root>/data/sessions a symlink to the user's own
// session store, so galopin's sessions and the user's are one list.
func linkGooseSessions(root string) error {
	userData, err := gooseUserDataDir()
	if err != nil {
		return err
	}
	target := filepath.Join(userData, "sessions")
	if err := os.MkdirAll(target, 0o700); err != nil {
		return fmt.Errorf("creating the goose session store %s: %w", target, err)
	}
	link := filepath.Join(root, "data", "sessions")
	if cur, err := os.Readlink(link); err == nil {
		if cur == target {
			return nil
		}
		if err := os.Remove(link); err != nil {
			return err
		}
	} else if _, statErr := os.Lstat(link); statErr == nil {
		// A real directory (an isolated store from before): keep it aside.
		if err := os.Rename(link, link+".isolated-"+time.Now().Format("20060102-150405")); err != nil {
			return err
		}
	}
	return os.Symlink(target, link)
}

// gooseStripPrefixes are the inherited environment variables that would hand
// goose another provider's credentials or configuration; the engine's provider
// is galopin's proxy and nothing else.
var gooseStripPrefixes = []string{
	"GOOSE_", "OPENAI_", "ANTHROPIC_", "AZURE_OPENAI_", "DATABRICKS_", "GEMINI_", "GOOGLE_API_KEY",
	"OLLAMA_", "OPENROUTER_", "XAI_", "GROQ_", "MISTRAL_", "TETRATE_", "LITELLM_", "SNOWFLAKE_",
	"VENICE_", "KIMI_", "DEEPSEEK_", "CEREBRAS_", "GITHUB_COPILOT_",
}

// gooseEnv is the supervised goose's environment: the caller's, with every
// provider credential and GOOSE_* setting removed and galopin's put in.
func gooseEnv(root string, base []string) []string {
	out := make([]string, 0, len(base)+6)
	for _, kv := range base {
		name, _, _ := strings.Cut(kv, "=")
		strip := false
		for _, p := range gooseStripPrefixes {
			if strings.HasPrefix(name, p) {
				strip = true
				break
			}
		}
		if !strip {
			out = append(out, kv)
		}
	}
	return append(out,
		"GOOSE_PATH_ROOT="+root,
		"GOOSE_MODE="+gooseModeApprove,
		"GOOSE_DISABLE_KEYRING=1",
		"GOOSE_TELEMETRY_OFF=1",
		"GOOSE_PROVIDER="+gooseProviderID,
	)
}

// gooseEnvOverride names the one way to run a goose other than the verified copy.
const gooseEnvOverride = "GALOPIN_GOOSE_BIN"

// gooseInstallDirName is where the install line puts the pinned goose, beside
// galopin and in a directory of galopin's own: it never replaces a goose the
// user installed themselves (~/.local/bin/goose, Homebrew).
const gooseInstallDirName = "galopin-goose"

// gooseBinary is the goose galopin runs: the verified, pinned copy the install
// line put in galopin's own directory. A goose from PATH is not used, whatever it
// is. An override is possible only by setting GALOPIN_GOOSE_BIN, which `run` logs
// loudly (see gooseOverrideWarning).
func gooseBinary() (string, error) {
	if b := os.Getenv(gooseEnvOverride); b != "" {
		return b, nil
	}
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), gooseInstallDirName, "goose")
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p, nil
		}
	}
	return "", fmt.Errorf("goose %s is not installed for galopin: run the install line with '--engine goose' (curl ... | sh -s -- --engine goose); a goose elsewhere is used only if you set %s", packaging.GooseVersion(), gooseEnvOverride)
}

// gooseOverrideWarning is non-empty when goose comes from the override, and says so.
func gooseOverrideWarning() string {
	if b := os.Getenv(gooseEnvOverride); b != "" {
		return fmt.Sprintf("WARNING: running goose from %s=%s, not the verified pinned copy galopin installs. It is not checked by galopin and may behave differently (permissions, modes, protocol).", gooseEnvOverride, b)
	}
	return ""
}

// gooseInstalledNote says whether goose is there and whether it is the pinned release.
func gooseInstalledNote() string {
	bin, err := gooseBinary()
	if err != nil {
		return "warning: " + err.Error()
	}
	if v := gooseVersionOf(bin); v != "" && v != packaging.GooseVersion() {
		return fmt.Sprintf("warning: %s is goose %s; galopin is tested with %s", bin, v, packaging.GooseVersion())
	}
	return "goose found at " + bin + "."
}

func gooseVersionOf(bin string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "--version").Output()
	if err != nil {
		return ""
	}
	f := strings.Fields(string(out))
	if len(f) == 0 {
		return ""
	}
	return f[len(f)-1]
}

// startGooseBackend starts the ACP backend over `goose acp` with galopin's
// config and the session guards of ADR 0110.
func startGooseBackend(ctx context.Context, opts *runOptions, credsPath, stateDir string, pol policy.Policy, protect func(string, string) bool, logf func(string, ...any)) (runningBackend, error) {
	bin, err := gooseBinary()
	if err != nil {
		return nil, err
	}
	if w := gooseOverrideWarning(); w != "" {
		logf("%s", w)
	}
	if v := gooseVersionOf(bin); v != "" && v != packaging.GooseVersion() {
		logf("warning: goose %s found, galopin is tested with %s (agent/packaging/goose-version)", v, packaging.GooseVersion())
	}
	root := gooseRootFor(credsPath)
	if _, err := os.Stat(filepath.Join(root, "config", "config.yaml")); err != nil {
		return nil, fmt.Errorf("galopin's goose config is missing under %s: re-run 'galopin enroll --engine goose'", root)
	}
	// The sessions link must exist even if the config was written by an older run.
	if err := linkGooseSessions(root); err != nil {
		return nil, err
	}
	acpBackend := backendacp.New(backendacp.Config{
		Command:        []string{bin, "acp"},
		Env:            gooseEnv(root, os.Environ()),
		StartupTimeout: 90 * time.Second,
		Tools:          pol.AgentToolsAllowed(),
		Protect:        protect,
		SessionMeta:    map[string]any{"client": "galopin"},
		Usage:          true,
		CompactCommand: "/compact",
		HiddenModes:    gooseHiddenModes,
		ForceMode:      gooseModeApprove,
		Logf:           func(format string, args ...any) { logf(format, args...) },
	})
	if err := acpBackend.Start(ctx); err != nil {
		return nil, fmt.Errorf("starting goose: %w", err)
	}
	return acpBackend, nil
}
