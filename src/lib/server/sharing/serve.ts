import { createHash } from "node:crypto";
import type { RequestEvent } from "@sveltejs/kit";
import { base } from "$app/paths";
import type { SharedArtifact } from "$lib/types/SharedArtifact";
import { publicHeaders, unavailablePage } from "./pages";
import { shareHost, sharePath } from "./urls";

/** One answer for every reason a link does not resolve: unknown, revoked, expired, off. */
export function notAvailable(locale: string | undefined): Response {
	const page = unavailablePage(locale ?? "en");
	return new Response(page.html, {
		status: 404,
		headers: publicHeaders({
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": page.csp,
		}),
	});
}

export function clientIp(event: Pick<RequestEvent, "getClientAddress">): string | undefined {
	try {
		return event.getClientAddress();
	} catch {
		return undefined;
	}
}

/** A coarse viewer identity for the daily view count: never stored, only compared. */
export function viewerOf(event: Pick<RequestEvent, "getClientAddress" | "request">): string {
	const ua = event.request.headers.get("user-agent") ?? "";
	return createHash("sha256")
		.update(`${clientIp(event) ?? ""}|${ua}`)
		.digest("hex")
		.slice(0, 16);
}

/** Whether this request came in on the share subdomain rather than the app's own host. */
export function onShareHost(event: Pick<RequestEvent, "request" | "url">): boolean {
	const host = shareHost();
	if (!host) return false;
	const asked = (event.request.headers.get("host") ?? event.url.host).toLowerCase();
	return asked === host.toLowerCase();
}

/** The path prefix links carry on the origin this request came in on: none on the share host. */
export function prefixFor(event: Pick<RequestEvent, "request" | "url">): string {
	return onShareHost(event) ? "" : sharePath();
}

/** A signed-in visitor-to-be goes to sign in, and comes back to this very address. */
export function signInRedirect(event: Pick<RequestEvent, "url">): Response {
	const here = `${event.url.pathname}${event.url.search}`;
	return new Response(null, {
		status: 302,
		headers: publicHeaders({ Location: `${base}/login?next=${encodeURIComponent(here)}` }),
	});
}

export type Access = "ok" | "sign_in" | "denied";

/**
 * May this request see the link? Each audience has its own address (ADR 0120):
 * anyone's links open on the share host when there is one (and not on the app's
 * own host); a signed-in link opens only on the app's origin, with the visitor's
 * session, and a visitor without one is sent to sign in.
 */
export function accessFor(event: RequestEvent, share: SharedArtifact): Access {
	const onShare = onShareHost(event);
	if (share.audience === "anyone") {
		return shareHost() && !onShare ? "denied" : "ok";
	}
	if (onShare) return "denied";
	return event.locals.user ? "ok" : "sign_in";
}
