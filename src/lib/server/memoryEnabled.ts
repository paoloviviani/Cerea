import { config } from "$lib/server/config";

/**
 * The deployment switch for user memory (`CHAT_MEMORY_ENABLED`).
 *
 * On unless explicitly `"false"`, the same shape as `knowledgeEnabled` and for
 * the same reason: existing deployments never set the variable, and a new
 * feature that silently turns itself off everywhere is a feature nobody finds.
 *
 * Off hides the Memory workspace tab and refuses its API routes, and the
 * `remember`/`forget` tools are never offered. Operators who cannot keep
 * standing personal facts — a shared kiosk, a deployment under a retention
 * rule that has no place to put them — set it `false` and the surface
 * disappears rather than half-working.
 *
 * Distinct from each person's own `Settings.memoryEnabled`, which defaults
 * **off**. This one is the operator's decision about the deployment; that one
 * is the person's decision about themselves, and no deployment flag can opt
 * somebody in.
 */
export function memoryEnabled(): boolean {
	return config.CHAT_MEMORY_ENABLED !== "false";
}
