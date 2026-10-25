/**
 * What a schedule's two coordination options mean, and what a machine can do
 * about them — one place for the editor (which warns) and the executor (which
 * acts), so the two cannot word or decide it differently.
 *
 * The options map onto `session.grantCoordination` (PROTOCOL.md §6):
 *  - "Can find, read and message other sessions" → `session_list`,
 *    `session_read`, `session_send`;
 *  - "Can start new sessions" → `session_spawn`.
 * A grant is never more than the machine allows: its ceiling still caps a key
 * (ask still asks, deny still refuses), a session in another workspace still
 * asks, and the hop and rate limits stand.
 */
import type { CoordinationKey, Policy } from "$lib/types/machineProtocol";
import { COORDINATION_KEYS } from "$lib/types/machineProtocol";

export interface CoordinationOptions {
	/** Find, read and message other sessions. */
	canMessage?: boolean;
	/** Start new sessions. */
	canSpawn?: boolean;
}

/** The keys the options grant, in the wire's order. Empty when both are off. */
export function coordinationKeys(options: CoordinationOptions): CoordinationKey[] {
	const wanted = new Set<CoordinationKey>();
	if (options.canMessage) {
		wanted.add("session_list");
		wanted.add("session_read");
		wanted.add("session_send");
	}
	if (options.canSpawn) wanted.add("session_spawn");
	return COORDINATION_KEYS.filter((key) => wanted.has(key));
}

/** The reverse: a grant read back (the dialog's initial state) as the two
 * options. The machine only ever holds the shapes above, but a set that is
 * not exactly one of them still reads truthfully — a partial message set
 * leaves the switch off rather than claiming it. */
export function coordinationOptions(keys: readonly string[]): CoordinationOptions {
	return {
		canMessage:
			keys.includes("session_list") &&
			keys.includes("session_read") &&
			keys.includes("session_send"),
		canSpawn: keys.includes("session_spawn"),
	};
}

/** What the run row and the editor say about a galopin that cannot grant. */
export const TOO_OLD_DETAIL = "this machine's galopin is too old to grant coordination; update it";
export const TOOLS_OFF_DETAIL =
	"this machine was enrolled without agent tools, so coordination cannot be granted";

interface DeviceFacts {
	backends?: { capabilities?: { coordinationGrant?: boolean } }[];
	policy?: Pick<Policy, "agentTools" | "permission">;
}

export type CoordinationSupport =
	{ ok: true } | { ok: false; reason: "too-old" | "tools-off"; detail: string };

/** Whether the machine's galopin can take a grant: the `coordinationGrant`
 * capability its hello reported, and agent tools not switched off. A galopin
 * that predates the op reports neither. */
export function coordinationSupport(device: DeviceFacts | undefined): CoordinationSupport {
	if (device?.policy?.agentTools === "denied") {
		return { ok: false, reason: "tools-off", detail: TOOLS_OFF_DETAIL };
	}
	const capable = (device?.backends ?? []).some((b) => b.capabilities?.coordinationGrant === true);
	return capable ? { ok: true } : { ok: false, reason: "too-old", detail: TOO_OLD_DETAIL };
}

const VERB: Record<CoordinationKey, string> = {
	session_list: "finding",
	session_read: "reading",
	session_send: "messaging",
	session_spawn: "starting",
};

/** The granted keys the machine's ceiling holds below allow. */
export function cappedCoordination(
	device: DeviceFacts | undefined,
	keys: CoordinationKey[]
): { ask: CoordinationKey[]; deny: CoordinationKey[] } {
	const max = device?.policy?.permission?.max ?? {};
	return {
		ask: keys.filter((k) => max[k] === "ask"),
		deny: keys.filter((k) => max[k] === "deny"),
	};
}

const list = (keys: CoordinationKey[]) => {
	const words = keys.map((k) => VERB[k]);
	const joined =
		words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0];
	return `${joined} sessions`;
};

/** One sentence per cap that bites, or null. */
export function ceilingNote(
	device: DeviceFacts | undefined,
	keys: CoordinationKey[]
): string | null {
	const { ask, deny } = cappedCoordination(device, keys);
	const parts: string[] = [];
	if (ask.length)
		parts.push(
			`This machine caps ${list(ask)} at Ask, so those calls will still wait in the Needs-you inbox.`
		);
	if (deny.length) parts.push(`This machine refuses ${list(deny)}, so those calls will not run.`);
	return parts.length ? parts.join(" ") : null;
}
