/**
 * The artifact's own document, for the frame (ADR 0120). Its whole policy is
 * `sandbox allow-scripts`: scripts run, but the page has no origin of its own
 * (no cookies, storage or same-origin requests), cannot submit forms, open
 * windows or navigate the page around it. The band lives in that page, not here,
 * so the artifact cannot remove it; opening this address as a page of its own
 * (browsers say so in `Sec-Fetch-Dest`) goes to the page with the band instead.
 */
import type { RequestHandler } from "./$types";
import { findActiveShare } from "$lib/server/sharing/shares";
import { accessFor, notAvailable, prefixFor } from "$lib/server/sharing/serve";
import { isSandboxedShare, publicHeaders, sandboxedDocument } from "$lib/server/sharing/pages";

export const GET: RequestHandler = async (event) => {
	const { token } = event.params;
	const locale = event.locals.locale ?? "en";
	const share = await findActiveShare(token);
	if (!share || !isSandboxedShare(share)) return notAvailable(locale);

	if (accessFor(event, share) !== "ok") return notAvailable(locale);

	if (event.request.headers.get("sec-fetch-dest") === "document") {
		return new Response(null, {
			status: 302,
			headers: publicHeaders({ Location: `${prefixFor(event)}/${token}` }),
		});
	}

	return new Response(sandboxedDocument(share), {
		headers: publicHeaders({
			"Content-Type": "text/html; charset=utf-8",
			// Exactly this, nothing added: the policy is the sandbox.
			"Content-Security-Policy": "sandbox allow-scripts",
		}),
	});
};
