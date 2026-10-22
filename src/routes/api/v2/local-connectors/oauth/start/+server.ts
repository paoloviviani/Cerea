/**
 * Start a local http connector's OAuth sign-in from the chat (ADR 0102, PROTOCOL.md §10.5).
 * Asks the person's machine for the authorization URL (it keeps the verifier and, later, the
 * tokens) and remembers who asked; the browser is then sent to the returned address.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { requireLocalConnectors } from "$lib/server/localConnectors";
import { LocalOauthError, startLocalSignIn } from "$lib/server/mcp/localOauth";

const body = z.object({
	connectorId: z.string().min(1).max(200),
	next: z.string().max(2000).optional(),
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const { userId } = requireLocalConnectors(locals);
	if (!locals.sessionId) error(401, "Login required");
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Expected { connectorId }.");
	try {
		return json(
			await startLocalSignIn({
				userId,
				sessionId: locals.sessionId,
				connectorId: parsed.data.connectorId,
				next: parsed.data.next,
			})
		);
	} catch (err) {
		if (err instanceof LocalOauthError) error(err.status, err.message);
		throw err;
	}
};
