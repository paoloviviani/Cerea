/**
 * The deployment-wide health of the decision route. Consecutive failures flip it to unavailable
 * ("Auto: reviewer unavailable"); while unavailable one ask a minute is let through as a probe and
 * the rest come to the user at once instead of each waiting out a timeout. A success resets it.
 */
const FAIL_LIMIT = 3;
const PROBE_EVERY_MS = 60_000;
let failures = 0;
let lastProbeAt = 0;

export function reviewerDegraded(): boolean {
	return failures >= FAIL_LIMIT;
}
export function noteCallOk(): void {
	failures = 0;
}
export function noteCallFailed(): void {
	failures += 1;
}
/** Whether this ask may call the model: always when healthy, one a minute when not. */
export function mayCall(now: number): boolean {
	if (!reviewerDegraded()) return true;
	if (now - lastProbeAt < PROBE_EVERY_MS) return false;
	lastProbeAt = now;
	return true;
}
export function _resetHealth(): void {
	failures = 0;
	lastProbeAt = 0;
}
