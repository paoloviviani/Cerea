/**
 * An in-memory stand-in for the gateway's identity endpoints (ADR 0093 §4),
 * for specs: a `fetch` that answers `/session/announce`, `/me` and
 * `/me/identities` from a table of tokens. The real contract is Pystino's
 * `schemas.py` (`SessionAnnounce`, `MeIdentities`, `CallerIdentity`); keep the
 * shapes here in step with `gatewayIdentity.ts`.
 */
import type { GatewayMe, MeIdentities, SessionAnnounce } from "./gatewayIdentity";

export interface MockPerson {
	id: string;
	identities: { issuer: string; subject: string }[];
	mergedFrom?: string[];
	isActive?: boolean;
	isAdmin?: boolean;
	groups?: string[];
	sessionsValidAfter?: string | null;
	mergedAt?: string | null;
}

export interface MockGateway {
	fetch: typeof fetch;
	/** token → person; mutate to simulate links, merges and disables. */
	tokens: Map<string, MockPerson>;
	/** When set, every call fails as the network would (`down`) or with 5xx. */
	failure: "down" | 500 | null;
	calls: string[];
}

export function mockGateway(): MockGateway {
	const state: MockGateway = {
		tokens: new Map(),
		failure: null,
		calls: [],
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input.toString());
			const path = url.pathname.replace(/^.*\/v1/, "");
			state.calls.push(`${init?.method ?? "GET"} ${path}`);
			if (state.failure === "down") throw new TypeError("fetch failed");
			if (state.failure) return new Response("{}", { status: state.failure });
			const auth = new Headers(init?.headers).get("authorization") ?? "";
			const person = state.tokens.get(auth.replace(/^Bearer /, ""));
			if (!person) return json({ error: { message: "Invalid API key provided." } }, 401);
			if (person.isActive === false) {
				return json({ error: { message: "This account is not enabled." } }, 403);
			}
			const ids: MeIdentities = {
				id: person.id,
				identities: person.identities,
				merged_from: person.mergedFrom ?? [],
			};
			if (path === "/session/announce") {
				const body: SessionAnnounce = {
					...ids,
					is_active: true,
					is_admin: person.isAdmin ?? false,
					sessions_valid_after: person.sessionsValidAfter ?? null,
					merged_at: person.mergedAt ?? null,
				};
				return json(body);
			}
			if (path === "/me") {
				const body: GatewayMe = {
					id: person.id,
					is_admin: person.isAdmin ?? false,
					groups: person.groups ?? [],
					sessions_valid_after: person.sessionsValidAfter ?? null,
					merged_at: person.mergedAt ?? null,
				};
				return json(body);
			}
			if (path === "/me/identities") return json(ids);
			return json({ error: { message: "not found" } }, 404);
		}) as typeof fetch,
	};
	return state;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
