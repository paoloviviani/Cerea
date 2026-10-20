import { readFileSync } from "node:fs";

/** What AVX-capable machines (and CI) run. */
export const MONGOD_VERSION = "7.0.18";

/**
 * The last series that does not need AVX. MongoDB 5.0+ is built for it and dies
 * with SIGILL on the first AVX instruction, so a CPU without it can only run 4.4.
 */
export const MONGOD_VERSION_NO_AVX = "4.4.30";

/** Whether this machine's CPU advertises AVX. Unknown (not Linux, unreadable) counts as yes. */
export function cpuHasAvx(cpuinfo?: string): boolean {
	try {
		const text =
			cpuinfo ?? (process.platform === "linux" ? readFileSync("/proc/cpuinfo", "utf8") : "");
		if (!text) return true;
		return /^flags\s*:.*\bavx\b/m.test(text);
	} catch {
		return true;
	}
}

/** The mongod binary version `mongodb-memory-server` should use on this machine. */
export function mongoMemoryVersion(cpuinfo?: string): string {
	return cpuHasAvx(cpuinfo) ? MONGOD_VERSION : MONGOD_VERSION_NO_AVX;
}
