/**
 * Which chat account a login is (ADR 0088 draft, report §8.8 and §10.2).
 *
 * People are keyed on the OIDC `sub` (`hfUserId`), and now also carry the
 * `issuer` that minted it. Two rules follow:
 *
 * - A login whose `sub` matches an account recorded under a *different*
 *   issuer is refused. Before, any issuer's `sub` could claim an account,
 *   which becomes a takeover the day a deployment changes identity provider.
 *   Accounts from before this rule carry no issuer and adopt the first one
 *   seen.
 * - Moving to a new identity provider (off the house IdP, say) gives everyone
 *   a new `sub`. With `CHAT_MIGRATE_ISSUER_FROM` set to the old issuer, a
 *   login with no account yet takes over the old issuer's account with the
 *   same *verified* email — conversations, memory and knowledge bases follow
 *   the person instead of starting empty.
 *
 * ADR 0093 §4.5 keeps this exact machinery for the generic (gateway-less)
 * preset — it has no gateway to ask, no console and no merge — with two
 * changes: the migration match is by normalised email equality rather than
 * an exact string (`emailNormalized`, §6.1), and every migration appends the
 * account's old `(issuer, sub)` to `previousIdentities` instead of only
 * overwriting `hfUserId`, so a later switch back to an issuer this account
 * has already answered to finds it again even after more than one hop.
 */
import type { Collection } from "mongodb";
import type { User } from "$lib/types/User";
import { normalizeEmail } from "./identity/normalizeEmail";

export class IssuerMismatchError extends Error {}

export function normalizeIssuer(issuer: string): string {
	return issuer.trim().replace(/\/+$/, "");
}

export async function findLoginUser(
	users: Pick<Collection<User>, "findOne" | "updateOne">,
	login: {
		sub: string;
		issuer: string;
		email?: string;
		emailVerified?: unknown;
		migrateFrom?: string;
	}
): Promise<User | null> {
	const issuer = normalizeIssuer(login.issuer);
	const existing = await users.findOne({ hfUserId: login.sub });
	if (existing) {
		if (existing.issuer && normalizeIssuer(existing.issuer) !== issuer) {
			throw new IssuerMismatchError(
				"This account belongs to a different identity provider. Ask an administrator to migrate it."
			);
		}
		if (!existing.issuer) {
			await users.updateOne({ _id: existing._id }, { $set: { issuer } });
			existing.issuer = issuer;
		}
		return existing;
	}
	const migrateFrom = login.migrateFrom ? normalizeIssuer(login.migrateFrom) : "";
	if (!migrateFrom || login.emailVerified !== true || !login.email) return null;
	const normalizedEmail = normalizeEmail(login.email);
	// Flattened rather than `$and`-of-`$or` so a plain-object test double only
	// needs to support `$or` and `$exists` (as `loginIdentity.spec.ts`'s does):
	// each line is one concrete (email match, issuer match) combination.
	// `previousIdentities.issuer` is dot-notation into the array of past
	// identities — real MongoDB matches it against every element; a fake
	// collection with no such array on a row simply never matches that line.
	const previous = await users.findOne({
		$or: [
			{ emailNormalized: normalizedEmail, issuer: migrateFrom },
			{ emailNormalized: normalizedEmail, issuer: { $exists: false } },
			{ emailNormalized: normalizedEmail, "previousIdentities.issuer": migrateFrom },
			{ email: login.email, issuer: migrateFrom },
			{ email: login.email, issuer: { $exists: false } },
			{ email: login.email, "previousIdentities.issuer": migrateFrom },
		],
	} as never);
	if (!previous) return null;
	await users.updateOne({ _id: previous._id }, {
		$set: {
			hfUserId: login.sub,
			issuer,
			migratedFromSub: previous.hfUserId,
			emailNormalized: normalizedEmail,
		},
		$push: {
			previousIdentities: {
				issuer: previous.issuer ? normalizeIssuer(previous.issuer) : migrateFrom,
				sub: previous.hfUserId,
				at: new Date(),
			},
		},
	} as never);
	return { ...previous, hfUserId: login.sub, issuer, emailNormalized: normalizedEmail };
}
