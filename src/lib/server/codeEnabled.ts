import { config } from "$lib/server/config";

/**
 * The deployment switch for the `/code` remote-agent panel
 * (`CODE_AGENTS_ENABLED`).
 *
 * Off unless explicitly `"true"`: unlike knowledge or memory, this surface
 * needs a person's own machine dialling in over the machine link, and a
 * route that only errors without one is worse than none. Off hides the
 * sidebar row and the route answers 404; the pairing endpoints refuse too,
 * as a backstop.
 *
 * The machine dials out to this deployment itself — no relay, and nothing
 * capability-bearing at rest in Cerea (`$lib/server/code/machines.ts`,
 * `reports/2026-09-24-thin-agent-protocol.md`).
 */
export function codeAgentsEnabled(): boolean {
	return config.CODE_AGENTS_ENABLED === "true";
}
