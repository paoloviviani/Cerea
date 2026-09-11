/**
 * Who administers *this* chat, asked of the gateway.
 *
 * The chat has a `user.isAdmin` of its own and it is worthless here: it is
 * derived from a HuggingFace organisation claim (`updateUser.ts`), which says
 * nothing about who runs this deployment. Two answers to "is this person an
 * administrator" is one answer too many, and the gateway's is the one that
 * governs the data — so this asks it and believes nothing else.
 *
 * It used to be asked by calling `/v1/knowledge/config` and reading its 403.
 * That worked, but it made "can you see the knowledge configuration" the
 * definition of administrator, and every new panel section would have needed a
 * probe of its own. `GET /v1/me` answers the actual question.
 *
 * The token never reaches the browser. It lives in the session and is used
 * here, server-side, for the same reason every gateway call in this app is
 * proxied: a token in a browser makes every extension on the page a gateway
 * client.
 */

import { error } from "@sveltejs/kit";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";

export interface CallerIdentity {
	id: string;
	email: string | null;
	displayName: string | null;
	isAdmin: boolean;
	/** `access_token` or `api_key`. See below for why it matters. */
	credential: string;
	groups: string[];
	defaultBillingGroup: string | null;
}

function gatewayBase(): string {
	if (!config.OPENAI_BASE_URL) {
		error(404, "This deployment has no gateway configured.");
	}
	return config.OPENAI_BASE_URL.replace(/\/$/, "");
}

/**
 * The signed-in person as the gateway sees them, or null if we cannot ask.
 *
 * Null rather than throwing, because the layout wants to render a readable
 * refusal rather than a stack trace: "you are not signed in with an identity
 * provider" and "the gateway says you are not an administrator" are different
 * problems and send somebody to different places.
 */
export async function callerIdentity(locals: App.Locals): Promise<CallerIdentity | null> {
	if (!locals.user || !locals.token) return null;

	try {
		const response = await fetch(`${gatewayBase()}/me`, {
			headers: { authorization: `Bearer ${locals.token}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			logger.info({ status: response.status }, "gateway_identity_refused");
			return null;
		}
		const body = (await response.json()) as Record<string, unknown>;
		return {
			id: String(body.id ?? ""),
			email: typeof body.email === "string" ? body.email : null,
			displayName: typeof body.display_name === "string" ? body.display_name : null,
			// Note what is *not* done here: no local fallback, no "or
			// locals.user.isAdmin". A flag the gateway did not set is not an
			// answer to this question.
			isAdmin: body.is_admin === true,
			credential: typeof body.credential === "string" ? body.credential : "unknown",
			groups: Array.isArray(body.groups) ? body.groups.map(String) : [],
			defaultBillingGroup:
				typeof body.default_billing_group === "string" ? body.default_billing_group : null,
		};
	} catch (err) {
		logger.warn({ err }, "gateway_identity_unreachable");
		return null;
	}
}

/**
 * Refuse anybody the gateway does not call an administrator.
 *
 * Used by the admin API routes. The layout does its own, softer version so it
 * can explain rather than 403 — but every *route* that changes something calls
 * this, because a page that renders is not a permission.
 */
export async function requireAdmin(locals: App.Locals): Promise<CallerIdentity> {
	const identity = await callerIdentity(locals);
	if (!identity) {
		error(401, "This needs a session from the identity provider. Log out and sign in through it.");
	}
	if (!identity.isAdmin) {
		error(403, "This deployment's gateway does not list you as an administrator.");
	}
	return identity;
}
