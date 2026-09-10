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
}) {
	const { userData, token, locals, cookies, userAgent, ip } = params;

	// Microsoft Entra v1 tokens do not provide preferred_username, instead the username is provided in the upn
	// claim. See https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference
	if (!userData.preferred_username && userData.upn) {
		userData.preferred_username = userData.upn as string;
	}

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
			name: z.string(),
			picture: z.string().optional(),
			sub: z.string(),
			email: z.string().email().optional(),
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
		.setKey(OIDConfig.NAME_CLAIM, z.string())
		.refine((data) => data.preferred_username || data.email, {
			message: "Either preferred_username or email must be provided by the provider.",
		})
		.transform((data) => ({
			...data,
			name: data[OIDConfig.NAME_CLAIM],
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

	// Dynamically access user data based on NAME_CLAIM from environment
	// This approach allows us to adapt to different OIDC providers flexibly.

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
