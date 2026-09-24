/**
 * The gateway's word on a signed-in session, cached briefly (ADR 0088 draft).
 *
 * The gateway is the only authorisation authority: whether someone is an
 * administrator, and whether their account is active at all, is decided there
 * — by an administrator in the console, or by directory sync deactivating
 * someone who left. The chat's own `user.isAdmin` came from a HuggingFace
 * organisation claim and is not consulted any more.
 *
 * So each session asks `GET /v1/me` with its own access token, at most once a
 * minute. A 401 means the account (or the token) is no longer good, and the
 * session ends — which is how a directory deprovisioning reaches the chat
 * within a minute, not at the next login. A network failure fails *open*:
 * an unreachable gateway is not a disabled account, and every inference call
 * the session then makes still goes through the gateway, which refuses on its
 * own.
 */
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";

export type GatewayAnswer = { valid: true; isAdmin: boolean; groups: string[] } | { valid: false };

const TTL_MS = 60_000;
const MAX_ENTRIES = 5_000;
const cache = new Map<string, { at: number; answer: GatewayAnswer }>();

export interface GatewaySessionOptions {
	baseUrl?: string;
	userToken?: boolean;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

export async function gatewaySessionCheck(
	sessionId: string,
	token: string,
	options: GatewaySessionOptions = {}
): Promise<GatewayAnswer | null> {
	const baseUrl = (options.baseUrl ?? config.OPENAI_BASE_URL ?? "").replace(/\/$/, "");
	const userToken = options.userToken ?? config.USE_USER_TOKEN === "true";
	// No gateway, or a shared deployment key (the generic preset): there is
	// nobody to ask about this person.
	if (!baseUrl || !userToken || !token) return null;
	const now = (options.now ?? Date.now)();
	const hit = cache.get(sessionId);
	if (hit && now - hit.at < TTL_MS) return hit.answer;

	let answer: GatewayAnswer;
	try {
		const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/me`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(5_000),
		});
		if (response.status === 401) {
			answer = { valid: false };
		} else if (!response.ok) {
			return null;
		} else {
			const body = (await response.json()) as Record<string, unknown>;
			answer = {
				valid: true,
				isAdmin: body.is_admin === true,
				groups: Array.isArray(body.groups) ? body.groups.map(String) : [],
			};
		}
	} catch (err) {
		logger.warn({ err }, "gateway_session_check_unreachable");
		return null;
	}
	if (cache.size >= MAX_ENTRIES) cache.clear();
	cache.set(sessionId, { at: now, answer });
	return answer;
}

export function forgetGatewaySession(sessionId: string): void {
	cache.delete(sessionId);
}
