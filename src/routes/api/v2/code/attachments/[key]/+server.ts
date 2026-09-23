/**
 * The `/code` surface's attachments for one session: storing what a person
 * sends with a message, and listing what a message was sent with.
 *
 * `[key]` is the owner key `code:<deviceId>:<sessionId>`
 * (`codeAttachments.ts`), URL-encoded as one path segment. The key is
 * authorized against the caller's paired device before anything is read or
 * written. Storage is chat's own (`files/attachmentStore.ts`): same bucket,
 * same writer, same limits, same once-at-upload document extraction.
 *
 * Nothing here knows about the agent transport: the surface uploads, keeps
 * the returned `MessageFile`s, sends its message with the same `messageId`,
 * and hands the files on to its agent however its backend does.
 */

import { error, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";

import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { authorizeCodeAttachmentKey } from "$lib/server/codeAttachments";
import { requireCodeAgents } from "$lib/server/codeDevices";
import { findAttachments, storeAttachment } from "$lib/server/files/attachmentStore";
import { AGENT_ATTACHMENT_MIME_ALLOWLIST, MAX_ATTACHMENT_BYTES } from "$lib/constants/mime";
import { mimeMatchesAllowlist } from "$lib/utils/mimeMatch";

/** Per request, not per message: a surface that sends more uploads twice. */
const MAX_FILES_PER_UPLOAD = 10;

const messageIdSchema = z.string().regex(/^[A-Za-z0-9_.:~-]{1,128}$/, "Not a valid message id.");

const uploadSchema = z.object({
	messageId: messageIdSchema,
	files: z
		.array(
			z
				.instanceof(File)
				.refine((file) => file.size > 0, "An attachment is empty.")
				// The declared type, as chat's composer checks it. The stored
				// type is sniffed from the bytes (`writeAttachment`), and serving
				// is download-only, so a mislabelled file cannot render as
				// something else either way.
				.refine(
					(file) => mimeMatchesAllowlist(file.type, AGENT_ATTACHMENT_MIME_ALLOWLIST),
					"That file type cannot be attached."
				)
		)
		.min(1, "No files to attach.")
		.max(MAX_FILES_PER_UPLOAD, `At most ${MAX_FILES_PER_UPLOAD} files per upload.`),
});

export const POST: RequestHandler = async ({ locals, params, request }) => {
	requireCodeAgents(locals);
	const key = params.key ?? "";
	await authorizeCodeAttachmentKey(locals, key);

	const form = await request.formData().catch(() => error(400, "Expected a multipart form."));
	const entries = form.getAll("files");
	// Chat's limit and chat's status (`conversation/[id]`), checked before the
	// schema so it keeps its own status code.
	if (entries.some((entry) => entry instanceof File && entry.size > MAX_ATTACHMENT_BYTES)) {
		error(413, `File too large, should be <${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`);
	}
	const parsed = uploadSchema.safeParse({ messageId: form.get("messageId"), files: entries });
	if (!parsed.success) error(400, parsed.error.issues[0]?.message ?? "Invalid upload.");

	// Sequential, not parallel: a document's extraction is a gateway call
	// billed to the caller, and ten at once is a burst nobody asked for.
	const files = [];
	for (const file of parsed.data.files) {
		files.push(await storeAttachment(file, key, parsed.data.messageId, locals.token));
	}
	return superjsonResponse({ files });
};

export const GET: RequestHandler = async ({ locals, params, url }) => {
	requireCodeAgents(locals);
	const key = params.key ?? "";
	await authorizeCodeAttachmentKey(locals, key);

	const messageId = messageIdSchema.safeParse(url.searchParams.get("messageId"));
	if (!messageId.success) error(400, "A messageId is required.");
	return superjsonResponse({ files: await findAttachments(key, messageId.data) });
};
