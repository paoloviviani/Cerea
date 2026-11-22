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
import {
	MachineLink,
	dropMachineConnection,
	isMachineOnline,
	notifyDevicePaired,
} from "$lib/server/code/machines";
import { OpError } from "$lib/types/machineProtocol";
import { GALOPIN_LAST_CHANGED } from "$lib/utils/appVersion";
import { servedGalopinVersion } from "$lib/server/galopinDist";
import { UPGRADE_TIMEOUT_MS, galopinNeedsUpgrade, type UpgradeRun } from "$lib/galopinUpgrade";
import { getOwnedDevice, listDevices, requireCodeAgents } from "$lib/server/codeDevices";
import { deleteCodeDeviceAttachments } from "$lib/server/codeAttachments";
import { disableSchedulesForDevice } from "$lib/server/code/scheduleAgentExecutor";
import { logger } from "$lib/server/logger";
import type { CodeDevice } from "$lib/types/CodeAgent";

export const GET: RequestHandler = async ({ locals }) => {
	await requireCodeAgents(locals);
	return superjsonResponse({ devices: await listDevices(locals) });
};

function requireJsonBody(request: Request): void {
	const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
	if (contentType !== "application/json") {
		error(400, "Expected Content-Type: application/json.");
	}
}

const patchSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("confirm") }),
	// ADR 0107: the owner keeps this machine's asks away from the reviewer.
	z.object({ action: z.literal("never-review"), value: z.boolean() }),
	// C159: the Upgrade button. The owner asks galopin to upgrade itself in place.
	z.object({ action: z.literal("upgrade") }),
]);

/** Start an upgrade of the owner's computer. Refuses a computer that is offline, did not report
 * `agent.upgrade.inPlace: true`, is current already, or is mid-upgrade; records the start so
 * the panel can show it, and takes the record back when galopin refuses before detaching. */
async function startUpgrade(device: CodeDevice): Promise<Response> {
	const deviceId = device._id.toString();
	if (device.status !== "paired") error(409, "That computer is not confirmed yet.");
	if (!isMachineOnline(deviceId)) error(409, "That computer is offline.");
	if (!device.agentUpgrade?.inPlace) {
		error(409, "This computer cannot be upgraded from here. Use the upgrade command instead.");
	}
	if (!galopinNeedsUpgrade(device.agentVersion, GALOPIN_LAST_CHANGED)) {
		error(409, "This computer is already up to date.");
	}
	const now = new Date();
	const run: UpgradeRun = {
		startedAt: now,
		fromVersion: device.agentVersion ?? "",
		targetVersion: await servedGalopinVersion(),
		state: "running",
	};
	// One start at a time: the filter fails when a run is still going and not yet timed out.
	const claimed = await collections.codeDevices.updateOne(
		{
			_id: device._id,
			userId: device.userId,
			$or: [
				{ upgradeRun: { $exists: false } },
				{ "upgradeRun.state": { $ne: "running" } },
				{ "upgradeRun.startedAt": { $lte: new Date(now.getTime() - UPGRADE_TIMEOUT_MS) } },
			],
		},
		{ $set: { upgradeRun: run, updatedAt: now } }
	);
	if (claimed.matchedCount === 0) error(409, "An upgrade is already running on that computer.");
	try {
		await new MachineLink(deviceId).machineUpgrade();
	} catch (err) {
		// The link closing or timing out leaves it unknown whether galopin started: the run stays
		// "running" and the next hello (or the timeout) decides.
		if (err instanceof OpError && err.details?.linkLost === true) {
			return json({ started: true, upgrade: run, unconfirmed: true });
		}
		const restore = device.upgradeRun
			? { $set: { upgradeRun: device.upgradeRun } }
			: { $unset: { upgradeRun: "" as const } };
		await collections.codeDevices.updateOne({ _id: device._id }, restore);
		if (err instanceof OpError) {
			if (err.code === "forbidden" || err.code === "unsupported" || err.code === "invalid") {
				error(409, err.message);
			}
			if (err.code === "unavailable") error(503, err.message);
			error(502, err.message);
		}
		throw err;
	}
	return json({ started: true, upgrade: run });
}

/** Confirm a pending machine: the browser's Confirm click, the second
 * factor a phished device-code approval alone never reaches (C2). */
export const PATCH: RequestHandler = async ({ locals, request, url }) => {
	await requireCodeAgents(locals);
	requireJsonBody(request);
	const id = z.string().min(1).safeParse(url.searchParams.get("id"));
	if (!id.success) error(400, "A device id is required.");
	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		error(
			400,
			"Expected { action: 'confirm' }, { action: 'upgrade' } or { action: 'never-review', value: boolean }."
		);
	}

	const device = await getOwnedDevice(locals, id.data);
	if (parsed.data.action === "upgrade") return startUpgrade(device);
	if (parsed.data.action === "never-review") {
		await collections.codeDevices.updateOne(
			{ _id: device._id, userId: device.userId },
			{ $set: { neverReview: parsed.data.value, updatedAt: new Date() } }
		);
		return superjsonResponse({ neverReview: parsed.data.value });
	}
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
	await requireCodeAgents(locals);
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
	// A row the gateway revoked (`revokedAt`) is listed with its re-enroll
	// banner; removing it clears that mark, so it becomes the same hidden
	// tombstone an owner's own revoke leaves, still refusing its machineId.
	const result = await collections.codeDevices.updateOne(
		{ _id: objectId, userId: locals.user?._id },
		{
			$set: { status: "revoked", updatedAt: new Date() },
			$unset: { revokedAt: "", revokedReason: "", browserDefault: "", browserDefaultAt: "" },
		}
	);
	if (result.matchedCount === 0) error(404, "No such paired device.");
	dropMachineConnection(id.data, 4403, "revoked by owner");
	// What the device's sessions were sent goes with it: its owner key names
	// a row that no longer exists, so nothing could ever authorize reading it
	// again. A failure here is logged, not surfaced — the revocation itself
	// has happened, and a retry would 404 on the missing row.
	// Clean-up runs behind the response: the row is already tombstoned, and
	// the person's click must not wait on GridFS or the scheduler.
	void deleteCodeDeviceAttachments(objectId.toHexString()).catch((err) =>
		logger.error({ err, deviceId: id.data }, "failed to delete a revoked device's attachments")
	);
	// A schedule pointed at it would only fail at its next run: switch it off now.
	void disableSchedulesForDevice(locals.user?._id, id.data).catch((err) =>
		logger.error({ err, deviceId: id.data }, "failed to switch off a revoked device's schedules")
	);
	return json({ revoked: true });
};
