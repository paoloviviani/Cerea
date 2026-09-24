/**
 * The `/code` surface's half of the owner-keyed attachment store
 * (`files/attachmentStore.ts`): what its owner keys look like, and who may
 * use one.
 *
 * A key is `code:<deviceId>:<sessionId>` — the device row it belongs to, and
 * the agent session on that device. It says nothing about the agent
 * transport: `sessionId` is whatever id the surface's backend gives a
 * session, and the store never interprets it.
 *
 * Authorization is the device row's, as for every `/code` route: a key is
 * usable only by the owner of a paired `codeDevices` row with that id, and a
 * key naming anybody else's device (or none) is the same 404 as a
 * nonexistent one. Sessions are not checked further, for the reason the
 * forwarder gives — every session on a device belongs to its owner.
 */

import { error } from "@sveltejs/kit";

import { getPairedDevice } from "$lib/server/codeDevices";
import { deleteAttachmentsByPrefix } from "$lib/server/files/attachmentStore";

const DEVICE_ID = /^[0-9a-f]{24}$/;
const SESSION_ID = /^[A-Za-z0-9_.:~-]{1,200}$/;

export function codeAttachmentKey(deviceId: string, sessionId: string): string {
	if (!DEVICE_ID.test(deviceId) || !SESSION_ID.test(sessionId)) {
		throw new Error("Not a valid device/session pair for an attachment key");
	}
	return `code:${deviceId}:${sessionId}`;
}

/** `code:<deviceId>:<sessionId>` → its parts, or null when it is not one. */
export function parseCodeAttachmentKey(
	key: string
): { deviceId: string; sessionId: string } | null {
	const match = /^code:([^:]+):(.+)$/.exec(key);
	if (!match || !DEVICE_ID.test(match[1]) || !SESSION_ID.test(match[2])) return null;
	return { deviceId: match[1], sessionId: match[2] };
}

/**
 * The caller's right to `key`, or a 404/400. Resolves to the key's parts so
 * the route never re-parses it.
 */
export async function authorizeCodeAttachmentKey(locals: App.Locals, key: string) {
	const parts = parseCodeAttachmentKey(key);
	if (!parts) error(400, "Not a valid attachment key.");
	await getPairedDevice(locals, parts.deviceId);
	return parts;
}

/**
 * Everything any session on one device stored — called when the device is
 * revoked, since the key's owner is gone and nothing could read these again.
 */
export function deleteCodeDeviceAttachments(deviceId: string): Promise<number> {
	if (!DEVICE_ID.test(deviceId)) throw new Error("Not a valid device id");
	return deleteAttachmentsByPrefix(`code:${deviceId}:`);
}
