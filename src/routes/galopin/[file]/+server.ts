/**
 * galopin's binaries, SHA256SUMS, version and installer, public (no session;
 * exempted by route id in `hooks/handle.ts`). See `galopinDist.ts`.
 */
import type { RequestHandler } from "@sveltejs/kit";
import { base } from "$app/paths";
import { galopinOrigin, serveGalopinFile } from "$lib/server/galopinDist";

export const GET: RequestHandler = async ({ params, url, request }) => {
	const result = await serveGalopinFile(params.file ?? "", {
		origin: galopinOrigin(url.origin, base),
		ifNoneMatch: request.headers.get("if-none-match"),
	});
	return new Response(result.body, { status: result.status, headers: result.headers });
};
