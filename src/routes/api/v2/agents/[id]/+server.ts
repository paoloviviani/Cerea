/**
 * One agent, chat-side (ADR 0067): edit and delete, owner only.
 *
 * There is no share route and no access check beyond ownership, because there
 * is nothing to share and nobody to check: an agent belongs to the person who
 * made it, and `userId` in the query is the whole of the ACL.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { AgentNameTaken, remove, update } from "$lib/server/agents";

const patch = z.object({
	name: z
		.string()
		.trim()
		.min(1)
		.max(128)
		.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
		.optional(),
	description: z.string().trim().max(500).optional(),
	model: z.string().trim().min(1).max(255).optional(),
	system_prompt: z.string().max(20_000).optional(),
	knowledgeBaseIds: z.array(z.string().min(1)).max(20).optional(),
	retrievalLimit: z.number().int().min(1).max(20).optional(),
	retrievalMinScore: z.number().min(0).max(1).optional(),
});

function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

function ownId(id: string): ObjectId {
	if (!ObjectId.isValid(id)) error(404, "No such agent");
	return new ObjectId(id);
}

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const parsed = patch.safeParse(await request.json());
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "Invalid agent.");
	}
	try {
		const agent = await update(user._id, ownId(params.id ?? ""), parsed.data);
		if (!agent) error(404, "No such agent");
		return json({ ok: true });
	} catch (err) {
		if (err instanceof AgentNameTaken) error(409, err.message);
		throw err;
	}
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const deleted = await remove(user._id, ownId(params.id ?? ""));
	if (!deleted) error(404, "No such agent");
	return json({ ok: true });
};
