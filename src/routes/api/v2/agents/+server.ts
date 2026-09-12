/**
 * Agents: the collection, chat-side (ADR 0067).
 *
 * `GET` lists the signed-in person's own — there is no "shared with me",
 * because agents belong to the user. `POST` creates one, fully configured;
 * the knowledge-base ids are stored as sent and re-checked at retrieval time,
 * for the same reason the projects route does not validate them: the answer
 * that matters is the one at read time, against the reader's own token.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { create, listForUser, wireName } from "$lib/server/agents";

const createSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1)
		.max(128)
		// The name becomes the picker's id after the `agent:` prefix, so it
		// travels through model-id-shaped code paths: no whitespace, no colon.
		.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "letters, digits, dots, dashes and underscores"),
	description: z.string().trim().max(500).default(""),
	model: z.string().trim().min(1).max(255),
	system_prompt: z.string().max(20_000).default(""),
	knowledgeBaseIds: z.array(z.string().min(1)).max(20).default([]),
	retrievalLimit: z.number().int().min(1).max(20).default(6),
	retrievalMinScore: z.number().min(0).max(1).default(0),
});

function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

export const GET: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	const agents = await listForUser(user._id);
	return json({
		data: agents.map((agent) => ({
			_id: agent._id,
			name: agent.name,
			description: agent.description ?? "",
			model: agent.model,
			system_prompt: agent.system_prompt,
			knowledgeBaseIds: agent.knowledgeBaseIds,
			retrievalLimit: agent.retrievalLimit,
			retrievalMinScore: agent.retrievalMinScore,
			wire_name: wireName(agent),
			updatedAt: agent.updatedAt,
		})),
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = createSchema.safeParse(await request.json());
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "Invalid agent.");
	}
	if ((await collections.agents.countDocuments({ userId: user._id, name: parsed.data.name })) > 0) {
		error(409, `You already have an agent named "${parsed.data.name}".`);
	}
	const agent = await create(user._id, parsed.data);
	return json({ id: agent._id, wire_name: wireName(agent) }, { status: 201 });
};
