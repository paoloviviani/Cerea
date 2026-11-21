import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { CallError } from "$lib/server/code/machineCallError";

/**
 * The limits of relayed coordination (ADR 0121 section 10), counted in Mongo so they hold across
 * a restart and, later, across replicas. The check and the write of one owner run one at a time
 * in this process (the deployment is single-replica for this feature), so two calls racing for
 * the last slot cannot both pass.
 */
export const LIMITS = {
	/** All coord.send, read and spawn of one computer, per minute. */
	perComputerPerMinute: 30,
	/** An owner's sends plus reads, per hour. */
	perOwnerCallsPerHour: 120,
	/** An owner's spawns, per hour. */
	perOwnerSpawnsPerHour: 20,
	/** Cards waiting for an answer, per computer and per owner. */
	pendingAsksPerDevice: 10,
	pendingAsksPerOwner: 20,
	/** Cards asked per owner per hour. */
	asksPerOwnerPerHour: 60,
	/** coord.list calls per computer per minute. */
	listPerMinute: 10,
	/** The most computers one list reaches. */
	maxListedComputers: 20,
	/** The most any one hop may be: past it a call is refused outright. */
	maxHop: 3,
	/** Spawn depth across computers. */
	maxSpawnDepth: 2,
} as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const queues = new Map<string, Promise<unknown>>();

/** One owner's limit checks run one at a time, so each sees the writes of the one before. */
export function serializedFor<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(fn);
	queues.set(key, next);
	const done = () => {
		if (queues.get(key) === next) queues.delete(key);
	};
	next.then(done, done);
	return next;
}

function since(ms: number, now: number): Date {
	return new Date(now - ms);
}

/**
 * Count one send, read or spawn against the computer's and the owner's limits, or refuse with
 * the limit named. A refusal spends nothing.
 */
export function takeCall(
	userId: ObjectId,
	deviceId: string,
	op: "send" | "read" | "spawn",
	now = Date.now()
): Promise<void> {
	return serializedFor(`owner:${userId.toHexString()}`, async () => {
		const perComputer = await collections.codeRelayEvents.countDocuments({
			deviceId,
			kind: "call",
			at: { $gte: since(MINUTE, now) },
		});
		if (perComputer >= LIMITS.perComputerPerMinute) {
			throw new CallError(
				"limit",
				`Agents on this computer have made ${LIMITS.perComputerPerMinute} requests to other computers in the last minute (the limit). Wait a minute and try again.`
			);
		}
		if (op === "spawn") {
			const spawns = await collections.codeRelayEvents.countDocuments({
				userId,
				kind: "call",
				op: "spawn",
				at: { $gte: since(HOUR, now) },
			});
			if (spawns >= LIMITS.perOwnerSpawnsPerHour) {
				throw new CallError(
					"limit",
					`Agents have started ${LIMITS.perOwnerSpawnsPerHour} sessions on other computers in the last hour (the limit). Try again later.`
				);
			}
		} else {
			const calls = await collections.codeRelayEvents.countDocuments({
				userId,
				kind: "call",
				op: { $in: ["send", "read"] },
				at: { $gte: since(HOUR, now) },
			});
			if (calls >= LIMITS.perOwnerCallsPerHour) {
				throw new CallError(
					"limit",
					`Agents have sent or read ${LIMITS.perOwnerCallsPerHour} times across computers in the last hour (the limit). Try again later.`
				);
			}
		}
		await collections.codeRelayEvents.insertOne({
			_id: new ObjectId(),
			kind: "call",
			op,
			userId,
			deviceId,
			at: new Date(now),
		});
	});
}

/** Count one coord.list against the computer's per-minute limit, or refuse. */
export function takeList(userId: ObjectId, deviceId: string, now = Date.now()): Promise<void> {
	return serializedFor(`owner:${userId.toHexString()}`, async () => {
		const n = await collections.codeRelayEvents.countDocuments({
			deviceId,
			kind: "list",
			at: { $gte: since(MINUTE, now) },
		});
		if (n >= LIMITS.listPerMinute) {
			throw new CallError(
				"limit",
				`This computer has listed other computers ${LIMITS.listPerMinute} times in the last minute (the limit). Wait a moment.`
			);
		}
		await collections.codeRelayEvents.insertOne({
			_id: new ObjectId(),
			kind: "list",
			userId,
			deviceId,
			at: new Date(now),
		});
	});
}

/** Why a new card may not be asked right now, or null. Reads only. */
export async function askCapReason(
	userId: ObjectId,
	deviceId: string,
	now = Date.now()
): Promise<string | null> {
	const [device, owner, hour] = await Promise.all([
		collections.codeRelayTickets.countDocuments({ deviceId, state: "asked" }),
		collections.codeRelayTickets.countDocuments({ userId, state: "asked" }),
		collections.codeRelayEvents.countDocuments({
			userId,
			kind: "ask",
			at: { $gte: since(HOUR, now) },
		}),
	]);
	if (device >= LIMITS.pendingAsksPerDevice) {
		return `${LIMITS.pendingAsksPerDevice} requests from this computer are already waiting for approval. Answer or reject some first.`;
	}
	if (owner >= LIMITS.pendingAsksPerOwner) {
		return `${LIMITS.pendingAsksPerOwner} requests across your computers are already waiting for approval. Answer or reject some first.`;
	}
	if (hour >= LIMITS.asksPerOwnerPerHour) {
		return `${LIMITS.asksPerOwnerPerHour} requests to other computers were asked in the last hour (the limit). Try again later.`;
	}
	return null;
}

/** Count a card asked, for the hourly cap. */
export async function noteAsk(userId: ObjectId, deviceId: string, now = Date.now()): Promise<void> {
	await collections.codeRelayEvents.insertOne({
		_id: new ObjectId(),
		kind: "ask",
		userId,
		deviceId,
		at: new Date(now),
	});
}

// -- the hop and depth ledger (section 8) ------------------------------------------------------

/** A target session's ledger row id. */
export function ledgerKey(deviceId: string, sessionId: string): string {
	return `${deviceId}:${sessionId}`;
}

/**
 * The hop a call from `callerSessionId` may carry and the depth a spawn from it would have, from
 * Cerea's own ledger: a compromised computer's claim never lowers either, and a local spawn or a
 * message the owner types into the session clears nothing (only the 24 hour TTL does).
 */
export async function enforcedHop(
	deviceId: string,
	callerSessionId: string,
	claimedHop: number
): Promise<{ hop: number; depth: number }> {
	const row = await collections.codeRelayLedger.findOne({
		_id: ledgerKey(deviceId, callerSessionId),
	});
	return { hop: Math.max(claimedHop, (row?.hop ?? 0) + 1), depth: row?.depth ?? 0 };
}

/** Refuse a hop past the limit, and a spawn past the depth limit. */
export function checkHopAndDepth(hop: number, depth: number, op: "send" | "read" | "spawn"): void {
	if (hop > LIMITS.maxHop) {
		throw new CallError(
			"limit",
			`Hop limit: agents may pass a request on at most ${LIMITS.maxHop} times.`
		);
	}
	if (op === "spawn" && depth + 1 > LIMITS.maxSpawnDepth) {
		throw new CallError(
			"limit",
			`Spawn chain limit: a session started from another computer ${LIMITS.maxSpawnDepth} deep cannot start more.`
		);
	}
}

/** Record a successful relayed delivery: the target session's hop, and for a spawn its depth. */
export async function writeLedger(
	userId: ObjectId,
	deviceId: string,
	sessionId: string,
	hop: number,
	depth: number
): Promise<void> {
	const _id = ledgerKey(deviceId, sessionId);
	await collections.codeRelayLedger.updateOne(
		{ _id },
		{
			$max: { hop, depth },
			$set: { userId, deviceId, sessionId, at: new Date() },
		},
		{ upsert: true }
	);
}
