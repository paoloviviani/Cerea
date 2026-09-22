/**
 * The pairing flow: start one, and complete one.
 *
 * `start` names the machine (`"my laptop"`) and answers a single-use code.
 * `claim` is the real handshake: on their machine the person runs
 * `paseo daemon pair`, which prints a pairing link; they paste that link
 * here. The link carries the daemon's relay identity — its `serverId` and
 * Curve25519 public key. Cerea verifies the code against the caller's own
 * pending row, then proves the offer is live by connecting to the daemon
 * through this deployment's relay and completing the encrypted handshake;
 * only then is the association recorded (`daemonId` = serverId, the relay's
 * route key, plus the public key the E2EE channel needs).
 *
 * The offer's own relay endpoint is deliberately ignored: Cerea dials the
 * relay the deployment configured (`CODE_RELAY_URL`), so a crafted offer
 * cannot point the server at a different rendezvous. Both directions are
 * scoped to the caller's own pending rows, and the code is cleared the
 * moment it is used.
 */

import { error, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { probePairingOffer } from "$lib/server/codeDaemon";
import {
	deviceView,
	newPairingCode,
	ownerFilter,
	requireCodeAgents,
} from "$lib/server/codeDevices";
import { logger } from "$lib/server/logger";

const startSchema = z.object({
	action: z.literal("start"),
	name: z.string().trim().min(1).max(64),
});

const offerSchema = z.object({
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

function parseOffer(raw: string): z.infer<typeof offerSchema> {
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

const claimSchema = z.object({
	action: z.literal("claim"),
	code: z.string().trim().min(1).max(16),
	/** The pairing link (or offer JSON) `paseo daemon pair` prints. */
	offer: z.string().trim().min(1).max(4096),
});

const bodySchema = z.union([startSchema, claimSchema]);

export const POST: RequestHandler = async ({ locals, request }) => {
	requireCodeAgents(locals);
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		error(400, "Expected { action: 'start', name } or { action: 'claim', code, offer }.");
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
			// An unclaimed pairing is a row nobody will ever read again;
			// fifteen minutes is long enough to walk to the machine and type
			// the code, short enough that abandoned rows do not linger. Only
			// pending rows carry this field, so only they can expire.
			expiresAt: new Date(now.getTime() + 15 * 60_000),
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

	const offer = parseOffer(body.offer);
	// The handshake is the proof: if the daemon on the other end of the relay
	// does not answer with the offer's own serverId, this offer describes a
	// machine we cannot actually reach, and the pairing must not record it.
	const probe = await probePairingOffer({
		serverId: offer.serverId,
		daemonPublicKey: offer.daemonPublicKeyB64,
	}).catch(
		/* the probe maps its own failures to user-facing errors */ (err) => {
			logger.warn({ err }, "pairing probe rejected");
			throw err;
		}
	);
	logger.info(
		{ deviceId: device._id.toString(), serverId: offer.serverId, version: probe.version },
		"pairing handshake completed through the relay"
	);

	const now = new Date();
	await collections.codeDevices.updateOne(
		{ _id: device._id },
		{
			$set: {
				status: "paired",
				updatedAt: now,
				pairedAt: now,
				daemonId: offer.serverId,
				daemonPublicKey: offer.daemonPublicKeyB64,
			},
			$unset: { pairingCode: "", expiresAt: "" },
		}
	);
	const paired = await collections.codeDevices.findOne({ _id: device._id });
	if (!paired) error(502, "The pairing could not be completed.");
	return superjsonResponse({ device: deviceView(paired) });
};
