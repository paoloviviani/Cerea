import { config } from "$lib/server/config";
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
