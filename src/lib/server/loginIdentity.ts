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
 */
import type { Collection } from "mongodb";
import type { User } from "$lib/types/User";

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
	const previous = await users.findOne({
		email: login.email,
		$or: [{ issuer: migrateFrom }, { issuer: { $exists: false } }],
	});
	if (!previous) return null;
	await users.updateOne(
		{ _id: previous._id },
		{ $set: { hfUserId: login.sub, issuer, migratedFromSub: previous.hfUserId } }
	);
	return { ...previous, hfUserId: login.sub, issuer };
}
