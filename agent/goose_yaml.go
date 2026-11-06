package main

// Line-based edits of goose's config.yaml for 'galopin goose setup'. goose's
// own file is flat YAML with an `extensions:` map; an edit here touches only
// what setup owns (two flat keys it sets with --default, and one delimited
// extension block), keeps every other line and comment as it was, and can be
// undone exactly.

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

const (
	gooseBlockStart = "# >>> galopin goose setup (managed: 'galopin goose setup --remove' deletes this block)"
	gooseBlockEnd   = "# <<< galopin goose setup"
	gooseWasMarker  = " # galopin-setup was="
	gooseExtKey     = "cerea_connectors"
)

func sortGooseModels(m []gooseModel) {
	sort.Slice(m, func(i, j int) bool { return m[i].ID < m[j].ID })
}

var yamlKeyLine = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_]*):(?:\s+(.*))?$`)

// setGooseDefault makes provider/model goose's default, remembering what the
// lines held (in a comment on the line) so remove can put it back.
func setGooseDefault(text, provider, model string) string {
	lines := strings.Split(text, "\n")
	set := func(key, val string) {
		found := false
		for i, ln := range lines {
			m := yamlKeyLine.FindStringSubmatch(ln)
			if m == nil || m[1] != key {
				continue
			}
			found = true
			if idx := strings.Index(ln, gooseWasMarker); idx >= 0 {
				// Already ours: keep the original "was".
				was := strings.TrimSpace(ln[idx+len(gooseWasMarker):])
				lines[i] = fmt.Sprintf("%s: %s%s%s", key, val, gooseWasMarker, was)
			} else {
				old := strings.TrimSpace(m[2]) // the value and its comment, as they were
				if old == "" {
					old = "-"
				}
				lines[i] = fmt.Sprintf("%s: %s%s%s", key, val, gooseWasMarker, old)
			}
			break
		}
		if !found {
			lines = append(trimTrailingBlank(lines), fmt.Sprintf("%s: %s%s-", key, val, gooseWasMarker), "")
		}
	}
	set("GOOSE_PROVIDER", provider)
	set("GOOSE_MODEL", model)
	return strings.Join(lines, "\n")
}

func trimTrailingBlank(lines []string) []string {
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func indentOf(s string) int { return len(s) - len(strings.TrimLeft(s, " ")) }

// removeExtensionBlock deletes setup's delimited block, wherever it is.
func removeExtensionBlock(lines []string) ([]string, bool) {
	start := -1
	for i, ln := range lines {
		if strings.TrimSpace(ln) == gooseBlockStart {
			start = i
			continue
		}
		if start >= 0 && strings.TrimSpace(ln) == gooseBlockEnd {
			return append(append([]string{}, lines[:start]...), lines[i+1:]...), true
		}
	}
	return lines, false
}

// setGooseExtension adds (or replaces) the "Cerea connectors" extension: a
// streamable-http MCP server, its bearer secret in a header.
func setGooseExtension(text, uri, secret string) string {
	lines, _ := removeExtensionBlock(strings.Split(text, "\n"))
	extIdx := -1
	for i, ln := range lines {
		if m := yamlKeyLine.FindStringSubmatch(ln); m != nil && m[1] == "extensions" {
			extIdx = i
			break
		}
	}
	indent := 2
	if extIdx >= 0 {
		for _, ln := range lines[extIdx+1:] {
			t := strings.TrimSpace(ln)
			if t == "" || strings.HasPrefix(t, "#") {
				continue
			}
			if n := indentOf(ln); n > 0 {
				indent = n
			}
			break
		}
	}
	pad := strings.Repeat(" ", indent)
	block := []string{
		pad + gooseBlockStart,
		pad + gooseExtKey + ":",
		pad + "  enabled: true",
		pad + "  type: streamable_http",
		pad + "  name: Cerea connectors",
		pad + "  description: Connectors from your Cerea account and this machine, through galopin's local endpoint (needs 'galopin run').",
		pad + "  uri: " + uri,
		pad + "  envs: {}",
		pad + "  env_keys: []",
		pad + "  headers:",
		pad + "    Authorization: Bearer " + secret,
		pad + "  timeout: 300",
		pad + "  bundled: null",
		pad + "  available_tools: []",
		pad + gooseBlockEnd,
	}
	if extIdx < 0 {
		lines = trimTrailingBlank(lines)
		lines = append(lines, "extensions:")
		lines = append(lines, block...)
		return strings.Join(append(lines, ""), "\n")
	}
	// `extensions: {}` / null / ~ become a block map.
	lines[extIdx] = "extensions:"
	out := append([]string{}, lines[:extIdx+1]...)
	out = append(out, block...)
	out = append(out, lines[extIdx+1:]...)
	return strings.Join(out, "\n")
}

// removeGooseManaged undoes setGooseDefault and setGooseExtension.
func removeGooseManaged(text string) (string, bool) {
	lines, changed := removeExtensionBlock(strings.Split(text, "\n"))
	// An `extensions:` left with no children is dropped.
	for i, ln := range lines {
		if m := yamlKeyLine.FindStringSubmatch(ln); m != nil && m[1] == "extensions" && strings.TrimSpace(m[2]) == "" && changed {
			empty := true
			for _, nx := range lines[i+1:] {
				t := strings.TrimSpace(nx)
				if t == "" || strings.HasPrefix(t, "#") {
					continue
				}
				empty = indentOf(nx) == 0
				break
			}
			if empty {
				lines = append(append([]string{}, lines[:i]...), lines[i+1:]...)
			}
			break
		}
	}
	var out []string
	for _, ln := range lines {
		idx := strings.Index(ln, gooseWasMarker)
		m := yamlKeyLine.FindStringSubmatch(ln)
		if idx < 0 || m == nil {
			out = append(out, ln)
			continue
		}
		changed = true
		if was := strings.TrimSpace(ln[idx+len(gooseWasMarker):]); was != "-" {
			out = append(out, fmt.Sprintf("%s: %s", m[1], was))
		}
	}
	return strings.Join(out, "\n"), changed
}
