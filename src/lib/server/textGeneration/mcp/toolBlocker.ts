/**
 * A per-turn block on a tool that keeps failing the same way, so the model
 * cannot spend the whole turn hammering a broken connector: after two
 * identical failures the next call to that tool is refused before it
 * dispatches, and the tool result the model reads says to continue without
 * it. The refusals never reach the dispatch path, so they cost no approval
 * either — the person is never asked about a call that will not run.
 *
 * Keyed by the model-facing tool name; the tally counts identical error
 * texts. A different error from the same tool restarts the tally — a moving
 * target is a model finding its way, not a stuck one — and a different tool
 * is never affected. Scoped to one turn: a new generation builds a new
 * blocker, because the thing that made the tool fail is often the thing the
 * next turn was started to fix.
 */

export interface ToolBlocker {
	/** Whether this tool has already failed the same way twice this turn. */
	blocked(name: string): boolean;
	/** The tool result handed back for a blocked call. */
	message(name: string): string;
	/** Record one failure of this tool, with the error text the model will read. */
	recordFailure(name: string, error: string): void;
}

const IDENTICAL_FAILURES_BEFORE_BLOCK = 2;

export function createToolBlocker(): ToolBlocker {
	const failures = new Map<string, { message: string; count: number }>();

	return {
		blocked(name) {
			const seen = failures.get(name);
			return seen !== undefined && seen.count >= IDENTICAL_FAILURES_BEFORE_BLOCK;
		},

		message(name) {
			const seen = failures.get(name);
			return (
				`This tool is unavailable for the rest of this turn (same error twice: ${seen?.message ?? "unknown error"}). ` +
				"Continue without it and tell the person."
			);
		},

		recordFailure(name, error) {
			const message = error.trim();
			if (!message) return;
			const seen = failures.get(name);
			failures.set(
				name,
				seen && seen.message === message ? { message, count: seen.count + 1 } : { message, count: 1 }
			);
		},
	};
}
