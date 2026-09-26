import type { ObjectId } from "mongodb";
import type { Timestamps } from "./Timestamps";

/** One identity this account answered to before a gateway merge folded it in
 * (ADR 0093 §3.3), kept for the generic preset's own migration (§4.5) — a
 * gateway preset asks the gateway instead of keeping its own history. */
export interface PreviousIdentity {
	issuer: string;
	sub: string;
	at: Date;
}

export interface User extends Timestamps {
	_id: ObjectId;

	username?: string;
	name: string;
	email?: string;
	avatarUrl: string | undefined;
	hfUserId: string;
	/** The OIDC issuer that minted `hfUserId` (absent on accounts from before it was recorded). */
	issuer?: string;
	/**
	 * `normalizeEmail(email)` (ADR 0093 §6.1), written wherever `email` is
	 * written. Not in §3.3's own field list — added here because §4.5's
	 * generic-preset migration match needs it and nothing else provides it;
	 * flagged as a gap in the worker's report. Absent on a row nothing has
	 * touched since this field started being written.
	 */
	emailNormalized?: string;
	/** The previous `sub`, when a login moved this account to a new issuer. */
	migratedFromSub?: string;
	isAdmin?: boolean;
	isEarlyAccess?: boolean;

	/**
	 * The gateway's `users.id` (ADR 0093 §3.3, §4.2): the stable key on a
	 * gateway preset. Links and merges only ever move identities onto it, so
	 * once this is set, resolution never falls back to `(issuer, hfUserId)`.
	 * A unique partial index covers documents where it is a string.
	 */
	gatewayUserId?: string;
	/**
	 * Set when this account has been folded into another one by
	 * `mergeChatUsers` (§7.2): the target's `_id`. A user with this set is
	 * never resolved as a login target, and a crash mid-merge resumes from
	 * `mergeState`.
	 */
	mergedInto?: ObjectId;
	/** Present only while a merge into this account is moving collections
	 * over; absent once the move (and the stray's deletion) has completed. */
	mergeState?: "moving";
	/** The last time this account's strays (gateway `merged_from`) were
	 * folded in, so the session check (§4.4) only re-fetches identities when
	 * the gateway's `merged_at` is newer than this. */
	lastMergeSyncAt?: Date;
	/** Every `(issuer, sub)` this account has answered to — the generic
	 * preset's own record of an issuer migration (§4.5), tracked because that
	 * preset has no gateway to ask. Not written on a gateway preset. */
	previousIdentities?: PreviousIdentity[];
}
