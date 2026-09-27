import { findLoginUser, IssuerMismatchError, normalizeIssuer } from "$lib/server/loginIdentity";
import {
	getCoupledCookieHash,
	refreshSessionCookie,
	tokenSetToSessionOauth,
} from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { ObjectId } from "mongodb";
import { DEFAULT_SETTINGS } from "$lib/types/Settings";
import { z } from "zod";
import type { UserinfoResponse, TokenSet } from "openid-client";
import { error, type Cookies } from "@sveltejs/kit";
import crypto from "crypto";
import { sha256 } from "$lib/utils/sha256";
import { addWeeks } from "date-fns";
import { OIDConfig } from "$lib/server/auth";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import {
	foldPendingStrays,
	GatewayLoginError,
	isGatewayPreset,
	resolveGatewayLogin,
} from "$lib/server/identity/gatewayLogin";

// What counts as an email address here mirrors the issuer's own rule
// (the gateway's LocalLoginRequest): exactly one "@" with a non-empty
// local part, 3 to 320 characters. Deliberately not z.string().email(),
// which insists on a dotted domain — and an issuer-local address like
// `admin@local` legitimately has none. The chat receives what the
// gateway issued, so the gateway's acceptance rule is the principled
// one; anything it would refuse never arrives. The stored value keeps
// its shape verbatim either way: ALLOWED_USER_EMAILS/DOMAINS compare
// exact strings and a split domain downstream, and any normalisation
// here would silently loosen those admission checks.
//
// Shared with +server.ts, which parses the allowlist entries with the
// same rule: an entry shaped nothing the issuer could ever produce is a
// config error, and failing it at load beats admitting nobody.
export const issuerEmailSchema = z
	.string()
	.min(3)
	.max(320)
	.refine((value) => value.split("@").length === 2 && value.split("@")[0] !== "", {
		message: "Invalid email",
	});

export async function updateUser(params: {
	userData: UserinfoResponse;
	token: TokenSet;
	locals: App.Locals;
	cookies: Cookies;
	userAgent?: string;
	ip?: string;
	/** Which claim carries the display name. Defaults to the deployment's
	 * OPENID_NAME_CLAIM ("name", or "username" for providers that do not
	 * provide name); exposed so the fallback below is testable without
	 * re-importing the module under a different environment. */
	nameClaim?: string;
}) {
	const { userData, token, locals, cookies, userAgent, ip } = params;
	const nameClaim = params.nameClaim ?? OIDConfig.NAME_CLAIM;

	// Microsoft Entra v1 tokens do not provide preferred_username, instead the username is provided in the upn
	// claim. See https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference
	if (!userData.preferred_username && userData.upn) {
		userData.preferred_username = userData.upn as string;
	}

	// What counts as an email address is the issuer's own rule, shared above
	// (see issuerEmailSchema): exactly one "@" with a non-empty local part.

	const {
		preferred_username: username,
		name,
		email,
		picture: avatarUrl,
		sub: hfUserId,
		orgs,
	} = z
		.object({
			preferred_username: z.string().optional(),
			// Optional where it used to be required: OpenID Connect leaves
			// `name` optional, and a relying party that throws when a
			// provider omits it is wrong on its own terms. This schema came
			// from upstream chat-ui, where the provider was always Hugging
			// Face and always sent one; against our own IdP that assumption
			// does not hold (a local account without a display name sends
			// none). The effective name resolves below, from the configured
			// claim first and then down a fallback chain.
			name: z.string().optional(),
			picture: z.string().optional(),
			sub: z.string(),
			email: issuerEmailSchema.optional(),
			orgs: z
				.array(
					z.object({
						sub: z.string(),
						name: z.string(),
						picture: z.string(),
						preferred_username: z.string(),
						plan: z.string().optional(),
					})
				)
				.optional(),
		})
		// The deployment's display-name claim, which may or may not be
		// "name": when it is, this overwrites the optional base key with an
		// equally optional one (same constraint, no double jeopardy); when
		// it is "username" it adds that key instead. Either way the base
		// `name` above no longer throws for a provider that omits it, which
		// is the whole point — the transform below is what names the user.
		.setKey(nameClaim, z.string().optional())
		.refine(
			(data) =>
				Boolean(
					(data as Record<string, unknown>)[nameClaim] || data.preferred_username || data.email
				),
			{
				// `sub` alone is deliberately not enough: it identifies but
				// never names, and the panel footer and the account label
				// would have nothing to show. One human-readable seed is the
				// minimum for a user row.
				message:
					"Either the name claim, preferred_username or email must be provided by the provider.",
			}
		)
		.transform((data) => ({
			...data,
			// `||`, not `??`: an empty claim is no better than an absent one,
			// and the refine above guarantees at least one non-empty seed, so
			// this always lands on a real string.
			name:
				((data as Record<string, unknown>)[nameClaim] as string | undefined) ||
				(data.preferred_username as string | undefined) ||
				((data.email as string | undefined) ?? "").split("@")[0],
		}))
		.parse(userData) as {
		preferred_username?: string;
		email?: string;
		picture?: string;
		sub: string;
		name: string;
		orgs?: Array<{
			sub: string;
			name: string;
			picture: string;
			preferred_username: string;
			plan?: string;
		}>;
	} & Record<string, string>;

	// The display name resolves from the deployment's name claim first, then
	// down the fallback chain in the transform above — which keeps working
	// for a deployment that sets the claim to something else, because the
	// chain reads whichever key the claim names rather than a fixed one.

	logger.info(
		{
			login_username: username,
			login_name: name,
			login_email: email,
			login_orgs: orgs?.map((el) => el.sub),
		},
		"user login"
	);
	// Administrators are the gateway's decision (ADR 0069/0088), read per
	// session from GET /v1/me (gatewaySession.ts). The HuggingFace-organisation
	// path this replaced said nothing about who runs this deployment.
	const isAdmin = false;
	const isEarlyAccess =
		(config.HF_ORG_EARLY_ACCESS && orgs?.some((org) => org.sub === config.HF_ORG_EARLY_ACCESS)) ||
		false;

	logger.debug(
		{
			isAdmin,
			isEarlyAccess,
			hfUserId,
		},
		`Updating user ${hfUserId}`
	);

	// Which account is this? Keyed on (issuer, sub): a sub already recorded
	// under another issuer is refused, and CHAT_MIGRATE_ISSUER_FROM carries
	// accounts across an identity-provider move by verified email.
	let issuer = OIDConfig.PROVIDER_URL;
	try {
		const claimed = token.claims().iss;
		if (typeof claimed === "string" && claimed) issuer = claimed;
	} catch {
		// No ID token claims to read: the configured issuer is the one.
	}
	// On a gateway preset (ADR 0093 §4.2-4.3) the gateway's own id is the
	// person: `announce` runs first and fails the login closed, then
	// resolution is by `gatewayUserId`, never by `(issuer, hfUserId)`. The
	// generic (gateway-less) preset keeps `findLoginUser` (§4.5).
	let existingUser: Awaited<ReturnType<typeof findLoginUser>>;
	let gatewayUserId: string | undefined;
	let pendingStrays: ObjectId[] = [];
	if (isGatewayPreset()) {
		try {
			const resolved = await resolveGatewayLogin(token.access_token);
			existingUser = resolved.user;
			gatewayUserId = resolved.gatewayUserId;
			pendingStrays = resolved.pendingStrays;
		} catch (err) {
			if (err instanceof GatewayLoginError) error(err.status, err.message);
			throw err;
		}
	} else {
		try {
			existingUser = await findLoginUser(collections.users, {
				sub: hfUserId,
				issuer,
				email,
				emailVerified: (userData as Record<string, unknown>).email_verified,
				migrateFrom: config.CHAT_MIGRATE_ISSUER_FROM,
			});
		} catch (err) {
			if (err instanceof IssuerMismatchError) error(403, err.message);
			throw err;
		}
	}
	let userId = existingUser?._id;

	// update session cookie on login
	const previousSessionId = locals.sessionId;
	const secretSessionId = crypto.randomUUID();
	const sessionId = await sha256(secretSessionId);

	if (await collections.sessions.findOne({ sessionId })) {
		error(500, "Session ID collision");
	}

	locals.sessionId = sessionId;

	// Get cookie hash if coupling is enabled
	const coupledCookieHash = await getCoupledCookieHash(cookies);

	// Prepare OAuth token data for session storage
	const oauthData = tokenSetToSessionOauth(token);

	// The terminal step-up rule's input (ADR 0090 D6): when the person
	// actually authenticated, read once here and never touched again by a
	// later token refresh (`findUser`'s refresh path swaps the access token
	// only). A provider that omits the claim leaves this undefined, which
	// `sessionAuthFresh` (stepUp.ts) treats as stale rather than exempt.
	let authTime: Date | undefined;
	try {
		const claimed = token.claims().auth_time;
		if (typeof claimed === "number") authTime = new Date(claimed * 1000);
	} catch {
		// No ID token claims to read: authTime stays undefined (stale).
	}

	if (existingUser) {
		// update existing user if any
		await collections.users.updateOne(
			{ _id: existingUser._id },
			{
				$set: {
					username,
					name,
					avatarUrl,
					isAdmin,
					isEarlyAccess,
					// §4.3 step 7: on a gateway preset these are informational —
					// resolution never reads them again — but kept current so an
					// operator looking at the row sees this login's last identity.
					...(gatewayUserId ? { hfUserId, issuer: normalizeIssuer(issuer) } : {}),
					...(gatewayUserId && email ? { email } : {}),
				},
			}
		);

		// remove previous session if it exists and add new one
		await collections.sessions.deleteOne({ sessionId: previousSessionId });
		await collections.sessions.insertOne({
			_id: new ObjectId(),
			sessionId: locals.sessionId,
			userId: existingUser._id,
			createdAt: new Date(),
			updatedAt: new Date(),
			userAgent,
			ip,
			expiresAt: addWeeks(new Date(), 2),
			...(coupledCookieHash ? { coupledCookieHash } : {}),
			...(oauthData ? { oauth: oauthData } : {}),
			...(authTime ? { authTime } : {}),
		});
	} else {
		// user doesn't exist yet, create a new one
		const { insertedId } = await collections.users.insertOne({
			_id: new ObjectId(),
			createdAt: new Date(),
			updatedAt: new Date(),
			username,
			name,
			email,
			avatarUrl,
			hfUserId,
			issuer: normalizeIssuer(issuer),
			isAdmin,
			isEarlyAccess,
			...(gatewayUserId ? { gatewayUserId } : {}),
		});

		userId = insertedId;

		// §4.3 step 5: strays `resolveGatewayLogin` found but couldn't merge
		// yet, because there was no target until this row existed.
		if (gatewayUserId && pendingStrays.length > 0) {
			await foldPendingStrays(insertedId, pendingStrays);
		}

		await collections.sessions.insertOne({
			_id: new ObjectId(),
			sessionId: locals.sessionId,
			userId,
			createdAt: new Date(),
			updatedAt: new Date(),
			userAgent,
			ip,
			expiresAt: addWeeks(new Date(), 2),
			...(coupledCookieHash ? { coupledCookieHash } : {}),
			...(oauthData ? { oauth: oauthData } : {}),
			...(authTime ? { authTime } : {}),
		});

		// move pre-existing settings to new user
		const { matchedCount } = await collections.settings.updateOne(
			{ sessionId: previousSessionId },
			{
				$set: { userId, updatedAt: new Date() },
				$unset: { sessionId: "" },
			}
		);

		if (!matchedCount) {
			// if no settings found for user, create default settings
			await collections.settings.insertOne({
				userId,
				updatedAt: new Date(),
				createdAt: new Date(),
				...DEFAULT_SETTINGS,
			});
		}
	}

	// refresh session cookie
	refreshSessionCookie(cookies, secretSessionId);

	// migrate pre-existing conversations
	await collections.conversations.updateMany(
		{ sessionId: previousSessionId },
		{
			$set: { userId },
			$unset: { sessionId: "" },
		}
	);
}
