/**
 * Paired machines: what this person has paired, confirming a pending one,
 * and revoking (or rejecting) one.
 *
 * Listing never touches the machine — with none connected this answers an
 * empty (or all-offline) list, not an error. Confirm is the fresh human
 * approval review C2 calls for: a machine connecting with a valid bearer
 * only reaches `pending` (`machines.ts`'s `onHello`); nothing is forwarded
 * to it until this endpoint flips the row to `paired` and pushes the
 * `status` frame down its live socket. Revoke — the same action serves
 * "reject a pending machine" — is a tombstone, not a delete (spec §4): the
 * row's `status` becomes `revoked` so a re-connect with the same
 * `machineId` is refused at `onHello`, and the live socket (if any) is
 * closed 4403.
 * The revoked machine's stored attachments (`codeAttachments.ts`) go with it.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { dropMachineConnection, notifyDevicePaired } from "$lib/server/code/machines";
import { getOwnedDevice, listDevices, requireCodeAgents } from "$lib/server/codeDevices";
import { deleteCodeDeviceAttachments } from "$lib/server/codeAttachments";
import { disableSchedulesForDevice } from "$lib/server/code/scheduleAgentExecutor";
import { logger } from "$lib/server/logger";

export const GET: RequestHandler = async ({ locals }) => {
	requireCodeAgents(locals);
	return superjsonResponse({ devices: await listDevices(locals) });
};

function requireJsonBody(request: Request): void {
	const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
	if (contentType !== "application/json") {
		error(400, "Expected Content-Type: application/json.");
	}
}

const patchSchema = z.object({ action: z.literal("confirm") });

/** Confirm a pending machine: the browser's Confirm click, the second
 * factor a phished device-code approval alone never reaches (C2). */
export const PATCH: RequestHandler = async ({ locals, request, url }) => {
	requireCodeAgents(locals);
	requireJsonBody(request);
	const id = z.string().min(1).safeParse(url.searchParams.get("id"));
	if (!id.success) error(400, "A device id is required.");
	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Expected { action: 'confirm' }.");

	const device = await getOwnedDevice(locals, id.data);
	if (device.status !== "pending") error(409, "That device is not awaiting confirmation.");

	const now = new Date();
	await collections.codeDevices.updateOne(
		{ _id: device._id },
		{ $set: { status: "paired", pairedAt: now, updatedAt: now } }
	);
	notifyDevicePaired(device._id.toString());
	return json({ confirmed: true });
};

export const DELETE: RequestHandler = async ({ locals, url }) => {
	requireCodeAgents(locals);
	const id = z.string().min(1).safeParse(url.searchParams.get("id"));
	if (!id.success) error(400, "A device id is required.");

	let objectId: ObjectId;
	try {
		objectId = new ObjectId(id.data);
	} catch {
		error(400, "Not a valid device id.");
	}

	// Scoped to the caller's rows: revoking somebody else's id is a 404
	// rather than a refusal, so ids stay unguessable either way. The row
	// survives as a tombstone (spec §4) — deleting it would let the same
	// machineId re-pair silently on its next connect.
	const result = await collections.codeDevices.updateOne(
		{ _id: objectId, userId: locals.user?._id },
		{ $set: { status: "revoked", updatedAt: new Date() } }
	);
	if (result.matchedCount === 0) error(404, "No such paired device.");
	dropMachineConnection(id.data, 4403, "revoked by owner");
	// What the device's sessions were sent goes with it: its owner key names
	// a row that no longer exists, so nothing could ever authorize reading it
	// again. A failure here is logged, not surfaced — the revocation itself
	// has happened, and a retry would 404 on the missing row.
	await deleteCodeDeviceAttachments(objectId.toHexString()).catch((err) =>
		logger.error({ err, deviceId: id.data }, "failed to delete a revoked device's attachments")
	);
	// A schedule pointed at it would only fail at its next run: switch it off now.
	await disableSchedulesForDevice(locals.user?._id, id.data).catch((err) =>
		logger.error({ err, deviceId: id.data }, "failed to switch off a revoked device's schedules")
	);
	return json({ revoked: true });
};
