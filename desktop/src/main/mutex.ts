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
