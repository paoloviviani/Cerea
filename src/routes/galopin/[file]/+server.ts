/**
 * galopin's binaries, SHA256SUMS, version and installer, public (no session;
 * exempted by route id in `hooks/handle.ts`). See `galopinDist.ts`.
 */
import type { RequestHandler } from "@sveltejs/kit";
import { base } from "$app/paths";
import { OIDConfig } from "$lib/server/auth";
import { machineClientId } from "$lib/server/code/machineAuth";
import { config } from "$lib/server/config";
import { galopinOrigin, serveGalopinFile } from "$lib/server/galopinDist";

export const GET: RequestHandler = async ({ params, url, request }) => {
	const result = await serveGalopinFile(params.file ?? "", {
		origin: galopinOrigin(url.origin, base),
		issuer: OIDConfig.PROVIDER_URL,
		clientId: machineClientId(),
		// The same fallback the Pair dialog uses: the chat's own origin serves the gateway.
		gateway: config.CODE_GATEWAY_ORIGIN?.trim() || galopinOrigin(url.origin, ""),
		ifNoneMatch: request.headers.get("if-none-match"),
	});
	return new Response(result.body, { status: result.status, headers: result.headers });
};
