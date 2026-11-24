package main

// Mistral Vibe as a supported engine: galopin runs `vibe-acp` through its ACP
// backend with a Vibe home it writes, never the user's ~/.vibe.
//
//	<state dir>/vibe/                 VIBE_HOME of the supervised vibe-acp
//	  config.toml                     galopin's provider, the gateway's models,
//	                                  telemetry off, the tool-permission floor
//	  logs/session/                   Vibe's own session store (galopin's, not shared)
//	  trusted_folders.toml            Vibe's own, left empty: no repository is trusted
//
// Everything Vibe reads that could change what it does (its config, its trust
// list, its API key) is galopin's; a repository's own .vibe/ is never loaded
// because no folder is trusted (see vibeFloorTOML).

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	backendacp "galopin/internal/backend/acp"
	"galopin/internal/policy"
	"galopin/packaging"
)

const (
	engineVibe = "vibe"

	// backendVibe is run's internal backend kind for a Vibe machine.
	backendVibe = "vibe"

	// vibeProviderName is Vibe's provider id for galopin's proxy.
	vibeProviderName = "galopin"

	// Vibe's agent modes. ask asks before every effectful tool call; the others skip asks
	// (accept-edits: file edits, auto-approve: everything, smart-approve: its own classifier's
	// judgement) and are hidden (acp Config.HiddenModes).
	vibeModeAsk = "ask"
)

// vibeHiddenModes are Vibe's modes that stop asking.
var vibeHiddenModes = []string{"accept-edits", "auto-approve", "smart-approve"}

// vibeHomeFor is the supervised vibe-acp's VIBE_HOME, beside the credentials.
func vibeHomeFor(credsPath string) string {
	return filepath.Join(filepath.Dir(credsPath), "vibe")
}

// vibeMinContext is the smallest context window Vibe 3.x accepts for a model.
const vibeMinContext = 13334

// vibeModel is one entry of the generated models list.
type vibeModel struct {
	ID      string
	Display string
	Context int
	Images  bool
}

// vibeModels turns the gateway catalogue into Vibe's models (chat models only, sorted
// by id so the file is stable).
func vibeModels(models []gatewayModel) []vibeModel {
	var out []vibeModel
	seen := map[string]bool{}
	for _, m := range models {
		if m.ID == "" || (m.Kind != "" && m.Kind != "chat") || seen[m.ID] {
			continue
		}
		seen[m.ID] = true
		ctx := m.ContextWindow
		if ctx <= 0 {
			ctx = defaultContextWindow
		}
		// Vibe refuses to open a session on a model whose window is smaller than this
		// (its prompt and tool schemas alone need it): a tiny model is listed with the
		// floor rather than taking every session down.
		ctx = max(ctx, vibeMinContext)
		images := false
		for _, in := range m.InputModalities {
			if in == "image" {
				images = true
			}
		}
		out = append(out, vibeModel{ID: m.ID, Display: m.DisplayName, Context: ctx, Images: images})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// tomlString quotes s as a TOML basic string.
func tomlString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(&b, `\u%04X`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

func tomlStrings(ss []string) string {
	q := make([]string, len(ss))
	for i, s := range ss {
		q[i] = tomlString(s)
	}
	return "[" + strings.Join(q, ", ") + "]"
}

// vibeFloorTOML is the tool-permission half of galopin's fixed floor, in Vibe's own
// config (the other half is galopin's decision on every ask, and the hidden modes):
//
//   - every tool that can reach files or the shell asks: read_file and grep are
//     "always" in Vibe by default inside the working directory, the shell has an
//     allowlist of read-only commands that run unasked; here they all go through
//     galopin's decision (protected paths, secrets, the machine's deny list);
//   - outside_workdir = "ask": a path outside the workspace is an ask, never an
//     automatic refusal Vibe decides on its own and galopin never sees;
//   - enable_auto_approve = false: Vibe itself refuses its auto-approve mode and
//     the --yolo flag, whatever asks for it;
//   - no catalogue, connector, update or telemetry traffic: nothing but the gateway.
func vibeFloorTOML() string {
	return strings.Join([]string{
		"enable_telemetry = false",
		"enable_update_checks = false",
		"enable_auto_update = false",
		"enable_auto_approve = false",
		"enable_connectors = false",
		"experimental_enable_model_catalog = false",
		// Vibe seeds the shell allowlist with its read-only commands once, keyed by this
		// id; marking it applied keeps the allowlist below as written (find is still
		// added by another migration; Vibe refuses its -exec and -delete).
		`applied_migrations = ["bash_read_only_defaults_v1"]`,
		`outside_workdir = "ask"`,
		`default_agent = "` + vibeModeAsk + `"`,
		"",
		"[tools.bash]",
		`permission = "ask"`,
		"allowlist = []",
		"",
		"[tools.read_file]",
		`permission = "ask"`,
		"",
	}, "\n")
}

// vibeConfigTOML renders galopin's config.toml for the proxy at shimAddr. The proxy
// secret rides as an Authorization header (no key variable: Vibe asks for none), so
// the one file, in galopin's own directory, is all Vibe needs and nothing secret is
// in its environment (a command Vibe runs inherits that).
func vibeConfigTOML(shimAddr, secret string, models []vibeModel) string {
	if len(models) == 0 {
		models = []vibeModel{{ID: placeholderModelID, Context: defaultContextWindow}}
	}
	var b strings.Builder
	b.WriteString("# Written by galopin (enroll / run / models refresh); edits are overwritten.\n")
	b.WriteString("active_model = " + tomlString(models[0].ID) + "\n")
	ids := make([]string, len(models))
	for i, m := range models {
		ids[i] = m.ID
	}
	// Only the gateway's models: Vibe's own default Mistral models would go to
	// api.mistral.ai directly, around the gateway's billing and privacy rules.
	b.WriteString("allowed_models = " + tomlStrings(ids) + "\n")
	b.WriteString(vibeFloorTOML())
	b.WriteString("[[providers]]\n")
	b.WriteString("name = " + tomlString(vibeProviderName) + "\n")
	b.WriteString("api_base = " + tomlString("http://"+shimAddr+"/v1") + "\n")
	b.WriteString("api_style = \"openai\"\n")
	b.WriteString("extra_headers = { Authorization = " + tomlString("Bearer "+secret) + " }\n")
	for _, m := range models {
		b.WriteString("\n[[models]]\n")
		b.WriteString("name = " + tomlString(m.ID) + "\n")
		b.WriteString("provider = " + tomlString(vibeProviderName) + "\n")
		b.WriteString("alias = " + tomlString(m.ID) + "\n")
		if m.Display != "" {
			b.WriteString("display_name = " + tomlString(m.Display) + "\n")
		}
		b.WriteString("max_context_length = " + strconv.Itoa(m.Context) + "\n")
		if m.Images {
			b.WriteString("supports_images = true\n")
		}
	}
	return b.String()
}

// writeVibeEngineConfig writes (or rewrites) the supervised Vibe's home under home from
// the credentials' proxy and the discovered models. trusted_folders.toml is written
// empty only when absent: Vibe's own file, which must never list a folder (galopin
// does not answer trust prompts, and rewrites nothing it did not write).
func writeVibeEngineConfig(home string, creds *credentials, models []gatewayModel) error {
	if creds.ShimPort == 0 || creds.ShimSecret == "" {
		return fmt.Errorf("the credential file records no proxy port or secret: re-run 'galopin enroll'")
	}
	for _, d := range []string{"", "logs"} {
		if err := os.MkdirAll(filepath.Join(home, d), 0o700); err != nil {
			return err
		}
	}
	body := vibeConfigTOML(fmt.Sprintf("127.0.0.1:%d", creds.ShimPort), creds.ShimSecret, vibeModels(models))
	if err := writeFileAtomic(filepath.Join(home, "config.toml"), []byte(body), 0o600); err != nil {
		return fmt.Errorf("writing Vibe config: %w", err)
	}
	return resetVibeTrust(home)
}

// resetVibeTrust makes the trust list empty: a folder that got trusted some way
// (a prompt Vibe answered itself, a copied file) would load that repository's own
// .vibe/ config, which could loosen the floor.
func resetVibeTrust(home string) error {
	return writeFileAtomic(filepath.Join(home, "trusted_folders.toml"), []byte("trusted = []\nuntrusted = []\n"), 0o600)
}

// readVibeModels reads model id -> context window back from galopin's config.toml
// (an absent or unreadable file is no models); the diff `models refresh` prints and
// the context meter use it.
func readVibeModels(path string) (map[string]int, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	out := map[string]int{}
	var name string
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "[[models]]":
			name = ""
		case strings.HasPrefix(line, "name = "):
			name, _ = strconv.Unquote(strings.TrimPrefix(line, "name = "))
		case strings.HasPrefix(line, "max_context_length = ") && name != "":
			if n, err := strconv.Atoi(strings.TrimPrefix(line, "max_context_length = ")); err == nil {
				out[name] = n
			}
		}
	}
	return out, nil
}

// vibeStripPrefixes are the inherited environment variables that would hand Vibe
// another provider's credentials or configuration (VIBE_* variables override its
// config file, so they go too); the engine's provider is galopin's proxy.
var vibeStripPrefixes = []string{
	"VIBE_", "MISTRAL_", "OPENAI_", "ANTHROPIC_", "AZURE_OPENAI_", "GEMINI_", "GOOGLE_API_KEY",
	"OLLAMA_", "OPENROUTER_", "XAI_", "GROQ_", "DEEPSEEK_", "CEREBRAS_", "LITELLM_",
}

// vibeEnv is the supervised Vibe's environment: the caller's, with every provider
// credential and VIBE_* setting removed, and its home set to galopin's. The
// loopback proxy is exempt from any HTTP proxy the machine configures.
func vibeEnv(home string, base []string) []string {
	out := make([]string, 0, len(base)+4)
	noProxy := "127.0.0.1,localhost"
	for _, kv := range base {
		name, val, _ := strings.Cut(kv, "=")
		if (name == "NO_PROXY" || name == "no_proxy") && val != "" {
			noProxy = val + "," + noProxy
		}
		strip := false
		for _, p := range vibeStripPrefixes {
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
		"VIBE_HOME="+home,
		"NO_PROXY="+noProxy,
		"no_proxy="+noProxy,
		"PYTHONUNBUFFERED=1",
		"PYTHONDONTWRITEBYTECODE=1",
	)
}

// vibeEnvOverride names the one way to run a Vibe other than the verified copy: the
// path of a vibe-acp executable.
const vibeEnvOverride = "GALOPIN_VIBE_BIN"

// vibeInstallDirName is where the install line puts the pinned Vibe, beside galopin and in
// a directory of galopin's own: it never replaces a Vibe the user installed (uv tool,
// pipx). The directory holds a Python environment, venv/.
const vibeInstallDirName = "galopin-vibe"

// vibeCommand is the argv galopin runs: the pinned, hash-verified copy the install line
// put in galopin's own directory. A vibe-acp from PATH is not used, whatever it is. An
// override is possible only by setting GALOPIN_VIBE_BIN, which `run` logs loudly.
func vibeCommand() ([]string, error) {
	if b := os.Getenv(vibeEnvOverride); b != "" {
		return []string{b}, nil
	}
	if exe, err := os.Executable(); err == nil {
		py := filepath.Join(filepath.Dir(exe), vibeInstallDirName, "venv", "bin", "python")
		if fi, err := os.Stat(py); err == nil && !fi.IsDir() {
			// -m, not the venv's vibe-acp script: the script's shebang names the path
			// the venv was built at, and the installer builds it in a staging directory.
			return []string{py, "-m", "vibe.acp.entrypoint"}, nil
		}
	}
	return nil, fmt.Errorf("Mistral Vibe %s is not installed for galopin: run the install line with '--engine vibe' (curl ... | sh -s -- --engine vibe); a Vibe elsewhere is used only if you set %s", packaging.VibeVersion(), vibeEnvOverride)
}

// vibeOverrideWarning is non-empty when Vibe comes from the override, and says so.
func vibeOverrideWarning() string {
	if b := os.Getenv(vibeEnvOverride); b != "" {
		return fmt.Sprintf("WARNING: running Vibe from %s=%s, not the verified pinned copy galopin installs. It is not checked by galopin and may behave differently (permissions, modes, protocol).", vibeEnvOverride, b)
	}
	return ""
}

// vibeInstalledNote says whether Vibe is there.
func vibeInstalledNote() string {
	cmd, err := vibeCommand()
	if err != nil {
		return "warning: " + err.Error()
	}
	return "Mistral Vibe found at " + cmd[0] + "."
}

// startVibeBackend starts the ACP backend over `vibe-acp` with galopin's home and the
// session guards (the hidden modes).
func startVibeBackend(ctx context.Context, opts *runOptions, credsPath, stateDir string, pol policy.Policy, protect func(string, string) bool, logf func(string, ...any)) (runningBackend, error) {
	cmd, err := vibeCommand()
	if err != nil {
		return nil, err
	}
	if w := vibeOverrideWarning(); w != "" {
		logf("%s", w)
	}
	home := vibeHomeFor(credsPath)
	if _, err := os.Stat(filepath.Join(home, "config.toml")); err != nil {
		return nil, fmt.Errorf("galopin's Vibe config is missing under %s: re-run 'galopin enroll --engine vibe'", home)
	}
	// Whatever else happened to the trust list, no folder is trusted for this run.
	if err := resetVibeTrust(home); err != nil {
		return nil, err
	}
	acpBackend := backendacp.New(backendacp.Config{
		Command:        cmd,
		Env:            vibeEnv(home, os.Environ()),
		StartupTimeout: 90 * time.Second,
		Tools:          pol.AgentToolsAllowed(),
		Protect:        protect,
		HiddenModes:    vibeHiddenModes,
		ForceMode:      vibeModeAsk,
		BeforeSession:  vibeBeforeSession(home, pol.ProjectConfigAllowed(), protect, logf),
		Logf:           func(format string, args ...any) { logf(format, args...) },
	})
	if err := acpBackend.Start(ctx); err != nil {
		return nil, fmt.Errorf("starting Vibe: %w", err)
	}
	return acpBackend, nil
}

// vibeModelsDiffFromFile compares a previous model list with the new one.
func vibeModelsDiff(old map[string]int, now []vibeModel) *modelsDiff {
	gm := make([]gooseModel, len(now))
	for i, m := range now {
		gm[i] = gooseModel{ID: m.ID, Context: m.Context}
	}
	return diffModelIDs(old, gm)
}
