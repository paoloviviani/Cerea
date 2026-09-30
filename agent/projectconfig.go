package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
)

// A workspace's own opencode config (a cloned repo is untrusted input) is
// off by default (policy.ProjectConfig); these helpers serve the two places
// that need to know what a repo carries: the workspace listing (a denying
// machine says the repo's config is ignored) and the audit log (an opted-in
// machine records an attempt to move the provider or the default models).

// projectConfigFiles are the JSON(C) files opencode reads for a project.
var projectConfigFiles = []string{
	"opencode.json", "opencode.jsonc",
	filepath.Join(".opencode", "opencode.json"), filepath.Join(".opencode", "opencode.jsonc"),
}

// hasProjectConfig reports whether dir carries opencode config of its own:
// an opencode.json(c) or an .opencode directory.
func hasProjectConfig(dir string) bool {
	if fi, err := os.Stat(filepath.Join(dir, ".opencode")); err == nil && fi.IsDir() {
		return true
	}
	for _, f := range projectConfigFiles {
		if fi, err := os.Stat(filepath.Join(dir, f)); err == nil && !fi.IsDir() {
			return true
		}
	}
	return false
}

// projectOverrideKeys lists the routing keys dir's own opencode.json sets:
// provider, enabled_providers, model, small_model, and agent.<name>.model.
// An unreadable or unparsable file contributes nothing.
func projectOverrideKeys(dir string) []string {
	seen := map[string]bool{}
	for _, f := range projectConfigFiles {
		raw, err := os.ReadFile(filepath.Join(dir, f))
		if err != nil {
			continue
		}
		var cfg map[string]json.RawMessage
		if json.Unmarshal(stripJSONC(raw), &cfg) != nil {
			continue
		}
		for _, k := range []string{"provider", "enabled_providers", "model", "small_model"} {
			if _, ok := cfg[k]; ok {
				seen[k] = true
			}
		}
		var agents map[string]struct {
			Model json.RawMessage `json:"model"`
		}
		if json.Unmarshal(cfg["agent"], &agents) == nil {
			for name, a := range agents {
				if len(a.Model) > 0 {
					seen["agent."+name+".model"] = true
				}
			}
		}
	}
	keys := make([]string, 0, len(seen))
	for k := range seen {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// stripJSONC drops // and /* */ comments and trailing commas outside strings.
func stripJSONC(in []byte) []byte {
	out := make([]byte, 0, len(in))
	inStr := false
	for i := 0; i < len(in); i++ {
		c := in[i]
		if inStr {
			out = append(out, c)
			if c == '\\' && i+1 < len(in) {
				i++
				out = append(out, in[i])
			} else if c == '"' {
				inStr = false
			}
			continue
		}
		switch {
		case c == '"':
			inStr = true
			out = append(out, c)
		case c == '/' && i+1 < len(in) && in[i+1] == '/':
			for i < len(in) && in[i] != '\n' {
				i++
			}
			out = append(out, '\n')
		case c == '/' && i+1 < len(in) && in[i+1] == '*':
			i += 2
			for i+1 < len(in) && !(in[i] == '*' && in[i+1] == '/') {
				i++
			}
			i++
		case c == ',':
			j := i + 1
			for j < len(in) && (in[j] == ' ' || in[j] == '\n' || in[j] == '\t' || in[j] == '\r') {
				j++
			}
			if j < len(in) && (in[j] == '}' || in[j] == ']') {
				continue
			}
			out = append(out, c)
		default:
			out = append(out, c)
		}
	}
	return out
}
