/**
 * The user's computers whose browser is ready (ADR 0116, C109), default first: what the composer's
 * "Open browser" menu lists. `conversationId` marks the one that chat already uses.
 * Only the caller's own computers. An empty list means the menu item is not shown.
 */
import { json, type RequestHandler } from "@sveltejs/kit";
import { readyComputers, requireBrowserUse } from "$lib/server/browser/gate";

export const GET: RequestHandler = async ({ locals, url }) => {
	const { userId } = requireBrowserUse(locals);
	const conversationId = url.searchParams.get("conversationId") ?? undefined;
	return json({ computers: await readyComputers(locals, userId, conversationId) });
};
