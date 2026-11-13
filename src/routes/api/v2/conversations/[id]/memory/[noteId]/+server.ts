/**
 * One chat note: rewrite it, or delete it. A note id is matched together with
 * the conversation id, so an id from another chat is a 404 here.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { resolveConversation } from "$lib/server/api/utils/resolveConversation";
import { memoryEnabled } from "$lib/server/memoryEnabled";
import {
	conversationMemoryViews,
	deleteConversationMemory,
	MemoryValidationError,
	updateConversationMemory,
} from "$lib/server/memory/service";
import { CONVERSATION_MEMORY_TEXT_MAX_CHARS } from "$lib/types/ScopedMemory";

const patch = z.object({ text: z.string().trim().min(1).max(CONVERSATION_MEMORY_TEXT_MAX_CHARS) });

async function ownChat(locals: App.Locals, id: string | undefined) {
	requireAuth(locals);
	const conversation = await resolveConversation(id ?? "", locals);
	return new ObjectId(conversation._id);
}

function noteId(params: { noteId?: string }): ObjectId {
	if (!params.noteId || !ObjectId.isValid(params.noteId)) error(404, "No such note.");
	return new ObjectId(params.noteId);
}

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!memoryEnabled()) error(404, "Memory is not turned on here.");
	const conversationId = await ownChat(locals, params.id);
	const parsed = patch.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, parsed.error.issues[0]?.message ?? "That change is not valid.");
	try {
		const updated = await updateConversationMemory(
			conversationId,
			noteId(params),
			parsed.data.text
		);
		const view = (await conversationMemoryViews(conversationId)).find(
			(note) => note.id === updated._id.toString()
		);
		return json({ data: view });
	} catch (err) {
		if (err instanceof MemoryValidationError) {
			error(err.message === "No such note." ? 404 : 400, err.message);
		}
		throw err;
	}
};

/** Allowed with the flag off too: an operator switching memory off must not strand what a chat holds. */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	const conversationId = await ownChat(locals, params.id);
	if (!(await deleteConversationMemory(conversationId, noteId(params))))
		error(404, "No such note.");
	return new Response(null, { status: 204 });
};
