/**
 * A chat's own notes: list them, add one.
 *
 * Access is the conversation's own (`resolveConversation`: the owner, or the
 * anonymous session that made it), so a chat that is not yours answers like a
 * missing one. The deployment flag (`CHAT_MEMORY_ENABLED`) is re-checked here
 * rather than trusted from the UI hiding the control.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireUser } from "$lib/server/api/utils/requireAuth";
import { resolveConversation } from "$lib/server/api/utils/resolveConversation";
import { memoryEnabled } from "$lib/server/memoryEnabled";
import {
	conversationMemoryViews,
	MemoryValidationError,
	rememberForConversation,
} from "$lib/server/memory/service";
import { CONVERSATION_MEMORY_TEXT_MAX_CHARS } from "$lib/types/ScopedMemory";

const create = z.object({ text: z.string().trim().min(1).max(CONVERSATION_MEMORY_TEXT_MAX_CHARS) });

async function ownChat(locals: App.Locals, id: string | undefined) {
	if (!memoryEnabled()) error(404, "Memory is not turned on here.");
	requireUser(locals);
	const conversation = await resolveConversation(id ?? "", locals);
	return new ObjectId(conversation._id);
}

export const GET: RequestHandler = async ({ locals, params }) => {
	const conversationId = await ownChat(locals, params.id);
	return json({ data: { notes: await conversationMemoryViews(conversationId) } });
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const conversationId = await ownChat(locals, params.id);
	const parsed = create.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, parsed.error.issues[0]?.message ?? "That note is not valid.");
	try {
		// `source: "user"` regardless of caller: this route is the Notes list,
		// and the tool writes through the service directly.
		const { memory } = await rememberForConversation({
			conversationId,
			...(locals.user ? { ownerUserId: locals.user._id } : {}),
			text: parsed.data.text,
			source: "user",
		});
		const view = (await conversationMemoryViews(conversationId)).find(
			(note) => note.id === memory._id.toString()
		);
		return json({ data: view }, { status: 201 });
	} catch (err) {
		if (err instanceof MemoryValidationError) error(400, err.message);
		throw err;
	}
};
