import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import type { Conversation } from "$lib/types/Conversation";
import { CONV_NUM_PER_PAGE } from "$lib/constants/pagination";
import { deleteConversationStorage } from "$lib/server/conversationStorage";
import { titleSearchPattern } from "$lib/server/titleSearch";

export const GET: RequestHandler = async ({ locals, url }) => {
	requireAuth(locals);

	const pageSize = CONV_NUM_PER_PAGE;
	const p = parseInt(url.searchParams.get("p") ?? "0") || 0;

	// `q` narrows the same list by title, for the /chats page: the caller's own
	// conversations only (the filter below is the list's own), project chats
	// included, newest first, paged as before. Case and accents are ignored; see
	// `titleSearchPattern`, which also escapes the input and caps its length.
	const pattern = titleSearchPattern(url.searchParams.get("q") ?? "");
	const filter = pattern
		? { ...authCondition(locals), title: { $regex: pattern } }
		: authCondition(locals);

	const convs = await collections.conversations
		.find(filter)
		.project<
			Pick<Conversation, "_id" | "title" | "updatedAt" | "model" | "mlAssistant" | "projectId">
		>({
			title: 1,
			updatedAt: 1,
			model: 1,
			mlAssistant: 1,
			projectId: 1,
		})
		.sort({ updatedAt: -1 })
		.skip(p * pageSize)
		.limit(pageSize + 1)
		.toArray();

	const hasMore = convs.length > pageSize;
	const res = (hasMore ? convs.slice(0, pageSize) : convs).map((conv) => ({
		_id: conv._id,
		id: conv._id, // legacy param iOS
		title: conv.title,
		updatedAt: conv.updatedAt,
		model: conv.model,
		modelId: conv.model, // legacy param iOS
		...(conv.mlAssistant ? { mlAssistant: true } : {}),
		// A string, not an ObjectId: the sidebar compares it against ids the
		// projects API returns, and those are strings.
		...(conv.projectId ? { projectId: conv.projectId.toString() } : {}),
	}));

	return superjsonResponse({ conversations: res, hasMore });
};

export const DELETE: RequestHandler = async ({ locals }) => {
	requireAuth(locals);

	// Every conversation of the caller's, project chats included, as the v1
	// route has always done: "delete all" that left some behind, attachments
	// and indexed transcripts with them, would not mean what it says. The
	// dialog says so (`DeleteAllConversationsModal`).
	const filter = { ...authCondition(locals) };
	const ids = await collections.conversations
		.find(filter)
		.project<{ _id: Conversation["_id"] }>({ _id: 1 })
		.toArray();
	const res = await collections.conversations.deleteMany(filter);
	await deleteConversationStorage(ids.map((c) => c._id));

	return superjsonResponse(res.deletedCount);
};
