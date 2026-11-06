/**
 * Which connectors a coding-agent session may use (ADR 0108, item 3: the MCP reverse path).
 *
 * The opt-in is a user's choice, per session (and a per-project default for sessions a chat
 * starts), and its default is none. It lives here, in Cerea, so a machine can only ever name what
 * a user switched on. What a session *may use right now* is that choice intersected with the
 * chat's own resolver (ADR 0104): a connector the administrator set Off, one the user switched
 * off in Workspace, one that needs a sign-in or a key: all are left out, exactly as in the chat.
 */
import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { localConnectorsEnabled } from "$lib/server/codeEnabled";
import { resolveConnectors, type TurnConnector } from "$lib/server/mcp/turnConnectors";
import { localConnectorId, parseLocalConnectorId } from "$lib/server/mcp/localUrl";
import { serversOf, servesLocalConnectors } from "$lib/server/mcp/local";
import { policyIn, loadPolicies, isLocalKey } from "$lib/server/mcp/deploymentModes";
import { ownedDevice } from "$lib/server/code/agentSessions";

export const MAX_SESSION_CONNECTORS = 50;

export interface AgentConnectorOption {
	key: string;
	name: string;
	kind: "base" | "connector" | "local";
	summary: string;
	/** Why it cannot be used now, for the switch list ("needs sign-in", "switched off"). */
	unavailable?: "switched off" | "needs sign-in";
	/** Offered by the administrator as always on. Still an opt-in for an agent. */
	locked?: boolean;
}

/** The connectors a user could switch on for a session on `deviceId`: the chat's, then the machine's own. */
export async function connectorOptions(
	userId: ObjectId,
	deviceId: string
): Promise<AgentConnectorOption[]> {
	const { connectors, blocked } = await resolveConnectors(userId);
	const policies = await loadPolicies().catch(() => new Map());
	const options: AgentConnectorOption[] = connectors
		.filter((c) => c.kind !== "local")
		.map((c) => ({
			key: c.key,
			name: c.name,
			kind: c.kind as "base" | "connector",
			summary: c.summary,
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
	if (localConnectorsEnabled()) {
		const device = await ownedDevice(userId, deviceId);
		if (device && device.status === "paired" && servesLocalConnectors(device)) {
			const { servers } = await serversOf(device);
			for (const s of servers) {
				options.push({
					key: localConnectorId(deviceId, s.name),
					name: s.name,
					kind: "local",
					summary: s.description ?? "",
				});
			}
		}
	}
	return options.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSessionConnectorKeys(
	userId: ObjectId,
	deviceId: string,
	sessionId: string
): Promise<string[]> {
	const row = await collections.codeSessionConnectors.findOne({ userId, deviceId, sessionId });
	return row?.keys ?? [];
}

export class SessionConnectorsError extends Error {}

/** Replace a session's opt-in. Every key must be one the user can switch on now; empty clears it. */
export async function setSessionConnectorKeys(
	userId: ObjectId,
	deviceId: string,
	sessionId: string,
	keys: string[]
): Promise<string[]> {
	const unique = [...new Set(keys)];
	if (unique.length > MAX_SESSION_CONNECTORS) {
		throw new SessionConnectorsError(`At most ${MAX_SESSION_CONNECTORS} connectors per session.`);
	}
	if (unique.length === 0) {
		await collections.codeSessionConnectors.deleteOne({ userId, deviceId, sessionId });
		return [];
	}
	const device = await ownedDevice(userId, deviceId);
	if (!device || device.status !== "paired") {
		throw new SessionConnectorsError("That machine is not one of yours.");
	}
	const allowed = new Set(
		(await connectorOptions(userId, deviceId)).filter((o) => !o.unavailable).map((o) => o.key)
	);
	const unknown = unique.filter((k) => !allowed.has(k));
	if (unknown.length > 0) {
		throw new SessionConnectorsError("One of those connectors is not available to you.");
	}
	const now = new Date();
	await collections.codeSessionConnectors.updateOne(
		{ userId, deviceId, sessionId },
		{ $set: { keys: unique, updatedAt: now }, $setOnInsert: { createdAt: now } },
		{ upsert: true }
	);
	return unique;
}

export interface SessionConnectorsNow {
	/** Opted in and usable now, resolved by the chat's own resolver. */
	cerea: TurnConnector[];
	/** Server names on the session's own machine, opted in. */
	local: string[];
}

/** What a session may use right now: its opt-in, re-filtered by the resolver at every list and call. */
export async function connectorsNow(
	userId: ObjectId,
	deviceId: string,
	sessionId: string
): Promise<SessionConnectorsNow> {
	const keys = await getSessionConnectorKeys(userId, deviceId, sessionId);
	if (keys.length === 0) return { cerea: [], local: [] };
	const wanted = new Set(keys);
	const { connectors } = await resolveConnectors(userId);
	const cerea = connectors.filter((c) => c.kind !== "local" && wanted.has(c.key));
	const local: string[] = [];
	if (localConnectorsEnabled()) {
		for (const k of keys) {
			const ref = parseLocalConnectorId(k);
			// Only this session's own machine: a key naming another machine is never served here.
			if (ref && ref.deviceId === deviceId) local.push(ref.server);
		}
	}
	return { cerea, local };
}
