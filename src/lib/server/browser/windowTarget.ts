/**
 * "This window" as a target of `browse` (ADR 0122), beside "a computer" (`machineChoice.ts`).
 * Rules, never the model: a turn that comes from a desktop window with its link up browses in
 * that window's own browser. A computer wins only when the model's `machine` hint is the exact
 * name of one of the user's ready computers AND the user's latest message names it as a whole
 * word, the same test the computer choice applies to a hint: the user's own words are then the
 * answer ("search it on my work laptop"). Without a window nothing here applies.
 */
import type { BrowseMachine } from "./availability";
import { textNamesComputer } from "./machineChoice";

export function windowTargetWins(input: {
	ready: BrowseMachine[];
	hint?: string;
	/** The user's latest message; absent (an unattended run) means the hint never counts. */
	userText?: string;
}): boolean {
	const wanted = input.hint?.trim().toLowerCase();
	if (wanted && input.userText) {
		const named = input.ready.filter(
			(m) => m.name.toLowerCase() === wanted && textNamesComputer(input.userText ?? "", m.name)
		);
		if (named.length === 1) return false;
	}
	return true;
}

export const OTHER_REPLICA_MESSAGE =
	"This app's browser is connected to another server instance. Try again in a moment, or start the task from a computer.";

/**
 * A turn that names a window this process does not hold. With one replica the window is simply
 * gone (closed or switched), and the turn goes on with computers as before. With several, another
 * replica probably holds it: the turn refuses, in plain words, rather than quietly browsing on a
 * computer the user did not choose. A scheduled run never names a window.
 */
export function windowRefusal(input: {
	windowId?: string;
	hasWindow: boolean;
	scheduledRun: boolean;
	replicas: number;
}): string | undefined {
	if (!input.windowId || input.hasWindow || input.scheduledRun) return undefined;
	return input.replicas > 1 ? OTHER_REPLICA_MESSAGE : undefined;
}
