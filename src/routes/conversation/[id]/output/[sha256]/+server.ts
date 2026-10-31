import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { attachmentStreamResponse, openFile } from "$lib/server/files/downloadFile";

export const GET: RequestHandler = async ({ locals, params }) => {
	const sha256 = z.string().parse(params.sha256);

	const userId = locals.user?._id ?? locals.sessionId;

	// check user
	if (!userId) {
		error(401, "Unauthorized");
	}

	const convId = new ObjectId(z.string().parse(params.id));

	// check if the user has access to the conversation
	const conv = await collections.conversations.findOne({
		_id: convId,
		...authCondition(locals),
	});

	if (!conv) {
		error(404, "Conversation not found");
	}

	return attachmentStreamResponse(sha256, await openFile(sha256, params.id));
};
