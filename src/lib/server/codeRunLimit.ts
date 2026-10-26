import { config } from "$lib/server/config";
import { runTimeoutMsFromSeconds } from "$lib/utils/execution/protocol";

/**
 * The wall-clock limit of one sandbox code run, in milliseconds: the
 * deployment's `CHAT_CODE_RUN_TIMEOUT_SECONDS` when set (clamped to the
 * sandbox's floor and hard ceiling), else the 60 s default. The browser reads
 * the same value through the feature flags, so the limit the person's worker
 * enforces and the deadline the parked turn waits for come from one place.
 */
export function codeRunTimeoutMs(): number {
	return runTimeoutMsFromSeconds(config.CHAT_CODE_RUN_TIMEOUT_SECONDS);
}
