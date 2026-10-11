package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Model pins outside Pystino (Part A2): opencode merges its global config
// into every session, so an agent file or config key pinning a non-Pystino
// model both bypasses the gateway while the provider is reachable and breaks
// background-task notification turns (which carry no model and fail on the
// unresolvable pin) once it is not. galopin never edits the user's files; it
// detects the pins, warns loudly, and records them where the panel can show
// them.

// ModelPin is one pinned model whose provider is not Pystino (nor opencode
// when free models are allowed): the file and the key that pins it.
type ModelPin struct {
	File  string
	Key   string
	Model string
}

// Warning is the pin as a one-line human sentence, shared by the log, the
// status file and the hello frame.
func (p ModelPin) Warning() string {
	return "an opencode agent file pins a model outside Pystino (" + p.File + " key " + p.Key + ": " + p.Model + "): background results and scheduled runs will fail or bypass the gateway"
}

// modelPinFiles are the JSON(C) files opencode reads for its global config.
var modelPinFiles = []string{"opencode.json", "opencode.jsonc", "config.json"}

// modelPinAgentDirs are the per-directory spellings opencode reads agent
// files from, both of which have been seen in the wild.
var modelPinAgentDirs = []string{"agents", "agent"}

// scanModelPins lists every model pin outside Pystino in opencode's global
// config sources: the user's own config directory (which opencode loads even
// though galopin sets OPENCODE_CONFIG and OPENCODE_CONFIG_DIR) and
// OPENCODE_CONFIG_DIR itself when set. allowFreeModels additionally allows
// the opencode provider's own models.
func scanModelPins(allowFreeModels bool) []ModelPin {
	var dirs []string
	if user, err := os.UserConfigDir(); err == nil {
		dirs = append(dirs, filepath.Join(user, "opencode"))
	}
	if env := os.Getenv("OPENCODE_CONFIG_DIR"); env != "" {
		dirs = append(dirs, env)
	}
	return scanModelPinDirs(dirs, allowFreeModels)
}

func scanModelPinDirs(dirs []string, allowFreeModels bool) []ModelPin {
	var out []ModelPin
	for _, dir := range dirs {
		for _, f := range modelPinFiles {
			out = append(out, jsonModelPins(filepath.Join(dir, f), allowFreeModels)...)
		}
		for _, sub := range modelPinAgentDirs {
			entries, err := os.ReadDir(filepath.Join(dir, sub))
			if err != nil {
				continue
			}
			for _, e := range entries {
				if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
					continue
				}
				path := filepath.Join(dir, sub, e.Name())
				model, err := frontmatterModel(path)
				if err != nil || model == "" || pinProviderAllowed(model, allowFreeModels) {
					continue
				}
				out = append(out, ModelPin{File: path, Key: "model", Model: model})
			}
		}
	}
	return out
}

// jsonModelPins reads one JSON(C) config file's model pins: the top-level
// model and small_model keys and agent.<name>.model. An unreadable or
// unparsable file contributes nothing.
func jsonModelPins(path string, allowFreeModels bool) []ModelPin {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	// The shared reader (projectconfig.go): comments and trailing commas
	// dropped before decoding.
	cfg := parseOpencodeJSON(raw)
	if cfg == nil {
		return nil
	}
	var out []ModelPin
	pinned := map[string]string{}
	for _, k := range []string{"model", "small_model"} {
		var model string
		if raw, ok := cfg[k]; ok && json.Unmarshal(raw, &model) == nil && model != "" {
			pinned[k] = model
		}
	}
	var agents map[string]struct {
		Model json.RawMessage `json:"model"`
	}
	if err := json.Unmarshal(cfg["agent"], &agents); err == nil {
		for name, a := range agents {
			var model string
			if len(a.Model) > 0 && json.Unmarshal(a.Model, &model) == nil && model != "" {
				pinned["agent."+name+".model"] = model
			}
		}
	}
	keys := make([]string, 0, len(pinned))
	for k := range pinned {
		keys = append(keys, k)
	}
	sort.Strings(keys) // a stable report order: equal configs report equal pins
	for _, k := range keys {
		if !pinProviderAllowed(pinned[k], allowFreeModels) {
			out = append(out, ModelPin{File: path, Key: k, Model: pinned[k]})
		}
	}
	return out
}

// frontmatterModel reads the `model:` key from a Markdown agent file's YAML
// frontmatter (the block between the leading --- lines). "" when the file
// has none, or no model key. Only a top-level key counts.
func frontmatterModel(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	lines := strings.Split(string(raw), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return "", nil
	}
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "---" {
			break
		}
		trimmed := strings.TrimRight(line, " \t\r")
		if strings.HasPrefix(trimmed, " ") || strings.HasPrefix(trimmed, "\t") {
			continue
		}
		rest, ok := strings.CutPrefix(trimmed, "model:")
		if !ok {
			continue
		}
		model := strings.TrimSpace(rest)
		// An inline comment is not the value.
		if i := strings.Index(model, " #"); i >= 0 {
			model = strings.TrimSpace(model[:i])
		}
		model = strings.Trim(model, `"'`)
		// A line parser cannot read YAML: a value with whitespace or
		// brackets in it is broken YAML (a list, a map, a comment run on),
		// not a model id — leave it to opencode's own error, not this scan.
		if model == "" || strings.ContainsAny(model, " \t[]{}#,") {
			return "", nil
		}
		return model, nil
	}
	return "", nil
}

// pinProviderAllowed reports whether a pinned model stays inside the gateway:
// provider/model with a pystino provider (or the opencode provider's own
// models when free models are allowed). A bare name counts as its own
// provider (a bare "pystino" is the gateway's default model, not a bypass).
func pinProviderAllowed(model string, allowFreeModels bool) bool {
	prov := model
	if i := strings.Index(model, "/"); i >= 0 {
		prov = model[:i]
	}
	if prov == "pystino" {
		return true
	}
	return allowFreeModels && prov == "opencode"
}

// reportModelPins logs, audits and files every pin (served from
// GET /galopin/health and filed in status.json, beside the credential
// state). It never touches the user's files.
func reportModelPins(pins []ModelPin, audit *auditLogger, sh *shim) {
	if len(pins) == 0 {
		return
	}
	for _, p := range pins {
		logf("warning: %s", p.Warning())
		if audit != nil {
			audit.globalConfigModelPin(p.File, p.Key, p.Model)
		}
	}
	if sh == nil {
		return
	}
	var warnings []string
	for _, p := range pins {
		warnings = append(warnings, p.Warning())
	}
	sh.adoptWarnings(warnings)
}
