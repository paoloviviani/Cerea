/**
 * Local connectors (ADR 0102): the machines this person has that serve MCP servers, with their
 * servers and states. Only the caller's own rows; another person's machine is never listed.
 * Approving and revoking a machine is `machines/[id]`; signing in to a server is `oauth/`.
 */

import { json, type RequestHandler } from "@sveltejs/kit";
import { localMachineViews, requireLocalConnectors } from "$lib/server/localConnectors";

export const GET: RequestHandler = async ({ locals }) => {
	const { userId } = requireLocalConnectors(locals);
	return json({ machines: await localMachineViews(userId) });
};
