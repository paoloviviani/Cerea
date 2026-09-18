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

/**
 * Let the gateway know this person exists, at login rather than eventually.
 *
 * The gateway learns about a user from the OIDC claims on a `/v1` request, so
 * until now somebody could sign into the chat and be **invisible in the
 * management console** until they sent their first message — or never, if they
 * only ever browsed. That reads as a broken console rather than as a lazy
 * write, and it was reported as one.
 *
 * `GET /v1/billing/groups` rather than a new endpoint, and not only to avoid
 * surface: the chat wants this answer at login anyway. It is how the settings
 * dropdown knows which groups the person may bill (ADR 0061), and fetching it
 * here means the first message does not pay for it. Provisioning is a *side
 * effect* of the call, which is worth stating plainly — but the call is one we
 * want regardless, and an endpoint whose only purpose was the side effect would
 * be a worse thing to explain.
 *
 * **Non-fatal, deliberately.** A gateway that is down, misconfigured, or does
 * not accept this token must not stop somebody logging into the chat: the
 * person is already authenticated by the identity provider, and refusing them
 * a session would turn a reporting gap into an outage. It is logged at info
 * so `gateway_login_announce` is greppable when a user is missing from the
 * console.
 */
async function announceToGateway(accessToken: string | undefined): Promise<void> {
	if (!accessToken || !config.OPENAI_BASE_URL) {
		return;
	}
	const base = config.OPENAI_BASE_URL.replace(/\/$/, "");
	try {
		const response = await fetch(`${base}/billing/groups`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (!response.ok) {
			logger.info(
				`gateway_login_announce: the gateway answered ${response.status}; this user ` +
					"will not appear in the management console until their first request"
			);
		}
	} catch (err) {
		logger.info({ err }, "gateway_login_announce: the gateway could not be reached");
	}
}

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
	const emailSchema = z
		.string()
		.min(3)
		.max(320)
		.refine((value) => value.split("@").length === 2 && value.split("@")[0] !== "", {
			message: "Invalid email",
		});

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
			email: emailSchema.optional(),
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
	// if using huggingface as auth provider, check orgs for earl access and amin rights
	const isAdmin =
		(config.HF_ORG_ADMIN && orgs?.some((org) => org.sub === config.HF_ORG_ADMIN)) || false;
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

	// check if user already exists
	const existingUser = await collections.users.findOne({ hfUserId });
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

	if (existingUser) {
		// update existing user if any
		await collections.users.updateOne(
			{ _id: existingUser._id },
			{ $set: { username, name, avatarUrl, isAdmin, isEarlyAccess } }
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
			isAdmin,
			isEarlyAccess,
		});

		userId = insertedId;

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

	// Last, and awaited rather than detached: the session is already written, so
	// a slow gateway delays the redirect but cannot lose the login, and a
	// detached call in a serverless-shaped runtime is a call that may never run.
	await announceToGateway(token.access_token);
}
