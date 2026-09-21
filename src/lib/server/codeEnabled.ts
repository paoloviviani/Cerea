import { config } from "$lib/server/config";

/**
 * The deployment switch for the `/code` remote-agent panel
 * (`CODE_AGENTS_ENABLED`).
 *
 * Off unless explicitly `"true"`: unlike knowledge or memory, this surface
 * needs a paseo daemon (or relay) deployed beside the chat, and a route that
 * only errors without one is worse than none. Off hides the sidebar row and
 * the route answers 404; the pairing endpoints refuse too, as a backstop.
 *
 * The relay Cerea dials is `CODE_RELAY_URL`; the daemon itself is reached
 * through it, per paired device (ADR 0085). The pairing offer material is
 * held server-side (see `$lib/server/codeDaemon.ts`) and never reaches the
 * browser.
 */
export function codeAgentsEnabled(): boolean {
	return config.CODE_AGENTS_ENABLED === "true";
}
