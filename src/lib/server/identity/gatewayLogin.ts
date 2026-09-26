/**
 * The chat's login resolution on a gateway preset (ADR 0093 §4.2, §4.3):
 * the gateway's `users.id` is the person, not `(issuer, hfUserId)`.
 *
 * Applies when `OPENAI_BASE_URL` and `USE_USER_TOKEN=true` are set. The
 * login callback calls `announce` with the fresh access token before
 * anything else, and fails closed: a gateway that is down, or that refuses
 * the token, must not create an unkeyed chat account, which is the orphan
 * this design removes (§4.3 step 1). `IssuerMismatchError` and
 * `CHAT_MIGRATE_ISSUER_FROM` are not reached here — that machinery is
 * `loginIdentity.ts`'s, kept only for the generic (gateway-less) preset
 * (§4.5).
 */
import type { Collection, ObjectId } from "mongodb";

import { collections } from "$lib/server/database";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import type { User } from "$lib/types/User";
import { normalizeIssuer } from "$lib/server/loginIdentity";
import { announce, type GatewayIdentityOptions } from "./gatewayIdentity";
import { mergeChatUsers } from "./mergeChatUsers";

export function isGatewayPreset(): boolean {
	return Boolean(config.OPENAI_BASE_URL) && config.USE_USER_TOKEN === "true";
}

export class GatewayLoginError extends Error {
	constructor(
		readonly status: 401 | 403 | 503,
		message: string
	) {
		super(message);
		this.name = "GatewayLoginError";
	}
}

/**
 * `user: null` means genuinely new: no existing row matched and there was
 * nothing to adopt. The caller (`updateUser.ts`) creates the row — so it can
 * also create the session and default settings the way a brand-new account
 * already does — stamping `gatewayUserId` on it, and then calls
 * `foldPendingStrays` with `pendingStrays` once the row exists.
 */
export interface GatewayLoginResolution {
	user: User | null;
	gatewayUserId: string;
	pendingStrays: ObjectId[];
}

function gatewayOptions(explicit?: GatewayIdentityOptions): GatewayIdentityOptions {
	return explicit ?? { baseUrl: config.OPENAI_BASE_URL ?? "" };
}

/** A user document matching the gateway's id, and not itself mid-merge into
 * someone else — the guard that a stray with `mergedInto` set is never a
 * login target, applied here too since a crash could leave one holding a
 * stale `gatewayUserId` while `mergeState: "moving"` is still set. */
async function findByGatewayUserId(
	users: Pick<Collection<User>, "findOne">,
	gatewayUserId: string
): Promise<User | null> {
	return users.findOne({ gatewayUserId, mergedInto: { $exists: false } } as never);
}

/** The chat users this gateway id's login should fold in (§4.3 step 3, and
 * §4.4's background fold): either a gateway id the gateway just told us was
 * merged into this one, or an unclaimed legacy account still keyed on the
 * old `(issuer, hfUserId)` shape. Never a user already mid-merge into
 * someone else. Exported so the session check (`gatewaySession.ts`) can run
 * the same query against `GET /v1/me/identities`'s answer. */
export async function findStrays(
	users: Pick<Collection<User>, "find">,
	mergedFrom: string[],
	identities: { issuer: string; subject: string }[]
): Promise<User[]> {
	const clauses: Record<string, unknown>[] = [];
	if (mergedFrom.length > 0) {
		clauses.push({ gatewayUserId: { $in: mergedFrom } });
	}
	if (identities.length > 0) {
		clauses.push({
			gatewayUserId: { $exists: false },
			$or: identities.map((identity) => ({
				issuer: normalizeIssuer(identity.issuer),
				hfUserId: identity.subject,
			})),
		});
	}
	if (clauses.length === 0) return [];
	return users.find({ mergedInto: { $exists: false }, $or: clauses } as never).toArray();
}

/** Merge every stray into the target, skipping a stray that (by some race)
 * already names the target itself. Shared by `resolveGatewayLogin`'s own
 * merge step and the session check's background fold. */
export async function mergeStrays(strays: User[], targetId: ObjectId): Promise<void> {
	for (const stray of strays) {
		if (stray._id.equals(targetId)) continue;
		await mergeChatUsers(stray._id, targetId);
	}
}

export async function resolveGatewayLogin(
	accessToken: string | undefined,
	options?: GatewayIdentityOptions
): Promise<GatewayLoginResolution> {
	if (!accessToken) {
		throw new GatewayLoginError(503, "The gateway is unavailable, try again in a minute.");
	}
	const result = await announce(accessToken, gatewayOptions(options));
	if (!result.ok) {
		if (result.refused) {
			throw new GatewayLoginError(result.status as 401 | 403, result.message);
		}
		logger.warn(
			{ status: result.status },
			"gateway_login_announce_unreachable: failing the login closed"
		);
		throw new GatewayLoginError(503, "The gateway is unavailable, try again in a minute.");
	}
	const info = result.value;

	let target = await findByGatewayUserId(collections.users, info.id);
	let strays = await findStrays(collections.users, info.merged_from, info.identities);

	if (!target && strays.length === 1) {
		const adopted = strays[0];
		await collections.users.updateOne({ _id: adopted._id }, { $set: { gatewayUserId: info.id } });
		target = { ...adopted, gatewayUserId: info.id };
		strays = [];
	}

	if (!target) {
		return { user: null, gatewayUserId: info.id, pendingStrays: strays.map((s) => s._id) };
	}

	await mergeStrays(strays, target._id);

	return { user: target, gatewayUserId: info.id, pendingStrays: [] };
}

/** Fold the strays `resolveGatewayLogin` found but couldn't merge yet (there
 * was no target to merge them into) — called right after `updateUser.ts`
 * inserts the brand-new row. */
export async function foldPendingStrays(
	targetId: ObjectId,
	pendingStrays: ObjectId[]
): Promise<void> {
	for (const strayId of pendingStrays) {
		if (strayId.equals(targetId)) continue;
		await mergeChatUsers(strayId, targetId);
	}
}
