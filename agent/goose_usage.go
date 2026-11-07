package main

// goose's usage, derived from galopin's own proxy (ADR 0110, shimusage.go): the
// shape matches what the opencode backend emits after each assistant step, so
// the composer's context meter and the session's usage work unchanged. Cost is
// not computed here: Pystino meters it, tagged by session (x-pystino-tag), and
// Cerea's Cost view reads it from the gateway.

import (
	"galopin/internal/backend"
	backendacp "galopin/internal/backend/acp"
)

// usageFromSample maps one call's tokens to backend.Usage. Input excludes the
// cached tokens, Output excludes the reasoning ones, and ContextUsed is the
// call's whole prompt plus completion: what the model held at the end of the step.
// ctxMax <= 0 means the model's window is unknown.
func usageFromSample(s usageSample, ctxMax int) backend.Usage {
	cached := min(s.CachedTokens, s.PromptTokens)
	reasoning := min(s.ReasoningTokens, s.CompletionTokens)
	u := backend.Usage{
		Input:       s.PromptTokens - cached,
		Output:      s.CompletionTokens - reasoning,
		Reasoning:   reasoning,
		CacheRead:   cached,
		ContextUsed: s.PromptTokens + s.CompletionTokens,
	}
	if ctxMax > 0 {
		u.ContextMax = &ctxMax
	}
	return u
}

// gooseUsageSink feeds each metered call to the backend. The model's context
// window comes from galopin's own goose provider file, which `models refresh`
// writes from the gateway's catalogue; read per call because it is small and
// may have just been refreshed.
func gooseUsageSink(b *backendacp.Backend, providerFile string) func(string, usageSample) {
	return func(sessionID string, s usageSample) {
		ctxMax := 0
		if limits, err := readGooseProviderModels(providerFile); err == nil {
			ctxMax = limits[s.Model]
		}
		b.RecordUsage(sessionID, usageFromSample(s, ctxMax))
	}
}
