package opencode

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// gatewayProviderID is the provider enroll writes (policy.GatewayProviderID;
// this package cannot import policy without a cycle of concern, and the id
// is the config file's own key).
const gatewayProviderID = "pystino"

// pinnedConfig is the gateway config file, re-rendered for
// OPENCODE_CONFIG_CONTENT: the same provider block and enabled_providers
// (absent when the operator passed --allow-opencode-provider, then there is
// no allowlist to pin), plus model and small_model naming a gateway model.
// opencode layers the inline content above a project's opencode.json, so a
// repo's provider baseURL, enabled_providers, model and small_model lose to
// these. An agent-level model in the repo still applies, but it can only
// name a provider the pinned allowlist enabled: it fails closed.
func pinnedConfig(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return "", fmt.Errorf("parsing %s: %w", path, err)
	}
	if _, ok := cfg["model"]; !ok {
		if id := firstGatewayModel(cfg); id != "" {
			cfg["model"] = gatewayProviderID + "/" + id
		}
	}
	if m, ok := cfg["model"]; ok {
		if _, has := cfg["small_model"]; !has {
			cfg["small_model"] = m
		}
	}
	out, err := json.Marshal(cfg)
	return string(out), err
}

func firstGatewayModel(cfg map[string]any) string {
	providers, _ := cfg["provider"].(map[string]any)
	gw, _ := providers[gatewayProviderID].(map[string]any)
	models, _ := gw["models"].(map[string]any)
	ids := make([]string, 0, len(models))
	for id := range models {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	if len(ids) == 0 {
		return ""
	}
	return ids[0]
}
