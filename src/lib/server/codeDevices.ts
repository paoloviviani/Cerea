import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { codeAgentsEnabled } from "$lib/server/codeEnabled";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { isMachineOnline } from "$lib/server/code/machines";
import type { CodeDevice } from "$lib/types/CodeAgent";

/**
 * The pairing broker's shared half: every `/code` endpoint serves one signed-in
 * person only, and only while the deployment flag is on.
 *
 * A device row is owned by exactly `userId` — there is no anonymous-session
 * ownership anymore (C6): a machine link authenticates with a real OIDC
 * bearer mapped to a Cerea user before a row is even created, so there is
 * nothing here for a bare cookie session to own. Every read and write is
 * scoped to `locals.user._id`.
 */

export function requireCodeAgents(locals: App.Locals): void {
	requireAuth(locals);
	if (!locals.user) {
		error(401, "Login required");
	}
	if (!codeAgentsEnabled()) {
		error(404, "Coding agents are not enabled in this deployment.");
	}
}

export interface CodeDeviceView {
	id: string;
	name: string;
	status: CodeDevice["status"];
	backends: CodeDevice["backends"];
	policy: CodeDevice["policy"];
	credentialState: CodeDevice["credentialState"];
	online: boolean;
	createdAt: Date;
	lastSeenAt?: Date;
	pairedAt?: Date;
}

export function deviceView(device: CodeDevice, online: boolean): CodeDeviceView {
	return {
		id: device._id.toString(),
		name: device.name,
		status: device.status,
		backends: device.backends,
		policy: device.policy,
		credentialState: device.credentialState,
		online,
		createdAt: device.createdAt,
		...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
		...(device.pairedAt ? { pairedAt: device.pairedAt } : {}),
	};
}

export async function listDevices(locals: App.Locals): Promise<CodeDeviceView[]> {
	if (!locals.user) error(401, "Login required");
	const devices = await collections.codeDevices
		.find({ userId: locals.user._id })
		.sort({ updatedAt: -1 })
		.toArray();
	return devices.map((device) => deviceView(device, isMachineOnline(device._id.toString())));
}

/**
 * One of the caller's own device rows, regardless of status — used by the
 * confirm/reject actions, which only make sense on a row that isn't paired
 * yet. A device id that is not the caller's is a 404, not a 403: ids stay
 * unguessable, and a mismatched owner must be indistinguishable from a
 * nonexistent device.
 */
export async function getOwnedDevice(locals: App.Locals, deviceId: string): Promise<CodeDevice> {
	if (!locals.user) error(401, "Login required");
	let objectId: ObjectId;
	try {
		objectId = new ObjectId(deviceId);
	} catch {
		error(400, "Not a valid device id.");
	}
	const device = await collections.codeDevices.findOne({ _id: objectId, userId: locals.user._id });
	if (!device) error(404, "No such paired device.");
	return device;
}

/** One of the caller's own *paired* devices, for routing machine traffic. */
export async function getPairedDevice(locals: App.Locals, deviceId: string): Promise<CodeDevice> {
	const device = await getOwnedDevice(locals, deviceId);
	if (device.status !== "paired") error(409, "That device is not paired yet.");
	return device;
}
