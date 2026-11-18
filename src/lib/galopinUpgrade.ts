/**
 * The upgrade hint of the Agents panel: a computer whose galopin reports a
 * version older than the last release that changed galopin (`agent/LAST_CHANGED`,
 * not this Cerea's own version) shows the one-line upgrade command. galopin's
 * version is the Cerea release it was built from (`hello.agent.version`); a
 * galopin from before that reports "0.1.0", which is older than every release.
 * The command runs the installer served by this Cerea in `--upgrade` mode
 * (`src/lib/server/galopinUpgrade.sh`), which keeps enrollment and settings.
 */
import { quoteShellArg } from "$lib/codeEnrollPolicy";

function parse(version: string | undefined | null): [number, number, number] | null {
	const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec((version ?? "").trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when the machine reports a parseable version older than `lastChanged`, the last
 * release that changed galopin. A machine that has not reported one yet is not nagged. */
export function galopinNeedsUpgrade(
	machineVersion: string | undefined | null,
	lastChanged: string
): boolean {
	const have = parse(machineVersion);
	const want = parse(lastChanged);
	if (!have || !want) return false;
	for (let i = 0; i < 3; i++) {
		if (have[i] !== want[i]) return have[i] < want[i];
	}
	return false;
}

/** True when the machine's galopin is below the oldest one this Cerea supports: the strong
 * warning, against the soft one of `galopinNeedsUpgrade`. */
export function galopinUnsupported(
	machineVersion: string | undefined | null,
	minSupported: string
): boolean {
	return galopinNeedsUpgrade(machineVersion, minSupported);
}

/** `curl -fsSL <origin>/galopin/install.sh | sh -s -- --upgrade` */
export function buildUpgradeCommand(origin: string): string {
	return `curl -fsSL ${quoteShellArg(`${origin}/galopin/install.sh`)} | sh -s -- --upgrade`;
}
