/**
 * Approving and revoking a connectors machine (ADR 0102).
 *
 * The same human approval `/code` asks of a coding-agent machine (review C2): a machine that
 * connects with a valid bearer only reaches `pending`, and nothing it offers reaches a chat
 * until the person confirms it here. The same sign-in freshness applies, since approving a
 * machine lets it put tools in front of the model. A machine that is not the caller's, or not a
 * connectors machine, is a 404.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { requireLocalConnectors } from "$lib/server/localConnectors";
import { dropMachineConnection, notifyDevicePaired } from "$lib/server/code/machines";
import { sessionAuthFresh } from "$lib/server/code/stepUp";
import { resetLocalListCache } from "$lib/server/mcp/local";
import { machineMode } from "$lib/types/machineProtocol";

async function ownedConnectorsMachine(userId: ObjectId, id: string) {
	if (!ObjectId.isValid(id)) error(404, "No such machine.");
	const device = await collections.codeDevices.findOne({ _id: new ObjectId(id), userId });
	if (!device || device.status === "revoked" || machineMode(device.machine) !== "connectors") {
		error(404, "No such machine.");
	}
	return device;
}

const patch = z.object({ action: z.literal("confirm") });

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const { userId } = requireLocalConnectors(locals);
	const parsed = patch.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Expected { action: 'confirm' }.");
	const device = await ownedConnectorsMachine(userId, params.id ?? "");
	if (device.status !== "pending") error(409, "That machine is not awaiting approval.");
	if (!locals.sessionId || !(await sessionAuthFresh(locals.sessionId))) {
		return json(
			{ code: "reauth_required", message: "Your sign-in is older than 7 days. Sign in again." },
			{ status: 401, headers: { "Cache-Control": "no-store" } }
		);
	}

	const now = new Date();
	await collections.codeDevices.updateOne(
		{ _id: device._id },
		{ $set: { status: "paired", pairedAt: now, updatedAt: now } }
	);
	notifyDevicePaired(device._id.toString());
	return json({ confirmed: true });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const { userId } = requireLocalConnectors(locals);
	const device = await ownedConnectorsMachine(userId, params.id ?? "");
	// A tombstone, not a delete (PROTOCOL.md §4): the same machine id cannot re-pair by itself.
	await collections.codeDevices.updateOne(
		{ _id: device._id },
		{
			$set: { status: "revoked", updatedAt: new Date() },
			$unset: { mcpServers: "", mcpServersAt: "" },
		}
	);
	resetLocalListCache(device._id.toString());
	dropMachineConnection(device._id.toString(), 4403, "revoked by owner");
	return json({ revoked: true });
};
