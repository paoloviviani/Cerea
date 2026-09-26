package terminal

import (
	"regexp"
	"strings"
)

// InjectedEnvKeys are the exact environment variable names galopin (or the
// opencode process it supervises) ever sets for its own purposes. A
// terminal's shell must never see them, whatever process actually launched
// `galopin run` (PROTOCOL.md §9 "Terminal process rules", ADR 0090 §4):
//   - OPENCODE_SERVER_PASSWORD: the basic-auth password galopin picks for
//     the opencode HTTP server it supervises (internal/backend/opencode).
//   - OPENCODE_CONFIG: the path to the opencode.json enroll wrote, whose
//     provider entry carries the shim secret as an apiKey.
//   - OPENCODE_CONFIG_CONTENT / OPENCODE_CONFIG_DIR: opencode's inline
//     config and config dir. galopin never sets them, but a parent that
//     launched `galopin run` from inside another opencode (an agent
//     orchestrator can) leaks its own inline config, provider keys
//     included, through them.
//   - GALOPIN_SHIM_SECRET / GALOPIN_ACCESS_TOKEN / GALOPIN_REFRESH_TOKEN /
//     GALOPIN_CREDENTIAL: not set today (the shim's secret and the
//     enrollment's tokens live only in credentials.json and in memory,
//     never exported to this process's own environment), but denylisted so
//     a future change that does export one is covered without anyone
//     having to remember this file.
var InjectedEnvKeys = []string{
	"OPENCODE_SERVER_PASSWORD",
	"OPENCODE_CONFIG",
	"OPENCODE_CONFIG_CONTENT",
	"OPENCODE_CONFIG_DIR",
	"GALOPIN_SHIM_SECRET",
	"GALOPIN_ACCESS_TOKEN",
	"GALOPIN_REFRESH_TOKEN",
	"GALOPIN_CREDENTIAL",
}

// tokenLikeName catches anything shaped like a secret by name, regardless of
// who set it: TOKEN, SECRET, PASSWORD, CREDENTIAL, or a *_KEY / *_APIKEY
// variable. This is deliberately broader than InjectedEnvKeys — a terminal
// handed to a possibly-compromised browser session (ADR 0090's whole
// premise) should not inherit ambient secrets either, so the scrub errs
// toward removing too much rather than too little. It is documented here,
// per the brief, as the second half of the scrub.
var tokenLikeName = regexp.MustCompile(`(?i)(TOKEN|SECRET|PASSWORD|CREDENTIAL|_KEY$|APIKEY)`)

// ScrubEnv builds a terminal's environment from environ (ordinarily
// os.Environ()): every key in InjectedEnvKeys, and every key matching
// tokenLikeName, is dropped. Order is preserved for what remains.
func ScrubEnv(environ []string) []string {
	deny := make(map[string]bool, len(InjectedEnvKeys))
	for _, k := range InjectedEnvKeys {
		deny[k] = true
	}
	out := make([]string, 0, len(environ))
	for _, kv := range environ {
		key, _, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		if deny[key] || tokenLikeName.MatchString(key) {
			continue
		}
		out = append(out, kv)
	}
	return out
}
