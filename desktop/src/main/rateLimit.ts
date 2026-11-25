/** At most `max` events in any `windowMs`: a page that opens windows in a loop gets the first few only. */
export class RateLimit {
	private times: number[] = [];
	constructor(
		private readonly max: number,
		private readonly windowMs: number,
		private readonly now: () => number = Date.now
	) {}
	take(): boolean {
		const t = this.now();
		this.times = this.times.filter((x) => t - x < this.windowMs);
		if (this.times.length >= this.max) return false;
		this.times.push(t);
		return true;
	}
}
