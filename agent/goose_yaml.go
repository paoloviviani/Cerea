package main

// Edits of goose's config.yaml for 'galopin goose setup', by key, through
// yaml.v3's node tree. goose Desktop and the CLI rewrite this file (and drop its
// comments), so nothing here relies on a marker in the file: what setup replaced
// is recorded in a sidecar under galopin's state directory (gooseSidecar), and
// 'setup --remove' puts it back from there. Everything else in the file is the
// user's and is kept as it parses.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	gooseExtKey        = "cerea_connectors"
	gooseSidecarName   = "goose-setup.json"
	gooseKeyProvider   = "GOOSE_PROVIDER"
	gooseKeyModel      = "GOOSE_MODEL"
	gooseKeyExtensions = "extensions"
)

// gooseSidecar is what 'goose setup' changed in the user's config.yaml, so that
// setup is idempotent and remove restores the originals.
type gooseSidecar struct {
	// Was is a key's value before setup set it (null: the key was absent).
	Was map[string]*string `json:"was,omitempty"`
	// Set is the value setup wrote; remove only touches a key still holding it.
	Set map[string]string `json:"set,omitempty"`
	// ExtensionsCreated: the extensions key did not exist (or was empty) before.
	ExtensionsCreated bool `json:"extensionsCreated,omitempty"`
}

func loadGooseSidecar(stateDir string) (*gooseSidecar, error) {
	sc := &gooseSidecar{Was: map[string]*string{}, Set: map[string]string{}}
	body, err := os.ReadFile(filepath.Join(stateDir, gooseSidecarName))
	if os.IsNotExist(err) {
		return sc, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(body, sc); err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.Join(stateDir, gooseSidecarName), err)
	}
	if sc.Was == nil {
		sc.Was = map[string]*string{}
	}
	if sc.Set == nil {
		sc.Set = map[string]string{}
	}
	return sc, nil
}

func (sc *gooseSidecar) save(stateDir string) error {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	body, err := json.MarshalIndent(sc, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(stateDir, gooseSidecarName), append(body, '\n'), 0o600)
}

func removeGooseSidecar(stateDir string) { _ = os.Remove(filepath.Join(stateDir, gooseSidecarName)) }

// gooseExtSpec is the "Cerea connectors" extension: a streamable-http MCP
// server, its bearer secret in a header (goose's own extension schema).
type gooseExtSpec struct {
	Enabled        bool              `yaml:"enabled"`
	Type           string            `yaml:"type"`
	Name           string            `yaml:"name"`
	Description    string            `yaml:"description"`
	URI            string            `yaml:"uri"`
	Envs           map[string]string `yaml:"envs"`
	EnvKeys        []string          `yaml:"env_keys"`
	Headers        map[string]string `yaml:"headers"`
	Timeout        int               `yaml:"timeout"`
	Bundled        *string           `yaml:"bundled"`
	AvailableTools []string          `yaml:"available_tools"`
}

func newGooseExt(uri, secret string) gooseExtSpec {
	return gooseExtSpec{
		Enabled: true, Type: "streamable_http", Name: "Cerea connectors",
		Description: "Connectors from your Cerea account and this machine, through galopin's local endpoint (needs 'galopin run').",
		URI:         uri, Envs: map[string]string{}, EnvKeys: []string{},
		Headers: map[string]string{"Authorization": "Bearer " + secret},
		Timeout: 300, AvailableTools: []string{},
	}
}

func sortGooseModels(m []gooseModel) {
	sort.Slice(m, func(i, j int) bool { return m[i].ID < m[j].ID })
}

// parseGooseConfig parses config.yaml text into a document whose root is a mapping.
func parseGooseConfig(text string) (*yaml.Node, *yaml.Node, error) {
	var doc yaml.Node
	if strings.TrimSpace(text) != "" {
		if err := yaml.Unmarshal([]byte(text), &doc); err != nil {
			return nil, nil, fmt.Errorf("goose's config.yaml is not valid YAML, left as it is: %w", err)
		}
	}
	if doc.Kind == 0 || len(doc.Content) == 0 {
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}}
	}
	root := doc.Content[0]
	if root.Kind != yaml.MappingNode {
		if root.Kind == yaml.ScalarNode && root.Tag == "!!null" {
			*root = yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		} else {
			return nil, nil, fmt.Errorf("goose's config.yaml is not a key/value file, left as it is")
		}
	}
	return &doc, root, nil
}

func encodeGooseConfig(doc *yaml.Node) (string, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(doc); err != nil {
		return "", err
	}
	if err := enc.Close(); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// mapIndex returns the index of key's value in a mapping's Content, or -1.
func mapIndex(m *yaml.Node, key string) int {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return i + 1
		}
	}
	return -1
}

func mapDelete(m *yaml.Node, key string) {
	if i := mapIndex(m, key); i >= 0 {
		m.Content = append(m.Content[:i-1], m.Content[i+1:]...)
	}
}

func strNode(v string) *yaml.Node { return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: v} }

// setScalar sets a top-level key to a string, keeping the key's position.
func setScalar(m *yaml.Node, key, val string) {
	if i := mapIndex(m, key); i >= 0 {
		m.Content[i] = strNode(val)
		return
	}
	m.Content = append(m.Content, strNode(key), strNode(val))
}

// setGooseDefaultNode makes provider/model goose's default, recording in sc what
// each key held (once: a repeat keeps the first original).
func setGooseDefaultNode(root *yaml.Node, sc *gooseSidecar, provider, model string) {
	for _, kv := range [][2]string{{gooseKeyProvider, provider}, {gooseKeyModel, model}} {
		key, val := kv[0], kv[1]
		cur := (*string)(nil)
		if i := mapIndex(root, key); i >= 0 {
			v := root.Content[i].Value
			cur = &v
		}
		// Keep the first original unless the user has changed the key since setup.
		_, recorded := sc.Was[key]
		if !recorded || cur == nil || *cur != sc.Set[key] {
			sc.Was[key] = cur
		}
		sc.Set[key] = val
		setScalar(root, key, val)
	}
}

// setGooseExtensionNode adds (or replaces) the Cerea connectors extension and
// leaves every other extension the user has.
func setGooseExtensionNode(root *yaml.Node, sc *gooseSidecar, ext gooseExtSpec) error {
	var node yaml.Node
	if err := node.Encode(ext); err != nil {
		return err
	}
	i := mapIndex(root, gooseKeyExtensions)
	switch {
	case i < 0:
		sc.ExtensionsCreated = true
		root.Content = append(root.Content, strNode(gooseKeyExtensions), &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"})
		i = len(root.Content) - 1
	case root.Content[i].Kind == yaml.ScalarNode && root.Content[i].Tag == "!!null":
		sc.ExtensionsCreated = true
		root.Content[i] = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	case root.Content[i].Kind != yaml.MappingNode:
		return fmt.Errorf("goose's config.yaml has an \"extensions\" entry that is not a map, left as it is")
	}
	exts := root.Content[i]
	if len(exts.Content) == 0 {
		sc.ExtensionsCreated = true
		exts.Style = 0 // an empty `{}` becomes a block map
	}
	if j := mapIndex(exts, gooseExtKey); j >= 0 {
		exts.Content[j] = &node
		return nil
	}
	exts.Content = append(exts.Content, strNode(gooseExtKey), &node)
	return nil
}

// applyGooseConfig is setup's whole edit of config.yaml text.
func applyGooseConfig(text string, sc *gooseSidecar, makeDefault bool, provider, model string, ext *gooseExtSpec) (string, error) {
	doc, root, err := parseGooseConfig(text)
	if err != nil {
		return "", err
	}
	if makeDefault {
		setGooseDefaultNode(root, sc, provider, model)
	}
	if ext != nil {
		if err := setGooseExtensionNode(root, sc, *ext); err != nil {
			return "", err
		}
	}
	return encodeGooseConfig(doc)
}

// removeGooseConfig undoes setup: the extension goes (and the extensions key, if
// setup made it and nothing else is in it), a default setup set goes back to
// what it was, and a GOOSE_PROVIDER still pointing at galopin without a record
// is dropped rather than left dangling. changed is false when nothing was ours.
func removeGooseConfig(text string, sc *gooseSidecar) (string, bool, error) {
	doc, root, err := parseGooseConfig(text)
	if err != nil {
		return "", false, err
	}
	changed := false
	if i := mapIndex(root, gooseKeyExtensions); i >= 0 && root.Content[i].Kind == yaml.MappingNode {
		exts := root.Content[i]
		if mapIndex(exts, gooseExtKey) >= 0 {
			mapDelete(exts, gooseExtKey)
			changed = true
			if len(exts.Content) == 0 {
				if sc.ExtensionsCreated {
					mapDelete(root, gooseKeyExtensions)
				} else {
					exts.Style = yaml.FlowStyle
				}
			}
		}
	}
	for _, key := range []string{gooseKeyProvider, gooseKeyModel} {
		i := mapIndex(root, key)
		if i < 0 {
			continue
		}
		cur := root.Content[i].Value
		was, recorded := sc.Was[key]
		switch {
		case recorded && cur == sc.Set[key]:
			if was == nil {
				mapDelete(root, key)
			} else {
				root.Content[i] = strNode(*was)
			}
			changed = true
		case !recorded && key == gooseKeyProvider && cur == gooseProviderID:
			// Setup's record is gone: the provider is being removed, so do not leave it as the default.
			mapDelete(root, key)
			mapDelete(root, gooseKeyModel)
			changed = true
		}
	}
	if len(root.Content) == 0 {
		return "", changed, nil
	}
	out, err := encodeGooseConfig(doc)
	return out, changed, err
}
