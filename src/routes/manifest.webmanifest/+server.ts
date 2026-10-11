/**
 * The web app manifest (why it is a route and not a static file:
 * `$lib/server/manifest.ts`). Served with no session, exactly as the static
 * file it replaces was: the login wall exempts this route id, because an
 * install prompt — and the analyzers that score one — resolve the manifest
 * before anyone has signed in.
 */
import { base } from "$app/paths";
import { config } from "$lib/server/config";
import { codeAgentsEnabled } from "$lib/server/codeEnabled";
import { buildWebAppManifest } from "$lib/server/manifest";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => {
	const manifest = buildWebAppManifest({
		appName: config.PUBLIC_APP_NAME || "Cerea",
		basePath: base,
		assetDir: config.PUBLIC_APP_ASSETS || "chatui",
		agentsEnabled: codeAgentsEnabled(),
	});

	return new Response(JSON.stringify(manifest), {
		headers: {
			"Content-Type": "application/manifest+json",
			"Cache-Control": "public, max-age=3600",
		},
	});
};
