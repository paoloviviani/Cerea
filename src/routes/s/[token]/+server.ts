/**
 * A public artifact link (ADR 0120): the page around what is shared. Anyone's
 * links open for everyone, on the share host when there is one; a signed-in link
 * opens on the app's origin for a visitor with a session. Markdown, tables,
 * source and files get a read-only viewer; pages that run (HTML, React, slides,
 * diagrams, SVG) get a band the artifact cannot reach and the artifact itself in
 * a sandboxed frame loaded from `./doc`.
 */
import type { RequestHandler } from "./$types";
import { countShareView, findActiveShare } from "$lib/server/sharing/shares";
import {
	accessFor,
	notAvailable,
	prefixFor,
	signInRedirect,
	viewerOf,
} from "$lib/server/sharing/serve";
import {
	downloadName,
	isSandboxedShare,
	publicHeaders,
	viewerPage,
	wrapperPage,
} from "$lib/server/sharing/pages";

export const GET: RequestHandler = async (event) => {
	const { token } = event.params;
	const locale = event.locals.locale ?? "en";
	const share = await findActiveShare(token);
	if (!share) return notAvailable(locale);

	const access = accessFor(event, share);
	if (access === "denied") return notAvailable(locale);
	if (access === "sign_in") return signInRedirect(event);

	await countShareView(share, viewerOf(event));

	const prefix = `${prefixFor(event)}/${token}`;
	const page = isSandboxedShare(share)
		? wrapperPage(share, `${prefix}/doc`, locale)
		: viewerPage(share, `${prefix}/file/${encodeURIComponent(downloadName(share))}`, locale);
	return new Response(page.html, {
		headers: publicHeaders({
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": page.csp,
		}),
	});
};
