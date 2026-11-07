/**
 * The organisation's slide logo (ADR 0111), served as the image itself so it
 * stays out of the page data that every navigation carries. Signed-in users
 * and sessions only; cacheable by the browser; 404 when none is set.
 */
import { error, type RequestHandler } from "@sveltejs/kit";
import { createHash } from "node:crypto";
import { slideDefaults } from "$lib/server/slideDefaults";

const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([a-z0-9+/=]+)$/i;

export const GET: RequestHandler = async ({ locals, request }) => {
	if (!locals.user && !locals.sessionId) error(401, "Login required");
	const logo = slideDefaults().logo;
	const match = logo ? DATA_URL.exec(logo) : null;
	if (!match) error(404, "No logo is set.");
	const bytes = Buffer.from(match[2], "base64");
	const etag = `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`;
	const headers = {
		ETag: etag,
		"Cache-Control": "private, max-age=300",
		"Content-Type": match[1].toLowerCase(),
		// An SVG can carry script: it is only ever read as bytes, never navigated to
		"Content-Security-Policy": "default-src 'none'; sandbox;",
		"X-Content-Type-Options": "nosniff",
	};
	if (request.headers.get("if-none-match") === etag)
		return new Response(null, { status: 304, headers });
	return new Response(bytes, { headers });
};
