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

// -- Upgrade from Cerea (C159) ---------------------------------------------------
//
// galopin reports `hello.agent.upgrade = {inPlace, reason}`: whether it can upgrade itself when
// Cerea asks (`machine.upgrade`, PROTOCOL.md §6). Cerea offers the Upgrade button only for
// `inPlace: true`; every other case keeps showing the instructions that fit it.

/** `hello.agent.upgrade`. `reason`: "systemd" (inPlace), or "docker", "mac_app", "foreground",
 * "disabled". An unknown reason from a newer galopin reads as the generic curl instructions. */
export interface GalopinUpgradeCapability {
	inPlace: boolean;
	reason: string;
}

/** How long a started upgrade may take before it is reported as not completed. */
export const UPGRADE_TIMEOUT_MS = 5 * 60_000;
/** A hello with the old version this soon after the start is the still-running galopin (a
 * reconnect before the installer stopped it), not a failed upgrade. */
export const UPGRADE_OLD_HELLO_GRACE_MS = 120_000;

export type UpgradeRunState = "running" | "done" | "failed";

/** What Cerea records when the owner starts an upgrade. */
export interface UpgradeRun {
	startedAt: Date;
	fromVersion: string;
	targetVersion: string;
	state: UpgradeRunState;
	finishedAt?: Date;
	/** The version the computer reported when it came back. */
	version?: string;
}

/** What the Agents panel shows for a computer's upgrade. */
export type UpgradeInstructions =
	| "button" // Upgrade button
	| "mac_app" // through the Cerea connector app's installer
	| "docker" // docker pull and recreate
	| "launchd" // macOS `galopin service install`: uninstall, upgrade, install
	| "foreground" // the curl command in a terminal outside galopin
	| "curl"; // the curl command (opted out, or a galopin that reports nothing)

/** Which way a computer is upgraded: the button only when it reported `inPlace: true` and is
 * online; the owner's say is implied (Cerea only lists a user's own computers). */
export function upgradeInstructions(device: {
	agentContainer?: boolean;
	agentUpgrade?: GalopinUpgradeCapability | null;
	online: boolean;
}): UpgradeInstructions {
	if (device.agentContainer || device.agentUpgrade?.reason === "docker") return "docker";
	const cap = device.agentUpgrade;
	if (!cap) return "curl";
	if (cap.inPlace) return device.online ? "button" : "curl";
	if (cap.reason === "mac_app") return "mac_app";
	if (cap.reason === "launchd") return "launchd";
	if (cap.reason === "foreground") return "foreground";
	return "curl";
}

/** Whether `have` is at or above `target`; false when either is unparseable. */
export function versionAtLeast(have: string | undefined | null, target: string): boolean {
	const h = parse(have);
	const t = parse(target);
	if (!h || !t) return false;
	return !galopinNeedsUpgrade(have, target);
}

/** How long a finished upgrade stays on the card. */
export const UPGRADE_RESULT_TTL_MS = 10 * 60_000;

/** The run after the computer says hello, or null to clear it. A running one: done with a
 * version at or above the target; failed with an older one once the grace has passed; otherwise
 * unchanged. A finished one is cleared once the computer reports the target version (a failed
 * run it has since got past) or its result is older than the TTL. */
export function resolveUpgradeOnHello(
	run: UpgradeRun,
	helloVersion: string,
	now: Date
): UpgradeRun | null {
	if (run.state === "running") {
		if (versionAtLeast(helloVersion, run.targetVersion)) {
			return { ...run, state: "done", finishedAt: now, version: helloVersion };
		}
		if (now.getTime() - run.startedAt.getTime() >= UPGRADE_OLD_HELLO_GRACE_MS) {
			return { ...run, state: "failed", finishedAt: now, version: helloVersion };
		}
		return run;
	}
	if (run.state === "failed" && versionAtLeast(helloVersion, run.targetVersion)) return null;
	if (finishedLongAgo(run, now)) return null;
	return run;
}

function finishedLongAgo(run: UpgradeRun, now: Date): boolean {
	const end = run.finishedAt?.getTime() ?? run.startedAt.getTime() + UPGRADE_TIMEOUT_MS;
	return now.getTime() - end >= UPGRADE_RESULT_TTL_MS;
}

/** The run as shown now: a running one older than the timeout is failed; a finished one is gone
 * after the TTL, and a failed one once the computer is at the target version. */
export function upgradeRunView(
	run: UpgradeRun | undefined | null,
	now: Date,
	deviceVersion?: string | null
): UpgradeRun | null {
	if (!run) return null;
	let shown = run;
	if (run.state === "running" && now.getTime() - run.startedAt.getTime() >= UPGRADE_TIMEOUT_MS) {
		shown = { ...run, state: "failed" };
	}
	if (shown.state === "running") return shown;
	if (shown.state === "failed" && versionAtLeast(deviceVersion, run.targetVersion)) return null;
	if (finishedLongAgo(shown, now)) return null;
	return shown;
}

/** Where the installer's log of an upgrade is, on the computer. */
export const UPGRADE_LOG_HINT = "~/.config/galopin/backups/upgrade-<date>.log";
