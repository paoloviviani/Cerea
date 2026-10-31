import { config } from "$lib/server/config";
import { codeRunTimeoutMs } from "$lib/server/codeRunLimit";
import { LOAD_TIMEOUT_MS, RUN_TIMEOUT_MS } from "$lib/utils/execution/protocol";

/**
 * How long a parked `execute_code` row waits for the browser's answer before
 * the sweeper gives up. One run costs the run limit; a cold worker adds its
 * whole load budget (wasm + stdlib + bootstrap); the remainder is
 * sweep-interval grace. A closed tab or a gone user is the sweeper's backstop,
 * not the timer. The constant is the deadline at the default run limit.
 */
export const CODE_EXECUTION_DEADLINE_MS = LOAD_TIMEOUT_MS + RUN_TIMEOUT_MS + 10_000;

/**
 * The deadline at the configured run limit. `CHAT_CODE_EXECUTION_DEADLINE_SECONDS`
 * replaces it outright (held between 1 second and 1 hour). It is test-only: it
 * exists so a spec can shorten the wait, and is not meant for deployments.
 */
export function codeExecutionDeadlineMs(): number {
	const override = Number(config.CHAT_CODE_EXECUTION_DEADLINE_SECONDS);
	if (Number.isFinite(override) && override > 0) {
		return Math.min(3_600_000, Math.max(1000, Math.round(override * 1000)));
	}
	return LOAD_TIMEOUT_MS + codeRunTimeoutMs() + 10_000;
}

export const DEFAULT_CODE_PAUSED_WAIT_MS = 15 * 60_000;
export const MIN_CODE_PAUSED_WAIT_MS = 2 * 60_000;
export const MAX_CODE_PAUSED_WAIT_MS = 60 * 60_000;

/**
 * How long a run whose page went to the background may keep the turn waiting
 * (`CODE_PAUSED_WAIT_MS`, default 15 minutes, held between 2 and 60). Counted
 * from the FIRST pause signal of a call, so repeated signals cannot extend it
 * without bound. Deployment configuration only: nothing a client sends, and no
 * user or conversation setting, reaches this value.
 */
export function codePausedWaitMs(): number {
	const raw = Number(config.CODE_PAUSED_WAIT_MS);
	if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CODE_PAUSED_WAIT_MS;
	return Math.round(Math.min(MAX_CODE_PAUSED_WAIT_MS, Math.max(MIN_CODE_PAUSED_WAIT_MS, raw)));
}
