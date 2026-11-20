import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { attachmentStreamResponse, openFile, statFile } from "$lib/server/files/downloadFile";
import { parseThumbSize, thumbnailResponse } from "$lib/server/files/thumbnail";

export const GET: RequestHandler = async ({ locals, params, request, url }) => {
	const sha256 = z.string().parse(params.sha256);

	const userId = locals.user?._id ?? locals.sessionId;

	// check user
	if (!userId) {
		error(401, "Unauthorized");
	}

	const thumb = parseThumbSize(url);
	const convId = new ObjectId(z.string().parse(params.id));

	// check if the user has access to the conversation
	const conv = await collections.conversations.findOne({
		_id: convId,
		...authCondition(locals),
	});

	if (!conv) {
		error(404, "Conversation not found");
	}

	// `?thumb=`: a small picture of an image, after the very same checks (`statFile` is `openFile`'s
	// lookup: a withheld or foreign file is refused here too).
	if (thumb !== null) {
		const file = await statFile(sha256, params.id);
		return thumbnailResponse({ sha256, size: thumb, mime: file.mime, request, read: file.read });
	}

	return attachmentStreamResponse(
		sha256,
		await openFile(sha256, params.id, request.headers.get("range"))
	);
};
