/**
 * The pairing flow: start one, and complete one.
 *
 * `start` names the machine (`"my laptop"`) and answers a single-use code.
 * The person types it into their daemon (`paseo pair <code>`); until a live
 * daemon calls back — wired in Phase 2 against the daemon's pairing hook —
 * `claim` completes the pairing from here, which is what the dialog's "I've
 * approved it" button calls. Both directions are scoped to the caller's own
 * pending rows, and the code is cleared the moment it is used.
 */

import { error, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import {
	deviceView,
	newPairingCode,
	ownerFilter,
	requireCodeAgents,
} from "$lib/server/codeDevices";

const startSchema = z.object({
	action: z.literal("start"),
	name: z.string().trim().min(1).max(64),
});

const claimSchema = z.object({
	action: z.literal("claim"),
	code: z.string().trim().min(1).max(16),
	/** Daemon-reported device id, when the daemon is the one claiming. */
	daemonId: z.string().trim().max(128).optional(),
});

const bodySchema = z.union([startSchema, claimSchema]);

export const POST: RequestHandler = async ({ locals, request }) => {
	requireCodeAgents(locals);
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		error(400, "Expected { action: 'start', name } or { action: 'claim', code }.");
	const body = parsed.data;
	const owner = ownerFilter(locals);

	if (body.action === "start") {
		const now = new Date();
		const code = newPairingCode();
		const created = await collections.codeDevices.insertOne({
			_id: new ObjectId(),
			...owner,
			name: body.name,
			status: "pending",
			pairingCode: code,
			createdAt: now,
			updatedAt: now,
		});
		const device = await collections.codeDevices.findOne({ _id: created.insertedId });
		if (!device) error(502, "The pairing could not be recorded.");
		return superjsonResponse({ device: deviceView(device) });
	}

	const device = await collections.codeDevices.findOne({
		...owner,
		status: "pending",
		pairingCode: body.code.trim().toUpperCase(),
	});
	if (!device) error(404, "No pending pairing uses that code.");
	const now = new Date();
	await collections.codeDevices.updateOne(
		{ _id: device._id },
		{
			$set: {
				status: "paired",
				updatedAt: now,
				pairedAt: now,
				...(body.daemonId ? { daemonId: body.daemonId } : {}),
			},
			$unset: { pairingCode: "" },
		}
	);
	const paired = await collections.codeDevices.findOne({ _id: device._id });
	if (!paired) error(502, "The pairing could not be completed.");
	return superjsonResponse({ device: deviceView(paired) });
};
