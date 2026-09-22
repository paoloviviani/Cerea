/**
 * The machine half of pairing: `enroll pair` on the agent machine calls this
 * with the enrollment's own bearer, so a setup script finishes the pairing
 * without a human pasting the offer into the panel.
 *
 * The caller is a program, not a browser: it holds no session cookie, so the
 * credential is the access token the enroll flow minted at the deployment's
 * identity provider — the same issuer the chat logs people in with, so the
 * identity maps through `sub` → `hfUserId` like the login callback does. The
 * token gate (and this route's exemption from the generic bearer handling in
 * the hook) is what makes a machine call possible at all.
 *
 * Everything after the identity check is the claim handshake without the
 * code: the offer is parsed, the daemon is probed through this deployment's
 * relay (`CODE_RELAY_URL` — the offer's own relay field is deliberately
 * ignored, exactly as in the paste flow), and only then is the row written,
 * as `paired` directly. Re-pairing the same machine is an update, not a
 * second row: the daemon keeps its `serverId` across re-runs, and one
 * machine means one row in the panel.
 *
 * The paste flow (`start`/`claim` in the sibling `+server.ts`) stays: it is
 * the fallback for a machine that cannot reach this origin, and this
 * endpoint is an additional path, not a replacement.
 */

import { error, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { UserinfoResponse } from "openid-client";
import { base } from "$app/paths";
import { collections } from "$lib/server/database";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { probePairingOffer } from "$lib/server/codeDaemon";
import { deviceView, parseOffer } from "$lib/server/codeDevices";
import { codeAgentsEnabled } from "$lib/server/codeEnabled";
import { getOIDCUserFromToken } from "$lib/server/auth";
import { logger } from "$lib/server/logger";

const machineSchema = z.object({
	name: z.string().trim().min(1).max(64),
	/** The pairing link (or offer JSON) `paseo daemon pair` printed. */
	offer: z.string().trim().min(1).max(4096),
});

export const POST: RequestHandler = async ({ request, url }) => {
	if (!codeAgentsEnabled()) {
		error(404, "Coding agents are not enabled in this deployment.");
	}

	// Bearer-only, deliberately: there is no cookie to fall back on, and a
	// bearer the endpoint itself validates is the one credential a headless
	// machine can hold. Absent is 401; unparseable is also 401 — both mean
	// "this is not an authenticated machine call".
	const authorization = request.headers.get("authorization");
	if (!authorization?.startsWith("Bearer ")) {
		error(401, "Send the enrollment's access token as `Authorization: Bearer <token>`.");
	}
	const token = authorization.slice("Bearer ".length).trim();

	// The userinfo round trip is the validation: an expired, revoked, or
	// forged bearer fails here, and the claims come from the issuer rather
	// than from anything the caller asserts about itself.
	let userData: UserinfoResponse;
	try {
		userData = await getOIDCUserFromToken(
			// Unused by userinfo (it authenticates with the caller's bearer), but
			// the client wants a well-formed registration: the login callback's
			// shape, derived from this request the same way the login flow does.
			{ redirectURI: `${url.origin}${base}/login/callback` },
			token,
			url
		);
	} catch (err) {
		logger.warn({ err }, "machine pairing bearer rejected by the identity provider");
		error(401, "That access token is not valid or has expired; run the enrollment again.");
	}

	// `sub` is the only user-id claim the chat keys users on (`hfUserId`, the
	// same mapping the login callback applies). A userinfo response without
	// it is not an identity this deployment can recognize.
	const identity = z.object({ sub: z.string().min(1) }).safeParse(userData);
	if (!identity.success) {
		error(401, "The access token carried no usable identity; run the enrollment again.");
	}

	// A token that identifies somebody the chat has never seen is a specific,
	// fixable state — the person may simply never have opened the chat. 404
	// rather than 401: the credential is fine, the account is what is missing.
	const user = await collections.users.findOne({ hfUserId: identity.data.sub });
	if (!user) {
		error(404, "Log into the chat once before pairing a machine.");
	}

	const parsed = machineSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Expected { name, offer }.");

	const offer = parseOffer(parsed.data.offer);
	// The handshake is the proof — the same load-bearing probe as the paste
	// flow: if the daemon on the other end of the relay does not answer with
	// the offer's own serverId, this offer describes a machine we cannot
	// actually reach, and no row may be written for it. The CLI maps this
	// failure onto relay/daemon diagnostics, so it is thrown verbatim here.
	const probe = await probePairingOffer({
		serverId: offer.serverId,
		daemonPublicKey: offer.daemonPublicKeyB64,
	}).catch(
		/* the probe maps its own failures to user-facing errors */ (err) => {
			logger.warn({ err, serverId: offer.serverId }, "machine pairing probe rejected");
			throw err;
		}
	);
	logger.info(
		{ userId: user._id.toString(), serverId: offer.serverId, version: probe.version },
		"machine pairing handshake completed through the relay"
	);

	const now = new Date();
	// One atomic upsert covers both arrival orders: a machine pairing for the
	// first time inserts its row, and a re-run of `enroll pair` (same daemon
	// `serverId`) rotates the stored public key and refreshes the name in
	// place — a machine that re-enrolls must not become two rows. The owner
	// is the token's user, built here rather than via `ownerFilter(locals)`:
	// there are no session locals on this path, only the resolved identity.
	const result = await collections.codeDevices.findOneAndUpdate(
		{ userId: user._id, daemonId: offer.serverId },
		{
			$set: {
				name: parsed.data.name,
				status: "paired",
				daemonPublicKey: offer.daemonPublicKeyB64,
				pairedAt: now,
				updatedAt: now,
			},
			$setOnInsert: {
				_id: new ObjectId(),
				userId: user._id,
				daemonId: offer.serverId,
				createdAt: now,
			},
			// A fresh pairing is never pending, so a pending row's single-use
			// code and expiry must not survive an update to `paired`.
			$unset: { pairingCode: "", expiresAt: "" },
		},
		{ returnDocument: "after", upsert: true }
	);
	// Driver v5: findOneAndUpdate returns ModifyResult unless told otherwise.
	const upserted = result?.value;
	if (!upserted) error(502, "The pairing could not be recorded.");
	return superjsonResponse({ device: deviceView(upserted) });
};
