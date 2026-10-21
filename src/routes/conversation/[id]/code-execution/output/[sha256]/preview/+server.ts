import type { RequestHandler } from "./$types";
import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { downloadDeliverable } from "$lib/server/execution/deliverables";
import { officeFileName } from "$lib/server/office/gotenberg";
import { previewOwner } from "$lib/server/office/previewStore";
import { previewResponse } from "$lib/server/office/previewResponse";
import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";

/**
 * The PDF preview of a produced Office file (`output/[sha256]` serves the file
 * itself), with that route's access check. Produced files are converted when
 * they are stored, so this is normally a read of what is already there; a file
 * stored before the converter was switched on is converted on this first view.
 */
export const GET: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user && !locals.sessionId) error(401, "Unauthorized");
	if (!ObjectId.isValid(params.id)) error(404, "Conversation not found");
	const conversationId = new ObjectId(params.id);
	const sha256 = z.string().parse(params.sha256);

	const conversation = await collections.conversations.findOne(
		{ _id: conversationId, ...authCondition(locals) },
		{ projection: { _id: 1 } }
	);
	if (!conversation) error(404, "Conversation not found");

	const file = await downloadDeliverable(conversationId, sha256);
	if (!file) error(404, "File not found");
	const name = officeFileName(file.mime, file.name);
	if (!name) error(415, "This file is not an Office document.");

	return previewResponse({
		bytes: file.buffer,
		name,
		owner: previewOwner("out", conversationId.toString(), sha256),
		signal: request.signal,
	});
};
