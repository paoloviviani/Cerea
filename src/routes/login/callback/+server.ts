import { error, isRedirect, redirect } from "@sveltejs/kit";
import {
	clearLoginRetryCookie,
	getOIDCUserData,
	BACKGROUND_COOKIE,
	hasLoginRetryCookie,
	offlineAccessAvailable,
	setBackgroundCookie,
	sanitizeReturnPath,
	setLoginRetryCookie,
	validateAndParseCsrfToken,
} from "$lib/server/auth";
import { z } from "zod";
import { logger } from "$lib/server/logger";
import { base } from "$app/paths";
import { config } from "$lib/server/config";
import JSON5 from "json5";
import { updateUser, issuerEmailSchema } from "./updateUser.js";
import { collections } from "$lib/server/database";
import { hasGrant } from "$lib/server/schedules/grants";
import { sealingAvailable } from "$lib/server/mcp/secretBox";

const sanitizeJSONEnv = (val: string, fallback: string) => {
	const raw = (val ?? "").trim();
	const unquoted = raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1) : raw;
	return unquoted || fallback;
};

const allowedUserEmails = z
	.array(issuerEmailSchema)
	.optional()
	.default([])
	.parse(JSON5.parse(sanitizeJSONEnv(config.ALLOWED_USER_EMAILS, "[]")));

const allowedUserDomains = z
	.array(
		// The part after the "@", compared verbatim — and a bare `local` is
		// a legitimate domain here, so this is deliberately not a
		// dotted-domain regex. Anything with an "@" or whitespace cannot be
		// a domain and fails at load, which is where a config typo belongs.
		z
			.string()
			.min(1)
			.max(255)
			.refine((value) => !value.includes("@") && !/\s/.test(value), {
				message: "Invalid domain",
			})
	)
	.optional()
	.default([])
	.parse(JSON5.parse(sanitizeJSONEnv(config.ALLOWED_USER_DOMAINS, "[]")));

export async function GET({ url, locals, cookies, request, getClientAddress }) {
	const { error: errorName, error_description: errorDescription } = z
		.object({
			error: z.string().optional(),
			error_description: z.string().optional(),
		})
		.parse(Object.fromEntries(url.searchParams.entries()));

	if (errorName) {
		const stateParam = url.searchParams.get("state");
		const failed = stateParam
			? await validateAndParseCsrfToken(
					Buffer.from(stateParam, "base64").toString("utf-8"),
					locals.sessionId
				)
			: null;

		if (failed?.offline) {
			// The sign-in (or the extra round) asked for `offline_access` and the IdP said no: the client
			// does not allow it (`invalid_scope`), the person declined the consent (`access_denied`), or
			// the IdP failed (`server_error`). Whatever it was, background access is given up on for this
			// browser (the "0" cookie, so the next sign-in does not ask) and the person goes on without it:
			// back where they were if they are already signed in (the extra round), else a plain sign-in.
			// One fallback per browser, so no error on an offline-flagged state can loop or lock anyone out.
			setBackgroundCookie(cookies, false);
			const signedIn = await collections.sessions
				.findOne({ sessionId: locals.sessionId, userId: { $exists: true } })
				.then(Boolean)
				.catch(() => false);
			if (signedIn) return redirect(302, failed.next ?? `${base}/`);
			return redirect(
				302,
				`${base}/login${failed.next ? `?next=${encodeURIComponent(failed.next)}` : ""}`
			);
		}

		if (errorName === "server_error" && !hasLoginRetryCookie(cookies)) {
			// Authelia 4.39 answers the first authorization after a remembered consent was saved with a
			// `server_error` ("could not save the consent session"), though the consent is kept and the next
			// attempt goes straight through: sign in again, once.
			setLoginRetryCookie(cookies);
			return redirect(
				302,
				`${base}/login${failed?.next ? `?next=${encodeURIComponent(failed.next)}` : ""}`
			);
		}

		throw error(400, errorName + (errorDescription ? ": " + errorDescription : ""));
	}

	const { code, state, iss } = z
		.object({
			code: z.string(),
			state: z.string(),
			iss: z.string().optional(),
		})
		.parse(Object.fromEntries(url.searchParams.entries()));

	const csrfToken = Buffer.from(state, "base64").toString("utf-8");

	const validatedToken = await validateAndParseCsrfToken(csrfToken, locals.sessionId);
	const codeVerifier = cookies.get("hfChat-codeVerifier");

	if (!validatedToken || !codeVerifier) {
		// The `state` token and PKCE code verifier are bound to the browser that started the
		// login flow, so either check can fail on its own; when the callback lands in a
		// different browser (e.g. "Open in Safari" from an in-app browser) both do. Restart
		// the flow once in this browser instead of dead-ending on a 403.
		if (!hasLoginRetryCookie(cookies)) {
			setLoginRetryCookie(cookies);

			// Best-effort recovery of the return path and redirect URI from the (unverified)
			// state payload; the path is re-sanitized and the redirect URI is checked against
			// ALTERNATIVE_REDIRECT_URLS both here and again in triggerOauthFlow before use.
			const retryParams = new URLSearchParams();
			try {
				const data = JSON.parse(csrfToken)?.data;
				const next = sanitizeReturnPath(data?.next);
				if (next) {
					retryParams.set("next", next);
				}
				if (
					typeof data?.redirectUrl === "string" &&
					config.ALTERNATIVE_REDIRECT_URLS.includes(data.redirectUrl)
				) {
					retryParams.set("callback", data.redirectUrl);
				}
			} catch {
				// Malformed state: retry without a return path or alternate redirect URI.
			}

			const retryQuery = retryParams.toString();
			return redirect(302, `${base}/login${retryQuery ? `?${retryQuery}` : ""}`);
		}

		throw error(
			403,
			validatedToken ? "Code verifier cookie not found" : "Invalid or expired CSRF token"
		);
	}

	const { userData, token } = await getOIDCUserData(
		{ redirectURI: validatedToken.redirectUrl },
		code,
		codeVerifier,
		iss,
		url
	);

	// Filter by allowed user emails or domains
	if (allowedUserEmails.length > 0 || allowedUserDomains.length > 0) {
		if (!userData.email) {
			throw error(403, "User not allowed: email not returned");
		}
		const emailVerified = userData.email_verified ?? true;
		if (!emailVerified) {
			throw error(403, "User not allowed: email not verified");
		}

		const emailDomain = userData.email.split("@")[1];
		const isEmailAllowed = allowedUserEmails.includes(userData.email);
		const isDomainAllowed = allowedUserDomains.includes(emailDomain);

		if (!isEmailAllowed && !isDomainAllowed) {
			throw error(403, "User not allowed");
		}
	}

	await updateUser({
		userData,
		token,
		locals,
		cookies,
		userAgent: request.headers.get("user-agent") ?? undefined,
		ip: getClientAddress(),
	});

	clearLoginRetryCookie(cookies);

	// Background access (the refresh token behind sessions and scheduled chats): settled for this browser,
	// or asked for once more when the person turns out to have none (a dropped grant, a first sign-in
	// that did not ask). The extra round signs nobody in again: the IdP's session answers it.
	try {
		const session = await collections.sessions.findOne({ sessionId: locals.sessionId });
		if (session?.userId) {
			const settings = { redirectURI: validatedToken.redirectUrl };
			if (await hasGrant(session.userId)) {
				setBackgroundCookie(cookies, true);
			} else if (validatedToken.offline) {
				// Asked, and nothing came back: not asked again for a while.
				setBackgroundCookie(cookies, false);
			} else if (
				cookies.get(BACKGROUND_COOKIE) !== "0" &&
				sealingAvailable() &&
				(await offlineAccessAvailable(settings, url))
			) {
				const retry = new URLSearchParams({ offline: "1" });
				if (validatedToken.next) retry.set("next", validatedToken.next);
				return redirect(302, `${base}/login?${retry}`);
			}
		}
	} catch (err) {
		// Bookkeeping about background access must never stand between a person and their sign-in.
		if (isRedirect(err)) throw err;
		logger.warn({ err }, "background_access_check_failed");
	}

	// Prefer returning the user to their original in-app path when provided.
	// `validatedToken.next` is sanitized server-side to avoid protocol-relative redirects.
	const next = validatedToken.next;
	if (next) {
		return redirect(302, next);
	}
	return redirect(302, `${base}/`);
}
