import { base } from "$app/paths";
import { error, json } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { attachmentDisposition } from "$lib/server/files/contentDisposition";
import { openWithheldFile } from "$lib/server/files/downloadFile";
import {
	assertGestureRequest,
	consumeWithheldDownloadToken,
	mintWithheldDownloadToken,
} from "$lib/server/files/withheldDownloadToken";
import { Readable } from "node:stream";

/**
 * The owner saving their own privacy-withheld file, after a click (C99c). See
 * `withheldDownloadToken.ts` for why this is two steps and what makes it
 * unreachable from tools, MCP and the code sandbox.
 */

async function ownedConversation(params: { id: string }, locals: App.Locals) {
	const owner = locals.user?._id?.toString() ?? locals.sessionId;
	if (!owner) error(401, "Unauthorized");
	if (!ObjectId.isValid(params.id)) error(404, "Conversation not found");
	const _id = new ObjectId(params.id);
	const conversation = await collections.conversations.findOne(
		{ _id, ...authCondition(locals) },
		{ projection: { messages: 1 } }
	);
	if (!conversation) error(404, "Conversation not found");
	return { owner, _id, conversation };
}

/** The `MessageFile` record of a withheld file in this conversation, if there is one. */
function withheldRecord(
	messages: { files?: { type: string; value: string; name: string; withheld?: unknown }[] }[],
	sha256: string
) {
	for (const message of messages) {
		for (const file of message.files ?? []) {
			if (file.type === "hash" && file.value === sha256 && file.withheld) return file;
		}
	}
	return undefined;
}

/** Mint a one-time token: `{ sha256 }` in, `{ url }` out. */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	assertGestureRequest(request);
	const { owner, _id, conversation } = await ownedConversation(params, locals);
	const body = z
		.object({ sha256: z.string().min(1).max(128) })
		.safeParse(await request.json().catch(() => null));
	if (!body.success) error(400, "Bad request");
	if (!withheldRecord(conversation.messages, body.data.sha256)) error(404, "File not found");
	const token = await mintWithheldDownloadToken({
		owner,
		conversationId: _id,
		sha256: body.data.sha256,
	});
	return json(
		{
			url: `${base}/conversation/${_id.toString()}/withheld-download?token=${encodeURIComponent(token)}`,
			expiresInSeconds: 60,
		},
		{ headers: { "Cache-Control": "no-store" } }
	);
};

/** Serve the bytes, once, for a valid token. */
export const GET: RequestHandler = async ({ params, locals, request, url }) => {
	// A navigation or a fetch, never an embed (<iframe>, <img>, <script>, <object>...).
	const dest = request.headers.get("sec-fetch-dest");
	if (dest !== null && dest !== "document" && dest !== "empty") {
		error(403, "This download must be opened as a page.");
	}
	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") {
		error(403, "This download must be started from this page.");
	}
	const { owner, _id, conversation } = await ownedConversation(params, locals);
	const { sha256 } = await consumeWithheldDownloadToken(url.searchParams.get("token"), {
		owner,
		conversationId: _id,
	});
	const record = withheldRecord(conversation.messages, sha256);
	if (!record) error(404, "File not found");
	const file = await openWithheldFile(sha256, _id);
	return new Response(Readable.toWeb(file.stream) as ReadableStream, {
		headers: {
			"Content-Type": file.mime || "application/octet-stream",
			"Content-Security-Policy":
				"default-src 'none'; script-src 'none'; style-src 'none'; sandbox;",
			"X-Content-Type-Options": "nosniff",
			"Content-Disposition": attachmentDisposition(record.name),
			"Content-Length": file.length.toString(),
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
		},
	});
};
