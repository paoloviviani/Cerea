/**
 * Local connectors (ADR 0102): the MCP servers that run on a person's own machines, offered to
 * that person and nobody else.
 *
 * The machine owns the servers (`mcp.json`, PROTOCOL.md §10); Cerea only lists what it offers
 * (`mcp.list`), opens channels to it (`localTransport.ts`) and starts a sign-in on it. What this
 * module adds is the person's view of that:
 *
 * - **Ownership.** Every read goes through the person's own device rows (`userId`), so another
 *   person's connector, a pending machine's, a revoked one's is never listed and never
 *   resolvable. An id naming somebody else's device resolves to nothing, exactly like an id
 *   naming somebody else's configured connector.
 * - **Offline.** A machine that is not connected still lists its servers (the last answer is
 *   kept on the device row), as unavailable. A turn leaves its tools out and says so, instead
 *   of failing or waiting: an offline check is the registry's, instant.
 * - **A listing never blocks.** `mcp.list` on an online machine is bounded to a few seconds and
 *   cached briefly; a machine that does not answer reads as its last known state.
 */

import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { isMachineOnline, MachineLink } from "$lib/server/code/machines";
import { localConnectorsEnabled } from "$lib/server/codeEnabled";
import { loadSwitches } from "./deploymentModes";
import { machineMode, type McpServer } from "$lib/types/machineProtocol";
import type { CodeDevice } from "$lib/types/CodeAgent";
import type { McpConnectorView, McpLocalView } from "$lib/types/McpConnector";
import {
	localConnectorId,
	localServerUrl,
	parseLocalConnectorId,
	type LocalServerRef,
} from "./localUrl";

/** The longest a listing waits on a machine; past it the last known list is used. */
const LIST_TIMEOUT_MS = 4_000;
/** A fresh list is reused this long, so a turn's selection check costs no round trip. */
const LIST_TTL_MS = 10_000;

type StoredServer = NonNullable<CodeDevice["mcpServers"]>[number];

const listCache = new Map<string, { at: number; servers: StoredServer[] }>();

/** Forget cached lists (a machine just signed in, or a test wants a fresh read). */
export function resetLocalListCache(deviceId?: string): void {
	if (deviceId) listCache.delete(deviceId);
	else listCache.clear();
}

/**
 * What identifies a server's entry in the last list heard from its machine, apart from its
 * state (which moves with sign-ins and restarts); undefined when no list has been heard.
 */
export function localServerFingerprint(deviceId: string, server: string): string | undefined {
	const entry = listCache.get(deviceId)?.servers.find((s) => s.name === server);
	if (!entry) return undefined;
	return JSON.stringify([
		entry.name,
		entry.transport,
		entry.description ?? "",
		entry.allowedTools ?? null,
	]);
}

/** Whether a device can serve local connectors: a connectors machine, or an agent machine that
 * has an `mcp.json` (`capabilities.mcp`). */
export function servesLocalConnectors(device: Pick<CodeDevice, "machine">): boolean {
	return machineMode(device.machine) === "connectors" || device.machine?.capabilities?.mcp === true;
}

function toStored(server: McpServer): StoredServer {
	return {
		name: server.name,
		transport: server.transport,
		...(server.description ? { description: server.description } : {}),
		state: server.state,
		...(server.detail ? { detail: server.detail } : {}),
		...(server.allowedTools ? { allowedTools: server.allowedTools } : {}),
	};
}

/**
 * One device's servers. Online: asked of the machine (bounded, cached) and remembered on the
 * row; anything else, or a machine that did not answer in time: what the row last held.
 */
export async function serversOf(
	device: CodeDevice,
	options: { fresh?: boolean } = {}
): Promise<{ servers: StoredServer[]; live: boolean }> {
	const deviceId = device._id.toString();
	const stored = device.mcpServers ?? [];
	if (!isMachineOnline(deviceId) || !servesLocalConnectors(device)) {
		return { servers: stored, live: false };
	}
	const cached = listCache.get(deviceId);
	if (cached && !options.fresh && Date.now() - cached.at < LIST_TTL_MS) {
		return { servers: cached.servers, live: true };
	}
	try {
		const listed = await Promise.race([
			new MachineLink(deviceId).mcpList(),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error("the machine did not answer mcp.list")),
					LIST_TIMEOUT_MS
				).unref?.()
			),
		]);
		const servers = listed.map(toStored);
		listCache.set(deviceId, { at: Date.now(), servers });
		void collections.codeDevices
			.updateOne({ _id: device._id }, { $set: { mcpServers: servers, mcpServersAt: new Date() } })
			.catch((err) => logger.warn({ err, deviceId }, "mcp_local_list_not_stored"));
		return { servers, live: true };
	} catch (err) {
		logger.info({ err: String(err), deviceId }, "mcp_local_list_failed");
		return { servers: cached?.servers ?? stored, live: false };
	}
}

/** "<server> · on <machine>": the one name a local connector goes by, in the panel, the
 * composer's list and the turn's server names. */
export function localDisplayName(server: string, machineName: string): string {
	return `${server} · on ${machineName}`;
}

/** The paired devices of a person that can serve connectors, newest first. */
export async function localDevicesOf(userId: ObjectId): Promise<CodeDevice[]> {
	const devices = await collections.codeDevices
		.find({ userId, status: "paired" })
		.sort({ updatedAt: -1 })
		.toArray();
	return devices.filter(servesLocalConnectors);
}

function viewOf(
	device: CodeDevice,
	server: StoredServer,
	online: boolean,
	enabled: boolean
): McpConnectorView {
	const deviceId = device._id.toString();
	const state: McpLocalView["state"] = online ? server.state : "offline";
	const local: McpLocalView = {
		deviceId,
		machineName: device.name,
		server: server.name,
		transport: server.transport,
		...(server.description ? { description: server.description } : {}),
		state,
		...(state === "offline"
			? { detail: `${device.name} is not connected. Start galopin there to use it.` }
			: server.detail
				? { detail: server.detail }
				: {}),
		...(server.allowedTools ? { allowedTools: server.allowedTools } : {}),
	};
	return {
		id: localConnectorId(deviceId, server.name),
		key: localConnectorId(deviceId, server.name),
		// Off until the person turns it on: a server on their machine is theirs to opt in to.
		enabled,
		name: localDisplayName(server.name, device.name),
		// Nothing to show: the address is internal and the machine is named beside it.
		url: "",
		// A sign-in is offered for a server that needs one, the same way a remote OAuth
		// connector's is.
		auth: server.state === "needs-login" ? "oauth" : "none",
		scope: "user",
		manageable: false,
		connected: state === "ready",
		canAuthorize: server.transport === "http" && state === "needs-login",
		...(server.allowedTools ? { tools: server.allowedTools.map((name) => ({ name })) } : {}),
		updatedAt: (device.mcpServersAt ?? device.updatedAt).toISOString(),
		local,
	};
}

/**
 * Every local connector this person has, for the MCP panel and the composer. Empty when the
 * switch is off. An id from this list is the only thing a turn may name (`resolveLocalSelection`).
 */
export async function localConnectorViews(userId: ObjectId): Promise<McpConnectorView[]> {
	if (!localConnectorsEnabled()) return [];
	const devices = await localDevicesOf(userId);
	const lists = await Promise.all(devices.map((device) => serversOf(device)));
	const switches = await loadSwitches(userId);
	return devices.flatMap((device, index) => {
		const online = isMachineOnline(device._id.toString());
		return lists[index].servers.map((server) =>
			viewOf(
				device,
				server,
				online,
				switches.on.has(localConnectorId(device._id.toString(), server.name))
			)
		);
	});
}

export interface ResolvedLocalServer {
	name: string;
	url: string;
}

/**
 * The local connectors this person picked, as servers a turn can call, plus the ones left out
 * and why. Only ids that name a paired device of this person resolve; an offline machine, a
 * server that is not `ready` (disabled, invalid, needs a sign-in) or one the machine no longer
 * lists is left out with a reason the model can pass on. Never throws and never waits on a
 * machine beyond the listing bound: a missing machine is a missing connector, not a failed turn.
 */
export async function resolveLocalSelection(options: {
	connectorIds: string[];
	userId: ObjectId;
}): Promise<{
	servers: ResolvedLocalServer[];
	unavailable: Array<{ name: string; reason: string }>;
}> {
	const { connectorIds, userId } = options;
	const servers: ResolvedLocalServer[] = [];
	const unavailable: Array<{ name: string; reason: string }> = [];
	if (!localConnectorsEnabled()) return { servers, unavailable };

	const wanted = connectorIds
		.map(parseLocalConnectorId)
		.filter((ref): ref is LocalServerRef => ref !== null);
	if (wanted.length === 0) return { servers, unavailable };

	const deviceIds = [...new Set(wanted.map((ref) => ref.deviceId))];
	const devices = await collections.codeDevices
		.find({ _id: { $in: deviceIds.map((id) => new ObjectId(id)) }, userId, status: "paired" })
		.toArray();
	const byId = new Map(devices.map((device) => [device._id.toString(), device]));
	const lists = new Map<string, Awaited<ReturnType<typeof serversOf>>>();
	await Promise.all(
		devices.map(async (device) => {
			lists.set(device._id.toString(), await serversOf(device));
		})
	);

	for (const { deviceId, server } of wanted) {
		const device = byId.get(deviceId);
		// Not this person's, or not paired any more: nothing to say about it.
		if (!device) continue;
		const name = localDisplayName(server, device.name);
		if (!isMachineOnline(deviceId)) {
			unavailable.push({ name, reason: `${device.name} is offline` });
			continue;
		}
		const entry = lists.get(deviceId)?.servers.find((s) => s.name === server);
		if (!entry) {
			unavailable.push({ name, reason: `${device.name} no longer lists it` });
			continue;
		}
		if (entry.state !== "ready") {
			unavailable.push({ name, reason: reasonFor(entry) });
			continue;
		}
		servers.push({ name, url: localServerUrl(userId.toString(), deviceId, server) });
	}
	return { servers, unavailable };
}

function reasonFor(server: StoredServer): string {
	switch (server.state) {
		case "needs-login":
			return "it needs a sign-in (open the MCP panel and sign in)";
		case "disabled":
			return "it is disabled on that machine";
		default:
			return `it is not usable on that machine${server.detail ? `: ${server.detail}` : ""}`;
	}
}
