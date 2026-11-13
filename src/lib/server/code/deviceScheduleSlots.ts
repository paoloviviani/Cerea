import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";

/**
 * The in-flight claims behind a device's active agent-schedule cap (`MAX_ACTIVE_AGENT_SCHEDULES`).
 * "Active" is a property of the rows (enabled, agent-made, this device) and moves with pause and
 * resume, so the rows stay the truth; this only counts the creates between "may I" and "the row
 * exists", on the device's own document, with an atomic increment. A create is allowed when
 * (claims already in flight) + (active rows) is under the cap, so two creates racing for the last
 * slot cannot both pass. A claim in flight next to its own just-inserted row is counted twice for
 * a moment, which only ever refuses early.
 */

/**
 * A claim count above zero is only a leak (a crash between claim and release) once it has sat
 * still this long. Lowering it sooner would hand slots to creates that are still in flight.
 */
export const DEVICE_HEAL_AFTER_MS = 60_000;

async function claim(deviceId: ObjectId): Promise<number | null> {
	const res = await collections.codeDevices.findOneAndUpdate(
		{ _id: deviceId },
		{ $inc: { "scheduleClaims.count": 1 }, $set: { "scheduleClaims.movedAt": new Date() } },
		{ returnDocument: "before", projection: { scheduleClaims: 1 } }
	);
	const before = res.value;
	if (!before) return null;
	return before.scheduleClaims?.count ?? 0;
}

/** Gives a claim back. Never goes below zero. */
export async function releaseDeviceScheduleClaim(deviceId: ObjectId): Promise<void> {
	await collections.codeDevices.updateOne(
		{ _id: deviceId, "scheduleClaims.count": { $gte: 1 } },
		{ $inc: { "scheduleClaims.count": -1 }, $set: { "scheduleClaims.movedAt": new Date() } }
	);
}

/**
 * Zeroes a claim count that has not moved for DEVICE_HEAL_AFTER_MS and still holds the value that
 * was read. Returns whether it fixed anything.
 */
export async function healDeviceScheduleClaims(deviceId: ObjectId): Promise<boolean> {
	const row = await collections.codeDevices.findOne(
		{ _id: deviceId },
		{ projection: { scheduleClaims: 1 } }
	);
	const claims = row?.scheduleClaims;
	if (!claims || claims.count <= 0) return false;
	const cutoff = new Date(Date.now() - DEVICE_HEAL_AFTER_MS);
	if (claims.movedAt > cutoff) return false;
	const { modifiedCount } = await collections.codeDevices.updateOne(
		{
			_id: deviceId,
			"scheduleClaims.count": claims.count,
			"scheduleClaims.movedAt": { $lte: cutoff },
		},
		{ $set: { "scheduleClaims.count": 0 } }
	);
	return modifiedCount === 1;
}

/**
 * Takes a claim if one more active schedule fits under `cap`; `activeRows` counts the rows.
 * True means the caller must `releaseDeviceScheduleClaim` once its row is inserted (or the insert
 * failed). False means the cap is reached and nothing is held.
 */
export async function claimDeviceScheduleSlot(
	deviceId: ObjectId,
	cap: number,
	activeRows: () => Promise<number>
): Promise<boolean> {
	// A leaked count is healed up front: a claim moves the clock, so healing after one never would.
	await healDeviceScheduleClaims(deviceId);
	const inFlight = await claim(deviceId);
	if (inFlight === null) return false;
	if (inFlight + (await activeRows()) < cap) return true;
	await releaseDeviceScheduleClaim(deviceId);
	return false;
}
