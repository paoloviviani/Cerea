package opencode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPinnedConfigNamesGatewayModels(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "opencode.json")
	src := `{"enabled_providers":["pystino"],"provider":{"pystino":{"models":{"zeta":{},"alpha":{}}}}}`
	if err := os.WriteFile(path, []byte(src), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := pinnedConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal([]byte(out), &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg["model"] != "pystino/alpha" || cfg["small_model"] != "pystino/alpha" {
		t.Errorf("model pins = %v / %v", cfg["model"], cfg["small_model"])
	}
	if _, ok := cfg["enabled_providers"]; !ok {
		t.Error("the allowlist was dropped")
	}
}
