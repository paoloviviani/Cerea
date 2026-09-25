/**
 * The gateway's answer to "who is this person" (ADR 0093 §4).
 *
 * On a gateway preset the chat no longer decides identity from `(issuer, sub)`
 * on its own: the gateway's user id is the person, links and merges only ever
 * move identities onto it, and the chat keys its records on it
 * (`User.gatewayUserId`). These are the three calls that carry that answer.
 *
 * - `announce` is the chat's sign-in door: the login callback calls it with the
 *   fresh access token, and the gateway runs its own sign-in sequence (links,
 *   bindings, admin rules) before answering. Failure fails the login closed.
 * - `me` is the per-minute session check (`gatewaySession.ts`).
 * - `identities` is fetched when `me.merged_at` says records were merged in.
 */

export interface IdentityRef {
	issuer: string;
	subject: string;
}

export interface MeIdentities {
	id: string;
	identities: IdentityRef[];
	/** Gateway ids merged into this one, chains resolved. */
	merged_from: string[];
}

export interface SessionAnnounce extends MeIdentities {
	is_active: boolean;
	is_admin: boolean;
	/** ISO timestamp; a chat session created before it is no longer good. */
	sessions_valid_after: string | null;
	merged_at: string | null;
}

/** The subset of `GET /v1/me` the chat reads. */
export interface GatewayMe {
	id: string;
	is_admin: boolean;
	groups: string[];
	sessions_valid_after: string | null;
	merged_at: string | null;
}

export type GatewayCall<T> =
	| { ok: true; value: T }
	/** 401/403: the token or the account is refused. */
	| { ok: false; refused: true; status: number; message: string }
	/** Network error or 5xx: the gateway could not answer. */
	| { ok: false; refused: false; status: number | null };

export interface GatewayIdentityOptions {
	/** The gateway's `/v1` base, `OPENAI_BASE_URL`. */
	baseUrl: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

async function call<T>(
	method: "GET" | "POST",
	path: string,
	token: string,
	options: GatewayIdentityOptions
): Promise<GatewayCall<T>> {
	const base = options.baseUrl.replace(/\/$/, "");
	let response: Response;
	try {
		response = await (options.fetchImpl ?? fetch)(`${base}${path}`, {
			method,
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
		});
	} catch {
		return { ok: false, refused: false, status: null };
	}
	if (response.status === 401 || response.status === 403) {
		let message = "Your account is not enabled here. Ask an administrator.";
		try {
			const body = (await response.json()) as { error?: { message?: unknown } };
			if (typeof body?.error?.message === "string") message = body.error.message;
		} catch {
			// The status is the answer; the body is only a nicer message.
		}
		return { ok: false, refused: true, status: response.status, message };
	}
	if (!response.ok) return { ok: false, refused: false, status: response.status };
	return { ok: true, value: (await response.json()) as T };
}

export function announce(token: string, options: GatewayIdentityOptions) {
	return call<SessionAnnounce>("POST", "/session/announce", token, options);
}

export function me(token: string, options: GatewayIdentityOptions) {
	return call<GatewayMe>("GET", "/me", token, options);
}

export function identities(token: string, options: GatewayIdentityOptions) {
	return call<MeIdentities>("GET", "/me/identities", token, options);
}
