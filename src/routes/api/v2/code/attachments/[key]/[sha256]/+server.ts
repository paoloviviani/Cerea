/**
 * One stored attachment's bytes, for a `/code` session — what
 * `UploadedFile`'s `fileBaseUrl` points at, so an image a person sent still
 * renders after a reload.
 *
 * The key is authorized against the caller's paired device first; then
 * `downloadFile` checks the entry's owner tag against the key, exactly as
 * chat's `conversation/[id]/output/[sha256]` does. Download, never render:
 * the same `attachmentResponse` headers as chat.
 */

import { error, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";

import { authorizeCodeAttachmentKey } from "$lib/server/codeAttachments";
import { requireCodeAgents } from "$lib/server/codeDevices";
import { readAttachment } from "$lib/server/files/attachmentStore";
import { attachmentResponse } from "$lib/server/files/downloadFile";

export const GET: RequestHandler = async ({ locals, params }) => {
	requireCodeAgents(locals);
	const sha256 = z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.safeParse(params.sha256);
	if (!sha256.success) error(400, "Not a valid attachment hash.");
	const key = params.key ?? "";
	await authorizeCodeAttachmentKey(locals, key);

	return attachmentResponse(sha256.data, await readAttachment(sha256.data, key));
};
