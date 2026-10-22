import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { downloadFile } from "$lib/server/files/downloadFile";
import { officeFileName } from "$lib/server/office/gotenberg";
import { previewOwner } from "$lib/server/office/previewStore";
import { previewResponse } from "$lib/server/office/previewResponse";

/**
 * The PDF preview of an Office attachment (`output/[sha256]` serves the file
 * itself). Access is the same as the file's: the conversation
 * must be the caller's, and the file must belong to it. The PDF is made on
 * the first request and kept (`office/previewStore.ts`).
 */
export const GET: RequestHandler = async ({ locals, params, url, request }) => {
	const sha256 = z.string().parse(params.sha256);
	if (!(locals.user?._id ?? locals.sessionId)) error(401, "Unauthorized");

	if (!ObjectId.isValid(params.id)) error(404, "Conversation not found");
	const conv = await collections.conversations.findOne(
		{ _id: new ObjectId(params.id), ...authCondition(locals) },
		{ projection: { _id: 1 } }
	);
	if (!conv) error(404, "Conversation not found");

	const file = await downloadFile(sha256, params.id);
	const name = officeFileName(file.mime, url.searchParams.get("name") ?? undefined);
	if (!name) error(415, "This file is not an Office document.");

	return previewResponse({
		bytes: Buffer.from(file.value, "base64"),
		name,
		owner: previewOwner("att", params.id, sha256),
		signal: request.signal,
	});
};
