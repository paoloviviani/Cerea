import { randomInt } from "crypto";
import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
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

/**
 * The pairing offer's relay identity: what `paseo daemon pair` encodes into
 * its link (both pairing entry points read it — the panel's paste and the
 * machine endpoint's POST — so the schema lives here, beside the row it
 * feeds, rather than in either route).
 */
export const offerSchema = z.object({
	// The daemon emits v as a JSON number (verified live against a real
	// 0.8.0 pairing link: {"v":2,...}), not a string. The panel never acts
	// on the offer version — the probe speaks protocol v2 unconditionally —
	// so both scalar shapes are accepted and the value is ignored.
	v: z.union([z.string(), z.number()]).optional(),
	serverId: z.string().trim().min(1).max(256),
	daemonPublicKeyB64: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9+/=]+$/, "not base64"),
});

/**
 * Accepts the pairing offer in both shapes a caller can hold: the raw offer
 * JSON, or the full link `paseo daemon pair` prints (the offer rides in the
 * URL's `#offer=` fragment, base64url-encoded — the fragment never reaches a
 * server, so it arrives here only because the caller carried it).
 */
export function parseOffer(raw: string): z.infer<typeof offerSchema> {
	const text = raw.trim();
	let json: unknown;
	if (text.startsWith("{")) {
		try {
			json = JSON.parse(text);
		} catch {
			error(400, "That pairing offer is not valid JSON.");
		}
	} else {
		const fragmentIndex = text.indexOf("#offer=");
		if (fragmentIndex === -1) {
			error(400, "Paste the pairing link `paseo daemon pair` prints on the machine.");
		}
		const encoded = text
			.slice(fragmentIndex + "#offer=".length)
			.split(/[?&]/)[0]
			.trim();
		try {
			json = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		} catch {
			error(400, "The pairing link's offer could not be read.");
		}
	}
	const parsed = offerSchema.safeParse(json);
	if (!parsed.success) {
		error(400, "That pairing offer is missing the daemon's relay identity.");
	}
	return parsed.data;
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

/**
 * One of the caller's own paired devices, for routing daemon traffic. A
 * device id that is not the caller's is a 404 — ids stay unguessable, and a
 * mismatched owner must be indistinguishable from a nonexistent device.
 */
export async function getPairedDevice(locals: App.Locals, deviceId: string) {
	let objectId: ObjectId;
	try {
		objectId = new ObjectId(deviceId);
	} catch {
		error(400, "Not a valid device id.");
	}
	const device = await collections.codeDevices.findOne({
		_id: objectId,
		...ownerFilter(locals),
	});
	if (!device) error(404, "No such paired device.");
	if (device.status !== "paired") error(409, "That device is not paired yet.");
	return device;
}
