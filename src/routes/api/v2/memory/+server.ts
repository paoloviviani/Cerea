/**
 * User memory: what this person has remembered, and adding to it.
 *
 * Owner-only with no sharing and no administrator path — unlike skills, where
 * a deployment scope exists, there is deliberately no way for anybody but the
 * owner to read or write these rows. A standing fact about a person is the
 * most personal thing this application stores, and "I administer this
 * deployment" is not "I may read what you told the assistant about yourself".
 *
 * Both gates are re-checked here rather than trusted from the UI: the
 * deployment flag, and (on writes) the person's own opt-in. The tab hiding is
 * a convenience, never the enforcement.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { memoryEnabled } from "$lib/server/memoryEnabled";
import {
	listMemories,
	memoryView,
	MemoryValidationError,
	rememberFact,
	MEMORY_TEXT_MAX_CHARS,
} from "$lib/server/memory/service";
import { z } from "zod";

const create = z.object({
	text: z.string().trim().min(1).max(MEMORY_TEXT_MAX_CHARS),
});

/**
 * Memory belongs to a **user**, never a session.
 *
 * Every other per-person store in this app accepts an anonymous session
 * through `authCondition`, and memory deliberately does not: the point of a
 * standing fact is that it outlives the conversation, and a fact attached to
 * a cookie that expires is a promise the store cannot keep.
 */
function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

function requireFeature() {
	if (!memoryEnabled()) error(404, "Memory is not enabled in this deployment.");
}

/**
 * The switch lives on this screen, so the list request is what reports its
 * state — one round trip for "is it on and what is in it", which is exactly
 * what the tab needs to draw itself.
 */
export const GET: RequestHandler = async ({ locals }) => {
	requireFeature();
	const user = requireUser(locals);
	const [memories, settings] = await Promise.all([
		listMemories(user._id),
		collections.settings.findOne(authCondition(locals)),
	]);
	return json({
		data: {
			memories: memories.map(memoryView),
			enabled: settings?.memoryEnabled === true,
		},
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireFeature();
	const user = requireUser(locals);
	const parsed = create.safeParse(await request.json());
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "That memory is not valid.");
	}
	try {
		// `source: "user"` regardless of who is calling: this route is the
		// screen, and the tool writes through the service directly. A client
		// that could name its own provenance could label a guess as something
		// the person said.
		const { memory } = await rememberFact({
			userId: user._id,
			text: parsed.data.text,
			source: "user",
		});
		return json({ data: memoryView(memory) }, { status: 201 });
	} catch (err) {
		if (err instanceof MemoryValidationError) error(400, err.message);
		throw err;
	}
};
