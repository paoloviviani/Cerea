/**
 * A connect ticket for the window browser socket (ADR 0122): `POST {windowId}` from the Cerea
 * page running inside the desktop app. Minted here, through the ordinary hooks (session, the
 * content-type rule), because the WebSocket upgrade itself never passes through them. The
 * ticket is single use, lasts 30 seconds and is bound to this user, this session and this id, and
 * carries the window's grant key, derived from the session secret (`windowGrantKey`).
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { requireBrowserUse } from "$lib/server/browser/gate";
import { config } from "$lib/server/config";
import { WINDOW_ID_PATTERN, windowGrantKey } from "$lib/server/browser/windowRegistry";
import { mintWindowTicket, windowTicketAllowed } from "$lib/server/browser/windowTickets";

const bodySchema = z.object({ windowId: z.string().regex(WINDOW_ID_PATTERN) });

export const POST: RequestHandler = async ({ locals, request, cookies }) => {
	const { userId } = requireBrowserUse(locals);
	if (!locals.sessionId) error(401, "Login required");
	if (!windowTicketAllowed(userId.toString())) error(429, "Too many requests.");
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Invalid request");
	// The session secret is the cookie's value (the database keeps only its hash). It is HttpOnly,
	// so the page cannot read it; the app's main process can, and derives the same grant key.
	const secret = cookies.get(config.COOKIE_NAME);
	if (!secret) error(401, "Login required");
	return json({
		ticket: mintWindowTicket({
			userId: userId.toString(),
			sessionId: locals.sessionId,
			windowId: parsed.data.windowId,
			key: windowGrantKey(secret, parsed.data.windowId),
		}),
	});
};
