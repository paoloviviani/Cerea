/**
 * Wraps the named handlers so each runs through `ops`, one at a time with profile switches, adds
 * and removals: a handler that starts, stops or configures "the" galopin then acts on whichever
 * profile is current when it runs, never on one that a switch in flight is leaving.
 */
export function serialize<H extends Record<string, (arg: never) => unknown>>(
	ops: Mutex,
	handlers: H,
	keys: readonly (keyof H)[],
	/** Runs first, inside the queue, for the handler `key`: it may refuse by throwing. */
	before?: (key: keyof H, arg: unknown) => unknown
): void {
	for (const key of keys) {
		const h = handlers[key];
		handlers[key] = ((arg: never) =>
			ops.run(async () => {
				await before?.(key, arg);
				return h(arg);
			})) as H[typeof key];
	}
}

/** Runs one async operation at a time, in the order asked. A failure of one does not stop the next. */
export class Mutex {
	private tail: Promise<void> = Promise.resolve();
	run<T>(work: () => Promise<T> | T): Promise<T> {
		const result = this.tail.then(work);
		this.tail = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}
}
