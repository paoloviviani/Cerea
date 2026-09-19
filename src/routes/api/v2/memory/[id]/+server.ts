/**
 * One memory: rewrite it, or delete it.
 *
 * Owner-only, and a row belonging to somebody else answers 404 rather than
 * 403 — the same choice the skills routes make. A 403 would confirm the id
 * exists, and these ids are guessable enough that confirming existence is a
 * disclosure in its own right.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { memoryEnabled } from "$lib/server/memoryEnabled";
import {
	deleteMemory,
	memoryView,
	MemoryValidationError,
	updateMemory,
	MEMORY_TEXT_MAX_CHARS,
} from "$lib/server/memory/service";

const patch = z.object({
	text: z.string().trim().min(1).max(MEMORY_TEXT_MAX_CHARS),
});

function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

function memoryId(params: { id?: string }): ObjectId {
	if (!params.id || !ObjectId.isValid(params.id)) error(404, "No such memory.");
	return new ObjectId(params.id);
}

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!memoryEnabled()) error(404, "Memory is not enabled in this deployment.");
	const user = requireUser(locals);
	const parsed = patch.safeParse(await request.json());
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "That change is not valid.");
	}
	try {
		const updated = await updateMemory(user._id, memoryId(params), parsed.data.text);
		return json({ data: memoryView(updated) });
	} catch (err) {
		if (err instanceof MemoryValidationError) {
			error(err.message === "No such memory." ? 404 : 400, err.message);
		}
		throw err;
	}
};

/**
 * Deleting is allowed even when the deployment flag is off, which is the one
 * place this route set departs from the others.
 *
 * An operator turning `CHAT_MEMORY_ENABLED` off must not strand what people
 * have already stored behind a 404 — that turns a feature switch into a
 * "your data exists and you cannot reach it" state. Reading and writing stop;
 * getting rid of it does not.
 */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	if (!(await deleteMemory(user._id, memoryId(params)))) error(404, "No such memory.");
	return new Response(null, { status: 204 });
};
