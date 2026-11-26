/**
 * Which connectors a user's agents may use: ONE list per user, in Workspace -> Agents.
 *
 * The list holds the user's Cerea connectors (`base:<name>`, `connector:<id>`) and each paired
 * computer's own servers (`local:<device>:<server>`, so a server is scoped to its computer by
 * its key). Default none. It is Cerea's, never the machine's: a machine can only ever name what a
 * user listed, and the resolver (ADR 0104) re-applies the deployment's modes and the user's
 * Workspace -> Connectors switches at every list and call.
 *
 * Two consumers read it:
 *  - Cerea-driven agents (a coding session: opencode, goose, ACP): the list, minus what that
 *    session turned off for itself (a per-session NARROWING; a session never widens the list).
 *    Every call still goes through the session's Plan / Ask / Allow / Auto.
 *  - Apps on the user's computers (goose Desktop, Claude Code in a terminal, any MCP client,
 *    through galopin's local endpoint): the list's Cerea connectors, while the user's one switch
 *    ("apps too", on by default) is on. Those calls are governed by the app's own approval and
 *    audited.
 *
 * Storage: the `codeSessionConnectors` collection. The user's list is the one reserved row
 * (`deviceId "*"`, `sessionId "local-agents"`: the id the old local-agents row already had, so
 * nothing moves). It stamps `savedAt`, not `updatedAt`, because the collection's 365-day TTL
 * is on `updatedAt` and a user's list must not expire. A session's row holds only `off`.
 */
import { isBrowserRuntimeServer } from "$lib/server/browser/contract";
import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { localConnectorsEnabled } from "$lib/server/codeEnabled";
import { resolveConnectors, type TurnConnector } from "$lib/server/mcp/turnConnectors";
import { localConnectorId, parseLocalConnectorId } from "$lib/server/mcp/localUrl";
import { localDevicesOf, serversOf } from "$lib/server/mcp/local";
import { policyIn, loadPolicies, isLocalKey } from "$lib/server/mcp/deploymentModes";
import { compareConnectors, localServerLabel } from "$lib/server/mcp/connectorBlurb";
import { ownedDevice } from "$lib/server/code/agentSessions";
import type { CodeDevice } from "$lib/types/CodeAgent";

export const MAX_SESSION_CONNECTORS = 200;

export interface AgentConnectorOption {
	key: string;
	name: string;
	kind: "base" | "connector" | "local";
	/** What the connector says about itself (plain, short); never a tool's description. "" when nothing. */
	summary: string;
	/** Secondary text after the name: a computer's own server id, when the title is its proper name. */
	detail?: string;
	/** Why it cannot be used now, for the switch list ("needs sign-in", "switched off"). */
	unavailable?: "switched off" | "needs sign-in" | "same name";
	/** Offered by the administrator as always on. Still an opt-in for an agent. */
	locked?: boolean;
}

/** The one reserved row that holds a user's list. */
export const USER_LIST_DEVICE = "*";
export const USER_LIST_SESSION = "local-agents";
const userRow = (userId: ObjectId) => ({
	userId,
	deviceId: USER_LIST_DEVICE,
	sessionId: USER_LIST_SESSION,
});

/** Cerea's connectors a user could switch on, with why one cannot be used now. */
async function cereaOptions(userId: ObjectId): Promise<AgentConnectorOption[]> {
	const { connectors, blocked } = await resolveConnectors(userId);
	const policies = await loadPolicies().catch(() => new Map());
	const options: AgentConnectorOption[] = connectors
		.filter((c) => c.kind !== "local")
		.map((c) => ({
			key: c.key,
			name: c.name,
			kind: c.kind as "base" | "connector",
			summary: c.blurb,
			...(policyIn(policies, c.key).mode === "locked" ? { locked: true } : {}),
		}));
	for (const b of blocked) {
		if (isLocalKey(b.key)) continue;
		options.push({
			key: b.key,
			name: b.name,
			kind: "connector",
			summary: "",
			unavailable: b.reason,
		});
	}
	return options;
}

/** A paired computer's own servers, as options keyed to that computer. */
async function computerOptions(device: CodeDevice): Promise<AgentConnectorOption[]> {
	const deviceId = device._id.toString();
	const { servers } = await serversOf(device);
	const options: AgentConnectorOption[] = [];
	for (const s of servers) {
		// The browser runtime is `browse`'s, never a connector an agent can opt in to.
		if (isBrowserRuntimeServer(s.name)) continue;
		const label = localServerLabel(s.name, s.description);
		options.push({
			key: localConnectorId(deviceId, s.name),
			name: label.title,
			kind: "local",
			summary: label.blurb,
			...(label.detail ? { detail: label.detail } : {}),
		});
	}
	return options.sort(compareConnectors);
}

export interface ComputerOptions {
	deviceId: string;
	name: string;
	options: AgentConnectorOption[];
}

/** What a user may put on their list: Cerea's connectors, and each paired computer's own servers. */
export async function listChoices(
	userId: ObjectId
): Promise<{ options: AgentConnectorOption[]; computers: ComputerOptions[] }> {
	const options = (await cereaOptions(userId)).sort(compareConnectors);
	if (!localConnectorsEnabled()) return { options, computers: [] };
	const devices = await localDevicesOf(userId);
	const computers = await Promise.all(
		devices.map(async (d) => ({
			deviceId: d._id.toString(),
			name: d.name,
			options: await computerOptions(d).catch(() => []),
		}))
	);
	return { options, computers: computers.sort((a, b) => compareConnectors(a, b)) };
}

let merging: Promise<unknown> | null = null;
/** The old two lists are merged once per process, on the first read (see `mergeConnectorLists`). */
function mergedOnce(): Promise<unknown> {
	merging ??= mergeConnectorLists().catch((err) => {
		merging = null;
		logger.error({ err: String(err) }, "connector_lists_merge_failed");
	});
	return merging;
}

export async function getUserList(userId: ObjectId): Promise<{ keys: string[]; appsToo: boolean }> {
	await mergedOnce();
	const row = await collections.codeSessionConnectors.findOne(userRow(userId));
	return { keys: row?.keys ?? [], appsToo: row?.appsToo !== false };
}

/**
 * Replace the user's list and/or the "apps too" switch. Every key must be one they can list now
 * (a stale key sent back is simply dropped); an empty list clears it.
 */
export async function setUserList(
	userId: ObjectId,
	change: { keys?: string[]; appsToo?: boolean }
): Promise<{ keys: string[]; appsToo: boolean }> {
	const current = await getUserList(userId);
	let keys = current.keys;
	if (change.keys) {
		const unique = [...new Set(change.keys)];
		if (unique.length > MAX_SESSION_CONNECTORS) {
			throw new SessionConnectorsError(`At most ${MAX_SESSION_CONNECTORS} connectors.`);
		}
		const choices = await listChoices(userId);
		const allowed = new Set(
			[...choices.options, ...choices.computers.flatMap((c) => c.options)]
				.filter((o) => !o.unavailable)
				.map((o) => o.key)
		);
		const known = new Set(current.keys);
		if (unique.some((k) => !allowed.has(k) && !known.has(k))) {
			throw new SessionConnectorsError("One of those connectors is not available to you.");
		}
		keys = unique.filter((k) => allowed.has(k));
	}
	const appsToo = change.appsToo ?? current.appsToo;
	const now = new Date();
	await collections.codeSessionConnectors.updateOne(
		userRow(userId),
		{
			$set: { keys, appsToo, savedAt: now },
			$unset: { updatedAt: "", off: "" },
			$setOnInsert: { createdAt: now },
		},
		{ upsert: true }
	);
	return { keys, appsToo };
}

/** Everything a user could list for a session on `deviceId`: Cerea's connectors and that computer's own servers. */
export async function availableOptions(
	userId: ObjectId,
	deviceId: string
): Promise<AgentConnectorOption[]> {
	const options = await cereaOptions(userId);
	if (localConnectorsEnabled()) {
		const device = await ownedDevice(userId, deviceId);
		if (device && device.status === "paired") {
			options.push(...(await computerOptions(device).catch(() => [])));
		}
	}
	return options;
}

/** What a session on `deviceId` inherits: the user's list, as options (Cerea's and that computer's own). */
export async function connectorOptions(
	userId: ObjectId,
	deviceId: string
): Promise<AgentConnectorOption[]> {
	const { keys } = await getUserList(userId);
	if (keys.length === 0) return [];
	const listed = new Set(keys);
	const options = await availableOptions(userId, deviceId);
	return options.filter((o) => listed.has(o.key)).sort(compareConnectors);
}

async function getSessionOff(
	userId: ObjectId,
	deviceId: string,
	sessionId: string
): Promise<string[]> {
	const row = await collections.codeSessionConnectors.findOne({ userId, deviceId, sessionId });
	return row?.off ?? [];
}

/** What a session has on: its inherited options minus the ones it turned off. */
export async function getSessionConnectorKeys(
	userId: ObjectId,
	deviceId: string,
	sessionId: string
): Promise<string[]> {
	const [options, off] = await Promise.all([
		connectorOptions(userId, deviceId),
		getSessionOff(userId, deviceId, sessionId),
	]);
	const gone = new Set(off);
	return options.filter((o) => !gone.has(o.key)).map((o) => o.key);
}

export class SessionConnectorsError extends Error {}

/**
 * Set what a session has on, as a NARROWING of the user's list: every inherited connector not in
 * `active` is turned off for this session. A key outside the list is refused (a session never
 * widens it). All on clears the session's row.
 */
export async function setSessionConnectorKeys(
	userId: ObjectId,
	deviceId: string,
	sessionId: string,
	active: string[]
): Promise<string[]> {
	const device = await ownedDevice(userId, deviceId);
	if (!device || device.status !== "paired") {
		throw new SessionConnectorsError("That computer is not one of yours.");
	}
	const inherited = (await connectorOptions(userId, deviceId)).map((o) => o.key);
	const wanted = new Set(active);
	if (active.some((k) => !inherited.includes(k))) {
		throw new SessionConnectorsError("One of those connectors is not on your list.");
	}
	const off = inherited.filter((k) => !wanted.has(k));
	if (off.length === 0) {
		await collections.codeSessionConnectors.deleteOne({ userId, deviceId, sessionId });
	} else {
		const now = new Date();
		await collections.codeSessionConnectors.updateOne(
			{ userId, deviceId, sessionId },
			{
				$set: { off, updatedAt: now },
				$unset: { keys: "" },
				$setOnInsert: { createdAt: now },
			},
			{ upsert: true }
		);
	}
	return inherited.filter((k) => wanted.has(k));
}

/**
 * A project's agent profile narrows the sessions the project starts to the connectors it names
 * (those still on the user's list; one that has since left the list is ignored). A profile with
 * no connectors does not narrow.
 */
export async function narrowSessionToProfile(
	userId: ObjectId,
	deviceId: string,
	sessionId: string,
	only: string[]
): Promise<void> {
	if (only.length === 0) return;
	const inherited = (await connectorOptions(userId, deviceId)).map((o) => o.key);
	const keep = inherited.filter((k) => only.includes(k));
	await setSessionConnectorKeys(userId, deviceId, sessionId, keep);
}

export interface SessionConnectorsNow {
	/** On and usable now, resolved by the chat's own resolver. */
	cerea: TurnConnector[];
	/** Server names on the session's own machine, on. */
	local: string[];
}

/** What a session may use right now: the user's list minus its narrowing, re-filtered by the resolver. */
export async function connectorsNow(
	userId: ObjectId,
	deviceId: string,
	sessionId: string
): Promise<SessionConnectorsNow> {
	const { keys } = await getUserList(userId);
	if (keys.length === 0) return { cerea: [], local: [] };
	const off = new Set(await getSessionOff(userId, deviceId, sessionId));
	const wanted = new Set(keys.filter((k) => !off.has(k)));
	const { connectors } = await resolveConnectors(userId);
	const cerea = connectors.filter((c) => c.kind !== "local" && wanted.has(c.key));
	const local: string[] = [];
	if (localConnectorsEnabled()) {
		for (const k of wanted) {
			const ref = parseLocalConnectorId(k);
			// Only this session's own machine: a key naming another machine is never served here.
			if (ref && ref.deviceId === deviceId) local.push(ref.server);
		}
	}
	return { cerea, local };
}

/**
 * What apps on the user's computers (galopin's local endpoint) may use: the list's Cerea
 * connectors while the user's "apps too" switch is on, nothing when it is off. A computer's own
 * servers are never served this way: an app on that computer has them directly.
 */
export async function localAgentConnectorsNow(userId: ObjectId): Promise<SessionConnectorsNow> {
	const { keys, appsToo } = await getUserList(userId);
	if (!appsToo || keys.length === 0) return { cerea: [], local: [] };
	const wanted = new Set(keys);
	const { connectors } = await resolveConnectors(userId);
	return { cerea: connectors.filter((c) => c.kind !== "local" && wanted.has(c.key)), local: [] };
}

/**
 * The one-time merge of the old two lists into one (idempotent; run once per process on the first read, and a no-op
 * once done). A user's list becomes the union of their old local-agents keys and every old
 * session's keys, so nobody loses reach a session had (every call still asks as the session's
 * permissions say); the "apps too" switch is on (its default); the old per-session "on" rows
 * are removed, which means no narrowing.
 */
export async function mergeConnectorLists(): Promise<number> {
	const col = collections.codeSessionConnectors;
	const old = col.find({ deviceId: { $ne: USER_LIST_DEVICE }, keys: { $exists: true } });
	const byUser = new Map<string, { userId: ObjectId; keys: Set<string> }>();
	for await (const row of old) {
		const id = row.userId.toString();
		const entry = byUser.get(id) ?? { userId: row.userId, keys: new Set<string>() };
		for (const k of row.keys ?? []) entry.keys.add(k);
		byUser.set(id, entry);
	}
	for (const { userId, keys } of byUser.values()) {
		const current = await col.findOne(userRow(userId));
		const union = [...new Set([...(current?.keys ?? []), ...keys])];
		const now = new Date();
		await col.updateOne(
			userRow(userId),
			{
				$set: { keys: union, savedAt: now },
				$unset: { updatedAt: "" },
				$setOnInsert: { createdAt: now },
			},
			{ upsert: true }
		);
		await col.deleteMany({ userId, deviceId: { $ne: USER_LIST_DEVICE }, keys: { $exists: true } });
	}
	// The old user row stamped `updatedAt`, which the collection's TTL would expire.
	await col.updateMany(
		{ deviceId: USER_LIST_DEVICE, sessionId: USER_LIST_SESSION, updatedAt: { $exists: true } },
		[{ $set: { savedAt: "$updatedAt" } }, { $unset: "updatedAt" }]
	);
	if (byUser.size > 0) logger.info({ users: byUser.size }, "connector_lists_merged");
	return byUser.size;
}
