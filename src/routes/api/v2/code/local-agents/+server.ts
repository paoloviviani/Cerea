/**
 * Workspace -> Agents: the user's ONE list of connectors their agents may use. `GET` answers
 * `{ options, computers, selected, appsToo }`: Cerea's connectors and each paired computer's own
 * servers the caller could list, the list itself (default none), and the "apps on my computers
 * may use these too" switch (default on). `PUT { keys?, appsToo? }` changes either; an empty
 * `keys` clears the list. The caller's own list only, and each key must be one the resolver (or
 * the caller's own paired computer) offers now, so another user's connector cannot be named.
 * Coding sessions inherit the list and may narrow it per session; galopin fetches it for apps on
 * the user's computers over its link (`connector.list` with source "local-agent").
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { requireCodeAgents } from "$lib/server/codeDevices";
import {
	getUserList,
	listChoices,
	MAX_SESSION_CONNECTORS,
	SessionConnectorsError,
	setUserList,
} from "$lib/server/code/sessionConnectors";

async function caller(locals: App.Locals) {
	await requireCodeAgents(locals);
	const id = locals.user?._id;
	if (!id) error(401, "Login required");
	return id;
}

export const GET: RequestHandler = async ({ locals }) => {
	const userId = await caller(locals);
	const [choices, list] = await Promise.all([listChoices(userId), getUserList(userId)]);
	return json({ ...choices, selected: list.keys, appsToo: list.appsToo });
};

const bodySchema = z
	.object({
		keys: z.array(z.string().min(1).max(300)).max(MAX_SESSION_CONNECTORS).optional(),
		appsToo: z.boolean().optional(),
	})
	.refine((b) => b.keys !== undefined || b.appsToo !== undefined);

export const PUT: RequestHandler = async ({ locals, request }) => {
	const userId = await caller(locals);
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Expected { keys } or { appsToo }.");
	try {
		const list = await setUserList(userId, parsed.data);
		return json({ selected: list.keys, appsToo: list.appsToo });
	} catch (err) {
		if (err instanceof SessionConnectorsError) error(400, err.message);
		throw err;
	}
};
