package opencode

import (
	"strings"
)

// launchStripped are the variables opencode reads that could route a request
// to, or bill it against, anything but the galopin gateway: provider
// credentials and endpoints, and opencode's own permission override. A
// launched opencode starts without them, so the only provider with a usable
// credential is the shim's (OPENCODE_CONFIG). The supervised `opencode serve`
// does not strip them: nothing there is typed by a user, and Cerea's session
// settings pick the model.
var launchStripped = map[string]bool{
	"ANTHROPIC_API_KEY": true, "ANTHROPIC_AUTH_TOKEN": true, "ANTHROPIC_BASE_URL": true,
	"OPENAI_API_KEY": true, "OPENAI_BASE_URL": true, "OPENAI_ORG_ID": true, "OPENAI_PROJECT_ID": true,
	"OPENROUTER_API_KEY": true,
	"GEMINI_API_KEY":     true, "GOOGLE_API_KEY": true, "GOOGLE_GENERATIVE_AI_API_KEY": true,
	"GOOGLE_APPLICATION_CREDENTIALS": true, "GOOGLE_CLOUD_PROJECT": true,
	"GROQ_API_KEY": true, "MISTRAL_API_KEY": true, "XAI_API_KEY": true, "DEEPSEEK_API_KEY": true,
	"TOGETHER_API_KEY": true, "TOGETHERAI_API_KEY": true, "FIREWORKS_API_KEY": true,
	"CEREBRAS_API_KEY": true, "PERPLEXITY_API_KEY": true, "COHERE_API_KEY": true,
	"HF_TOKEN": true, "HUGGINGFACE_API_KEY": true, "AI_GATEWAY_API_KEY": true,
	"AZURE_OPENAI_API_KEY": true, "AZURE_OPENAI_ENDPOINT": true, "AZURE_API_KEY": true, "AZURE_RESOURCE_NAME": true,
	"AWS_BEARER_TOKEN_BEDROCK": true,
	"OPENCODE_PERMISSION":      true, "OPENCODE_MODEL": true, "OPENCODE_API_KEY": true,
}

// LaunchStripped reports the variable names LaunchEnv removes, for the docs
// and tests.
func LaunchStripped() []string {
	out := make([]string, 0, len(launchStripped))
	for k := range launchStripped {
		out = append(out, k)
	}
	return out
}

// LaunchEnv is the environment for an interactive opencode a user starts
// themselves (`galopin launch opencode`): exactly what the supervised
// `opencode serve` gets from childEnv (OPENCODE_CONFIG, TMPDIR, the project
// config switch, the permission floor), minus inherited provider credentials
// and selectors, and without the server password or galopin's tool relay
// (there is no Cerea to answer them).
func LaunchEnv(cfg Config) ([]string, error) {
	env, err := childEnv(cfg, nil)
	if err != nil {
		return nil, err
	}
	kept := env[:0]
	for _, kv := range env {
		name, _, _ := strings.Cut(kv, "=")
		if launchStripped[name] || name == "OPENCODE_SERVER_PASSWORD" || name == "OPENCODE_SERVER_USERNAME" {
			continue
		}
		kept = append(kept, kv)
	}
	return kept, nil
}

// LaunchArgs is the argument vector for the interactive opencode: --pure
// when the machine does not load project config (the same switch the
// supervised serve passes; OPENCODE_DISABLE_PROJECT_CONFIG alone leaves a
// repo's plugins running), then the user's own arguments untouched.
func LaunchArgs(cfg Config, user []string) []string {
	var args []string
	if !cfg.ProjectConfig {
		args = append(args, "--pure")
	}
	return append(args, user...)
}
