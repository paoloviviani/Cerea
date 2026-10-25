import { error } from "@sveltejs/kit";
import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { isMachineOnline } from "$lib/server/code/machines";
import { localConnectorsEnabled } from "$lib/server/codeEnabled";
import { localConnectorId } from "$lib/server/mcp/localUrl";
import { serversOf, servesLocalConnectors } from "$lib/server/mcp/local";
import { machineMode } from "$lib/types/machineProtocol";
import type { CodeDevice } from "$lib/types/CodeAgent";
import type { LocalMachineView, LocalServerView } from "$lib/types/LocalConnectors";

/**
 * The Local connectors endpoints' shared gate: a signed-in person, and the deployment switch
 * (`LOCAL_CONNECTORS_ENABLED`). A 404 when off, so the tab reads as absent rather than refused.
 */
export function requireLocalConnectors(locals: App.Locals): { userId: ObjectId } {
	requireAuth(locals);
	if (!locals.user) error(401, "Login required");
	if (!localConnectorsEnabled()) error(404, "Local connectors are not turned on here.");
	return { userId: locals.user._id };
}

/**
 * This person's machines for the Local connectors tab: every connectors-mode machine that is
 * not revoked (a pending one is listed so it can be approved), and each paired agent machine
 * that has an `mcp.json`, read-only. Only the caller's own rows, ever.
 */
export async function localMachineViews(userId: ObjectId): Promise<LocalMachineView[]> {
	const devices = await collections.codeDevices
		.find({ userId, status: { $ne: "revoked" } })
		.sort({ updatedAt: -1 })
		.toArray();
	const relevant = devices.filter(
		(device) =>
			machineMode(device.machine) === "connectors" ||
			(device.status === "paired" && servesLocalConnectors(device))
	);
	return Promise.all(relevant.map(machineView));
}

async function machineView(device: CodeDevice): Promise<LocalMachineView> {
	const id = device._id.toString();
	const online = isMachineOnline(id);
	// A machine that is not approved yet is asked nothing: it may not offer anything yet.
	const { servers } =
		device.status === "paired" ? await serversOf(device) : { servers: [] as never[] };
	const views: LocalServerView[] = servers.map((server) => ({
		id: localConnectorId(id, server.name),
		name: server.name,
		transport: server.transport,
		...(server.description ? { description: server.description } : {}),
		state: online ? server.state : "offline",
		...(server.detail ? { detail: server.detail } : {}),
		...(server.allowedTools ? { allowedTools: server.allowedTools } : {}),
	}));
	return {
		id,
		name: device.name,
		status: device.status === "paired" ? "paired" : "pending",
		mode: machineMode(device.machine),
		online,
		createdAt: device.createdAt.toISOString(),
		...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt.toISOString() } : {}),
		...(device.pairedAt ? { pairedAt: device.pairedAt.toISOString() } : {}),
		...(device.mcpServersAt ? { serversAt: device.mcpServersAt.toISOString() } : {}),
		servers: views,
	};
}
