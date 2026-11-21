import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { config } from "$lib/server/config";
import {
	deviceMachineCapabilities,
	devicePolicy,
	isMachineOnline,
	MachineLink,
} from "$lib/server/code/machines";
import { CallError } from "$lib/server/code/machineCallError";
import { stepOf, type Session, type Workspace } from "$lib/types/machineProtocol";
import type { CodeDevice } from "$lib/types/CodeAgent";
import type { RelayCardFacts, RelayOp } from "$lib/types/CodeRelay";

/**
 * Cerea reads, itself and live, every name a relay card shows and every fact the call is checked
 * against (ADR 0121 sections 3 and 5): the computers' names from its own device records, the
 * workspace and session from each machine's own listing. Nothing here is taken from a call frame
 * or a card's metadata, so a computer that lies about itself or about its target changes
 * nothing a person reads or a ticket binds.
 */

/** The word of a session as a card shows it and the ticket compares it. */
export type Word = "plan" | "ask" | "auto" | "allow";
const WORD_RANK: Record<Word, number> = { plan: 0, ask: 1, auto: 2, allow: 3 };

export function wordOf(session: Session): Word {
	const step = stepOf(session.permissionMode, session.autoClasses);
	if (step === "deny") return "plan";
	if (step === "allow") return "allow";
	if (step === "auto") return "auto";
	return "ask";
}

/** True when `now` is a looser word than `then`: a session that was moved up since the card. */
export function looser(now: Word, then: Word): boolean {
	return WORD_RANK[now] > WORD_RANK[then];
}

const NO_SUCH_COMPUTER = "No such computer.";

/** The number of chat replicas the deployment runs; more than one makes a missing link ambiguous. */
let replicasOverride: number | undefined;

/** Specs: pretend this many chat replicas run (undefined restores the setting). */
export function setChatReplicasForTests(n: number | undefined): void {
	replicasOverride = n;
}

export function chatReplicas(): number {
	if (replicasOverride !== undefined) return replicasOverride;
	const n = Number(config.CHAT_REPLICAS);
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * The owner's own paired computer, or the one refusal every other case gets: another owner's,
 * an unpaired, a revoked or a non-existent id read the same, so ids of other people's computers
 * cannot be probed.
 */
export async function ownedDevice(userId: ObjectId, computerId: string): Promise<CodeDevice> {
	if (!/^[0-9a-f]{24}$/.test(computerId)) throw new CallError("forbidden", NO_SUCH_COMPUTER);
	const device = await collections.codeDevices.findOne({
		_id: new ObjectId(computerId),
		userId,
		status: "paired",
	});
	if (!device) throw new CallError("forbidden", NO_SUCH_COMPUTER);
	return device;
}

/** Whether a computer takes relayed requests, and if not the refusal. */
export function relayRefusal(device: CodeDevice): CallError | null {
	const id = device._id.toHexString();
	if (!isMachineOnline(id)) {
		// With one chat replica a missing link is a computer that is off. With several, the link may
		// be held by another process: say that, instead of a plain offline (ADR 0121 section 14).
		if (chatReplicas() > 1) {
			return new CallError(
				"unavailable",
				`${device.name} is unreachable from this server: its connection may be held by another replica. Nothing was sent.`
			);
		}
		return new CallError("unavailable", `${device.name} is offline; nothing was sent.`);
	}
	// The live hello is the truth; the device row is only what it last said.
	if (deviceMachineCapabilities(id)?.relayedCoordination !== true) {
		return new CallError(
			"unsupported",
			`${device.name} runs an older galopin that cannot take relayed requests. Update it.`
		);
	}
	const policy = devicePolicy(id);
	if (policy?.relayedCoordination === "denied" || policy?.agentTools === "denied") {
		return new CallError(
			"unsupported",
			`${device.name}'s owner turned relayed coordination off on that computer.`
		);
	}
	return null;
}

/** What `coord.resolve` and the ask-time record need of the caller. */
export interface CallerFacts {
	computer: string;
	workspaceId: string;
	workspace: string;
	sessionTitle: string;
}

async function workspaceName(link: MachineLink, workspaceId: string): Promise<string> {
	const { workspaces } = await link.workspaceList();
	return workspaces.find((w: Workspace) => w.id === workspaceId)?.name ?? "";
}

/** The caller's computer, workspace and session title, read from its own link. */
export async function callerFacts(
	userId: ObjectId,
	deviceId: string,
	sessionId: string
): Promise<CallerFacts> {
	const device = await collections.codeDevices.findOne(
		{ _id: new ObjectId(deviceId), userId },
		{ projection: { name: 1 } }
	);
	if (!device) throw new CallError("forbidden", "This machine is not known to Cerea.");
	const link = new MachineLink(deviceId);
	let session: Session;
	try {
		session = (await link.sessionGet({ sessionId })).session;
	} catch {
		throw new CallError("not_found", "Cerea could not find the calling session on its computer.");
	}
	if (session.parentId) {
		throw new CallError("forbidden", "A subagent cannot reach other computers.");
	}
	let workspace = "";
	try {
		workspace = await workspaceName(link, session.workspaceId);
	} catch {
		// A name is for display; the call does not depend on it.
	}
	return {
		computer: device.name,
		workspaceId: session.workspaceId,
		workspace,
		sessionTitle: session.title,
	};
}

export interface TargetArgs {
	op: RelayOp;
	computerId: string;
	sessionId?: string | undefined;
	workspaceId?: string | undefined;
}

/** What the live read of the target found. */
export interface TargetFacts {
	device: CodeDevice;
	computer: string;
	workspaceId: string;
	workspace: string;
	session?: { id: string; title: string; agentMode: string; word: Word; status: string };
}

/**
 * The target as it is now. Requires the owner's device, live and able; a session must be a
 * top-level one (a subagent is "not found"), a workspace must exist on that computer.
 */
export async function targetFacts(userId: ObjectId, args: TargetArgs): Promise<TargetFacts> {
	const device = await ownedDevice(userId, args.computerId);
	const refusal = relayRefusal(device);
	if (refusal) throw refusal;
	const link = new MachineLink(args.computerId);
	if (args.op === "spawn") {
		if (!args.workspaceId) throw new CallError("invalid", "Say which workspace (workspaceId).");
		let workspaces: Workspace[];
		try {
			workspaces = (await link.workspaceList()).workspaces;
		} catch {
			throw new CallError("unavailable", `${device.name} did not answer; nothing was sent.`);
		}
		const ws = workspaces.find((w) => w.id === args.workspaceId);
		if (!ws) throw new CallError("not_found", `No such workspace on ${device.name}.`);
		return { device, computer: device.name, workspaceId: ws.id, workspace: ws.name };
	}
	if (!args.sessionId) throw new CallError("invalid", "Say which session (sessionId).");
	let session: Session;
	try {
		session = (await link.sessionGet({ sessionId: args.sessionId })).session;
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code === "unavailable") {
			throw new CallError("unavailable", `${device.name} did not answer; nothing was sent.`);
		}
		throw new CallError("not_found", `No such session on ${device.name}.`);
	}
	// A subagent is never an addressable session; and a session that is itself a child of another
	// tree reads the same.
	if (session.parentId) throw new CallError("not_found", `No such session on ${device.name}.`);
	let workspace = "";
	try {
		workspace = await workspaceName(link, session.workspaceId);
	} catch {
		// display only
	}
	return {
		device,
		computer: device.name,
		workspaceId: session.workspaceId,
		workspace,
		session: {
			id: session.id,
			title: session.title,
			agentMode: session.modeId ?? "",
			word: wordOf(session),
			status: session.status,
		},
	};
}

/** The facts a relay card and a ticket carry, from the live reads and the covered fields. */
export function cardFacts(
	op: RelayOp,
	caller: CallerFacts,
	callerSessionTitle: string,
	target: TargetFacts,
	covered: {
		hop: number;
		text?: string | null;
		prompt?: string | null;
		last?: number | null;
		title?: string | null;
		mode?: string | null;
	}
): RelayCardFacts {
	return {
		op,
		hop: covered.hop,
		caller: { computer: caller.computer, workspace: caller.workspace, session: callerSessionTitle },
		target: {
			computer: target.computer,
			workspace: target.workspace,
			...(target.session
				? {
						session: target.session.title,
						agentMode: target.session.agentMode,
						word: target.session.word,
						status: target.session.status,
					}
				: {}),
		},
		...(covered.text != null ? { text: covered.text } : {}),
		...(covered.prompt != null ? { prompt: covered.prompt } : {}),
		...(covered.last != null ? { last: covered.last } : {}),
		...(covered.title != null ? { title: covered.title } : {}),
		...(covered.mode != null ? { mode: covered.mode } : {}),
	};
}
