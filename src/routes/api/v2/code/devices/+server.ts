/**
 * Paired devices: what this person has paired, and revoking one.
 *
 * Listing never touches the daemon — with no daemon configured this answers
 * an empty list, not an error, so the panel reads cleanly on a deployment
 * that enabled the flag before deploying the overlay. Pairing itself lives
 * in `enroll/+server.ts`; revoking here deletes the row, which is all Cerea
 * holds (live sessions stay on the daemon, unreachable without the pairing).
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { listDevices, ownerFilter, requireCodeAgents } from "$lib/server/codeDevices";

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
	// rather than a refusal, so ids stay unguessable either way.
	const result = await collections.codeDevices.deleteOne({
		_id: objectId,
		...ownerFilter(locals),
	});
	if (result.deletedCount === 0) error(404, "No such paired device.");
	return json({ revoked: true });
};
