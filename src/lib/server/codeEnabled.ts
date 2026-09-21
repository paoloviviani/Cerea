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
 * The daemon itself is addressed by `CODE_DAEMON_URL` with the service
 * credential in `CODE_DAEMON_TOKEN` — both held server-side (see
 * `$lib/server/codeDaemon.ts`) and never reaching the browser.
 */
export function codeAgentsEnabled(): boolean {
	return config.CODE_AGENTS_ENABLED === "true";
}
