import { config } from "$lib/server/config";
import { gatewaySessionCheck, recentValidGatewayOutcome } from "$lib/server/gatewaySession";
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
 * Local MCP connectors (`LOCAL_CONNECTORS_ENABLED`, ADR 0102): servers that run on a person's
 * own machine, offered to that person's chat over the machine link.
 *
 * On only when exactly `"true"`, like the agents switch, and independent of it: a deployment can
 * serve connectors machines without the Agents panel. Off, the machine endpoint refuses a
 * connectors-mode machine, the Local connectors tab is hidden and nothing local reaches a turn.
 */
export function localConnectorsEnabled(): boolean {
	return config.LOCAL_CONNECTORS_ENABLED === "true";
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
 *   request). The answer is **deny until the gateway says true**, with one
 *   mercy for a blip: when the gateway *cannot be asked* (a network error or
 *   a 5xx, the `open`/`unavailable` outcomes — not a refusal), the session's
 *   last valid answer rides for at most five minutes, the same grace the
 *   machine link's fail-open allows itself (`machineAuth.ts`), so one hiccup
 *   does not hide /code from everyone for the length of the /v1/me cache.
 *   Deny otherwise: no token (nobody to ask), no valid answer yet (first
 *   contact, or the grace has run out), a refusal (401/403, an ended
 *   session — the gateway's newest word about the session), and a
 *   capabilities block that does not grant the flag. The older-gateway
 *   allowance is told apart by the body itself — a body with no
 *   `capabilities` key at all never heard of capabilities and reads as
 *   allowed, while silence inside a present key is a denial
 *   (`gatewaySession.ts` keeps the two apart; the check is always awaited
 *   here, so "not fetched yet" can never reach this decision).
 * - without a gateway (the generic preset, a standalone deployment), the env
 *   switch alone decides, as today.
 */
export async function codeAgentsAllowedFor(locals: App.Locals): Promise<boolean> {
	if (!codeAgentsEnabled()) return false;
	if (!isGatewayPreset()) return true;
	if (!locals.token) return false;
	const outcome = await gatewaySessionCheck(locals.sessionId, locals.token);
	// A refusal denies at once; an unreachable gateway rides the person's
	// own last valid answer within the grace, and nothing else does.
	const answer =
		outcome?.kind === "valid"
			? outcome
			: outcome && outcome.kind !== "ended"
				? recentValidGatewayOutcome(locals.sessionId)
				: null;
	if (!answer) return false;
	if (answer.capabilities === "absent") return true;
	return answer.capabilities.code_agents;
}

/**
 * Whether *this person* may use local connectors, and if not why (ADR 0102, Pystino's
 * `local_connectors` capability). `localConnectorsEnabled()` stays the outer switch; this folds
 * the person's `/v1/me` answer through the same session cache and blip grace as
 * `codeAgentsAllowedFor`. "ok" without a gateway or on a gateway that predates the capability;
 * "not_configured" when the gateway reports neither capability because it has no chat
 * (a misconfiguration, said as such); "not_granted" otherwise.
 */
export async function localConnectorsAccessFor(
	locals: App.Locals
): Promise<"ok" | "not_granted" | "not_configured"> {
	if (!localConnectorsEnabled() || !isGatewayPreset()) return "ok";
	if (!locals.token) return "not_granted";
	const outcome = await gatewaySessionCheck(locals.sessionId, locals.token);
	const answer =
		outcome?.kind === "valid"
			? outcome
			: outcome && outcome.kind !== "ended"
				? recentValidGatewayOutcome(locals.sessionId)
				: null;
	if (!answer) return "not_granted";
	if (answer.capabilities === "absent") return "ok";
	if (answer.capabilities.chat_unconfigured) return "not_configured";
	return answer.capabilities.local_connectors ? "ok" : "not_granted";
}

/**
 * Whether the gateway says this person may hold API keys, which a scheduled chat needs.
 * Only a plain "no" from a gateway that speaks capabilities is a no: no gateway, an older
 * one, an unreachable one and a missing token all read as allowed, so the editor never
 * blocks on a guess (the mint itself still refuses, with the gateway's own words).
 */
export async function apiKeysAllowedFor(locals: App.Locals): Promise<boolean> {
	if (!isGatewayPreset() || !locals.token) return true;
	const outcome = await gatewaySessionCheck(locals.sessionId, locals.token);
	const answer =
		outcome?.kind === "valid"
			? outcome
			: outcome && outcome.kind !== "ended"
				? recentValidGatewayOutcome(locals.sessionId)
				: null;
	if (!answer || answer.capabilities === "absent") return true;
	return answer.capabilities.api_keys !== false;
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
