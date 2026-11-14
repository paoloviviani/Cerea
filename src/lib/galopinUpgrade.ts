/**
 * The upgrade hint of the Agents panel: a computer whose galopin reports an
 * older version than this Cerea shows the one-line upgrade command. galopin's
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

/** True when the machine reports a parseable version older than the server's.
 * A machine that has not reported one yet (a row from before this field) is not nagged. */
export function galopinNeedsUpgrade(
	machineVersion: string | undefined | null,
	serverVersion: string
): boolean {
	const have = parse(machineVersion);
	const want = parse(serverVersion);
	if (!have || !want) return false;
	for (let i = 0; i < 3; i++) {
		if (have[i] !== want[i]) return have[i] < want[i];
	}
	return false;
}

/** `curl -fsSL <origin>/galopin/install.sh | sh -s -- --upgrade` */
export function buildUpgradeCommand(origin: string): string {
	return `curl -fsSL ${quoteShellArg(`${origin}/galopin/install.sh`)} | sh -s -- --upgrade`;
}
