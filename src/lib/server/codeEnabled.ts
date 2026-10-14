import { config } from "$lib/server/config";
import { gatewaySessionCheck } from "$lib/server/gatewaySession";
import { isGatewayPreset } from "$lib/server/identity/gatewayLogin";
import { schedulesEnabled } from "$lib/server/schedules/limits";

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

/**
 * Whether *this person* may use the `/code` panel (ADR 0096).
 *
 * `codeAgentsEnabled()` is the outer switch and always wins: off is off for
 * everyone, exactly as today. When it is on:
 *
 * - with a Pystino gateway (`isGatewayPreset()`), the person's `/v1/me`
 *   `capabilities.code_agents` decides — read through the session's existing
 *   `/v1/me` cache (`gatewaySessionCheck`, at most one gateway call a minute
 *   per session, shared with the sign-in check; this adds no call per
 *   request). Here the answer is **deny until the gateway says true**: no
 *   token (nobody to ask), an answer the gateway did not give (a blip, a
 *   refusal, an ended session) and a capabilities block that does not grant
 *   the flag all read as denied, so a surface the gateway rations never
 *   opens on a guess. The one allowance is an **older gateway**, told apart
 *   by its own answer — a body with no `capabilities` key at all never heard
 *   of capabilities and reads as allowed, while silence inside a present key
 *   is a denial (`gatewaySession.ts` keeps the two apart; the check is always
 *   awaited here, so "not fetched yet" can never reach this decision).
 * - without a gateway (the generic preset, a standalone deployment), the env
 *   switch alone decides, as today.
 */
export async function codeAgentsAllowedFor(locals: App.Locals): Promise<boolean> {
	if (!codeAgentsEnabled()) return false;
	if (!isGatewayPreset()) return true;
	if (!locals.token) return false;
	const outcome = await gatewaySessionCheck(locals.sessionId, locals.token);
	if (outcome?.kind !== "valid") return false;
	if (outcome.capabilities === "absent") return true;
	return outcome.capabilities.code_agents;
}

/**
 * The /code file explorer (ADR 0090): on with the code panel, unless the
 * deployment switches it off. Each machine can still veto it (--no-files).
 */
export function codeFilesEnabled(): boolean {
	return codeAgentsEnabled() && config.CODE_FILES_ENABLED !== "false";
}

/**
 * The /code terminal (ADR 0090, PROTOCOL.md §9): the deployment half of the
 * double veto. Off unless explicitly `"true"` — the opposite default from
 * `codeFilesEnabled`, because a terminal is a full remote shell (D6/D7),
 * not a read-only view. The other half is each machine's own policy
 * (on by default; `--no-terminal` turns it off), checked separately wherever a terminal op is
 * forwarded.
 */
export function codeTerminalEnabled(): boolean {
	return codeAgentsEnabled() && config.CODE_TERMINAL_ENABLED === "true";
}

/**
 * Scheduled actions in /code (`server/schedules/`): on with the panel, unless
 * `CHAT_SCHEDULES_ENABLED=false` (the kill switch, see `schedules/limits.ts`
 * for why its default is on).
 */
export function codeSchedulesEnabled(): boolean {
	return codeAgentsEnabled() && schedulesEnabled();
}
