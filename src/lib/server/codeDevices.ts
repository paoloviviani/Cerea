import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { codeAgentsEnabled } from "$lib/server/codeEnabled";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { isMachineOnline } from "$lib/server/code/machines";
import { machineIssuer } from "$lib/server/code/machineAuth";
import type { CodeDevice } from "$lib/types/CodeAgent";

/**
 * `enrolledIssuer`/`revokedAt`/`revokedReason` (ADR 0093 §4.7, §12) land on
 * `CodeDevice` once `auth/c-gateway-identity` merges; this branch starts from
 * `origin/main`, which doesn't have them yet. Read defensively through this
 * intersection rather than widening `CodeDevice` itself here, so the two
 * branches' changes to that type merge cleanly instead of colliding.
 */
type DeviceIdentityFields = { enrolledIssuer?: string; revokedAt?: Date };

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
	machine?: CodeDevice["machine"];
	policy: CodeDevice["policy"];
	credentialState: CodeDevice["credentialState"];
	online: boolean;
	createdAt: Date;
	lastSeenAt?: Date;
	pairedAt?: Date;
	terminalAckAt?: Date;
	/**
	 * Set when this device needs a fresh `galopin enroll` (ADR 0093 §12):
	 * `"issuer_changed"` when its `enrolledIssuer` no longer matches this
	 * deployment's configured issuer (still `paired`, not yet revoked —
	 * a heads-up before its next token renewal fails), `"revoked"` when the
	 * gateway already refused it (`revokedAt` set). A manual reject/revoke by
	 * the owner carries neither and stays excluded from this list, as before.
	 */
	reenroll?: "issuer_changed" | "revoked";
}

export function deviceView(device: CodeDevice, online: boolean): CodeDeviceView {
	const identity = device as CodeDevice & DeviceIdentityFields;
	const reenroll: CodeDeviceView["reenroll"] = identity.revokedAt
		? "revoked"
		: identity.enrolledIssuer && identity.enrolledIssuer !== configuredMachineIssuer()
			? "issuer_changed"
			: undefined;
	return {
		id: device._id.toString(),
		name: device.name,
		status: device.status,
		backends: device.backends,
		...(device.machine ? { machine: device.machine } : {}),
		policy: device.policy,
		credentialState: device.credentialState,
		online,
		createdAt: device.createdAt,
		...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
		...(device.pairedAt ? { pairedAt: device.pairedAt } : {}),
		...(device.terminalAckAt ? { terminalAckAt: device.terminalAckAt } : {}),
		...(reenroll ? { reenroll } : {}),
	};
}

/** `machineIssuer()` throws when no issuer is configured at all (neither
 * `CODE_MACHINE_ISSUER` nor `OPENID_PROVIDER_URL`) — a deployment state the
 * device list must still render in, just with no issuer drift to report. */
function configuredMachineIssuer(): string | null {
	try {
		return machineIssuer();
	} catch {
		return null;
	}
}

export async function listDevices(locals: App.Locals): Promise<CodeDeviceView[]> {
	if (!locals.user) error(401, "Login required");
	// A plain manual reject/revoke (no `revokedAt`) is a tombstone kept only
	// so `onHello` can refuse the same `machineId` reconnecting (queried
	// there directly, not through this list) — it must never resurface here.
	// A *gateway*-revoked row (`revokedAt` set, §4.7/§12) is different: the
	// person needs to see it, so they know to re-enroll.
	const devices = await collections.codeDevices
		.find({
			userId: locals.user._id,
			$or: [{ status: { $ne: "revoked" } }, { revokedAt: { $exists: true } }],
		})
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
export async function getOwnedDevice(
	locals: App.Locals,
	deviceId: string | null | undefined
): Promise<CodeDevice> {
	if (!locals.user) error(401, "Login required");
	if (!deviceId) error(400, "A paired device is required: pass ?device=.");
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
export async function getPairedDevice(
	locals: App.Locals,
	deviceId: string | null | undefined
): Promise<CodeDevice> {
	const device = await getOwnedDevice(locals, deviceId);
	if (device.status !== "paired") error(409, "That device is not paired yet.");
	return device;
}
