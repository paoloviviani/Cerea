/** galopin's output, kept per profile (and one for the app itself), at most 500 lines each. */
export const APP_LOG = "app";

export class ProfileLogs {
	private readonly logs = new Map<string, string[]>();
	constructor(private readonly max = 500) {}
	get(id: string | undefined): string[] {
		return this.logs.get(id ?? APP_LOG) ?? [];
	}
	add(id: string | undefined, line: string): void {
		const key = id ?? APP_LOG;
		this.logs.set(key, [...this.get(id).slice(-(this.max - 1)), line]);
	}
	drop(id: string): void {
		this.logs.delete(id);
	}
}
