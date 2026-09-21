import { randomInt } from "crypto";
import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { codeAgentsEnabled } from "$lib/server/codeEnabled";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import type { CodeDevice } from "$lib/types/CodeAgent";

/**
 * The pairing broker's shared half: every `/code` endpoint serves one person
 * only, and only while the deployment flag is on.
 *
 * The relay is identity-blind — it cannot tell whose daemon is whose — so
 * Cerea brokers pairing itself: a device row is owned by exactly one of
 * `userId` / `sessionId` (the same owner split as `authCondition`), and every
 * read and write is scoped to the caller's. The daemon credential never
 * leaves the server; the pairing code below is the only secret the browser
 * ever sees, and it is single-use.
 */

export function requireCodeAgents(locals: App.Locals): void {
	requireAuth(locals);
	if (!codeAgentsEnabled()) {
		error(404, "Coding agents are not enabled in this deployment.");
	}
}

/** The caller's scope: what their device rows are keyed on. */
export function ownerFilter(locals: App.Locals): { userId: ObjectId } | { sessionId: string } {
	if (locals.user) return { userId: locals.user._id };
	if (locals.sessionId) return { sessionId: locals.sessionId };
	error(401, "Login required");
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A short, unambiguous, single-use pairing code (`paseo pair <code>`). */
export function newPairingCode(): string {
	let code = "";
	for (let i = 0; i < 6; i += 1) {
		code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
	}
	return code;
}

export interface CodeDeviceView {
	id: string;
	name: string;
	status: CodeDevice["status"];
	/** Present only while pending: what the person types into their daemon. */
	pairingCode?: string;
	daemonId?: string;
	createdAt: Date;
	pairedAt?: Date;
}

export function deviceView(device: CodeDevice): CodeDeviceView {
	return {
		id: device._id.toString(),
		name: device.name,
		status: device.status,
		...(device.status === "pending" && device.pairingCode
			? { pairingCode: device.pairingCode }
			: {}),
		...(device.daemonId ? { daemonId: device.daemonId } : {}),
		createdAt: device.createdAt,
		...(device.pairedAt ? { pairedAt: device.pairedAt } : {}),
	};
}

export async function listDevices(locals: App.Locals): Promise<CodeDeviceView[]> {
	const devices = await collections.codeDevices
		.find({ ...ownerFilter(locals) })
		.sort({ updatedAt: -1 })
		.toArray();
	return devices.map(deviceView);
}
