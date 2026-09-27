/**
 * Auth for the `/internal/*` surface (ADR 0093 §9.3): the gateway's own
 * service credential, `CHAT_ERASURE_TOKEN`, minted by `./configure` and
 * passed over the compose network only. Never reachable from the edge —
 * the Caddyfile answers 404 for `/chat/internal/*` and `/internal/*` before
 * any proxying (cerea-deploy's half); this is the chat's own backstop, so a
 * misconfigured or bypassed proxy still refuses rather than trusts a
 * forwarded request. Both checks apply regardless of which one would have
 * let the request through on its own — a valid token behind a proxy header
 * is refused exactly like an invalid one.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { error } from "@sveltejs/kit";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";

const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "forwarded"];

/** Hashing first means the driver's comparison length never depends on the
 * secret's, and `timingSafeEqual` (which throws on a length mismatch)
 * always sees two fixed-length digests. */
function constantTimeEqual(a: string, b: string): boolean {
	const bufA = createHash("sha256").update(a).digest();
	const bufB = createHash("sha256").update(b).digest();
	return timingSafeEqual(bufA, bufB);
}

export function assertInternalRequest(request: Request): void {
	const carriedProxyHeader = PROXY_HEADERS.find((name) => request.headers.has(name));
	if (carriedProxyHeader) {
		logger.warn({ header: carriedProxyHeader }, "internal_request_refused_proxy_header");
		error(401, "Not reachable from the edge.");
	}

	const configured = config.CHAT_ERASURE_TOKEN;
	const authorization = request.headers.get("authorization") ?? "";
	const provided = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
	if (!configured || !provided || !constantTimeEqual(provided, configured)) {
		logger.warn("internal_request_refused_bad_token");
		error(401, "Unauthorized");
	}
}
