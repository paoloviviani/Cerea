/**
 * Workspace -> Agents: the connectors the user's OWN agents (goose Desktop, the goose CLI, an
 * editor extension, set up with `galopin goose setup`) may use through galopin's local MCP
 * endpoint (ADR 0110). `GET` answers `{ options, selected }`: Cerea's connectors the caller could
 * switch on and the current list (default none). `PUT { keys }` replaces it; an empty list clears
 * it. The caller's own list only, and each key must be a connector the resolver offers this
 * caller now, so another user's connector cannot be named. galopin fetches the allowed set over
 * its link (`connector.list` with source "local-agent").
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { requireCodeAgents } from "$lib/server/codeDevices";
import {
	getLocalAgentKeys,
	localAgentOptions,
	MAX_SESSION_CONNECTORS,
	SessionConnectorsError,
	setLocalAgentKeys,
} from "$lib/server/code/sessionConnectors";

async function caller(locals: App.Locals) {
	await requireCodeAgents(locals);
	const id = locals.user?._id;
	if (!id) error(401, "Login required");
	return id;
}

export const GET: RequestHandler = async ({ locals }) => {
	const userId = await caller(locals);
	const [options, selected] = await Promise.all([
		localAgentOptions(userId),
		getLocalAgentKeys(userId),
	]);
	return json({ options, selected });
};

const bodySchema = z.object({
	keys: z.array(z.string().min(1).max(300)).max(MAX_SESSION_CONNECTORS),
});

export const PUT: RequestHandler = async ({ locals, request }) => {
	const userId = await caller(locals);
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Expected { keys }.");
	try {
		const selected = await setLocalAgentKeys(userId, parsed.data.keys);
		return json({ selected });
	} catch (err) {
		if (err instanceof SessionConnectorsError) error(400, err.message);
		throw err;
	}
};
