/**
 * Paired devices: what this person has paired, and revoking one.
 *
 * Listing never touches the daemon — with no daemon configured this answers
 * an empty list, not an error, so the panel reads cleanly on a deployment
 * that enabled the flag before deploying the overlay. Pairing itself lives
 * in `enroll/+server.ts`; revoking here deletes the row and the attachments
 * its sessions stored (`codeAttachments.ts`), which is all Cerea holds (live
 * sessions stay on the daemon, unreachable without the pairing).
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { dropLink } from "$lib/server/codeDaemon";
import { listDevices, ownerFilter, requireCodeAgents } from "$lib/server/codeDevices";
import { deleteCodeDeviceAttachments } from "$lib/server/codeAttachments";
import { logger } from "$lib/server/logger";

export const GET: RequestHandler = async ({ locals }) => {
	requireCodeAgents(locals);
	return superjsonResponse({ devices: await listDevices(locals) });
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
	// rather than a refusal, so ids stay unguessable either way. The relay
	// link dies with the row — without the pairing, the daemon is
	// unreachable from here, which is all the revocation needs to do.
	const result = await collections.codeDevices.deleteOne({
		_id: objectId,
		...ownerFilter(locals),
	});
	if (result.deletedCount === 0) error(404, "No such paired device.");
	dropLink(id.data);
	// What the device's sessions were sent goes with it: its owner key names
	// a row that no longer exists, so nothing could ever authorize reading it
	// again. A failure here is logged, not surfaced — the revocation itself
	// has happened, and a retry would 404 on the missing row.
	await deleteCodeDeviceAttachments(objectId.toHexString()).catch((err) =>
		logger.error({ err, deviceId: id.data }, "failed to delete a revoked device's attachments")
	);
	return json({ revoked: true });
};
