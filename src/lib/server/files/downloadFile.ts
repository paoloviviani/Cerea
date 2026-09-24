import { error } from "@sveltejs/kit";
import mimeTypes from "mime-types";
import { collections } from "$lib/server/database";
import type { Conversation } from "$lib/types/Conversation";
import type { SharedConversation } from "$lib/types/SharedConversation";
import type { MessageFile } from "$lib/types/Message";

export async function downloadFile(
	sha256: string,
	convId: Conversation["_id"] | SharedConversation["_id"]
): Promise<MessageFile & { type: "base64" }> {
	const fileId = collections.bucket.find({ filename: `${convId.toString()}-${sha256}` });

	const file = await fileId.next();
	if (!file) {
		error(404, "File not found");
	}
	if (file.metadata?.conversation !== convId.toString()) {
		error(403, "You don't have access to this file.");
	}

	const mime = file.metadata?.mime;
	const name = file.filename;

	const fileStream = collections.bucket.openDownloadStream(file._id);

	const buffer = await new Promise<Buffer>((resolve, reject) => {
		const chunks: Uint8Array[] = [];
		fileStream.on("data", (chunk) => chunks.push(chunk));
		fileStream.on("error", reject);
		fileStream.on("end", () => resolve(Buffer.concat(chunks)));
	});

	return { type: "base64", name, value: buffer.toString("base64"), mime };
}

/**
 * "Download, never render": the response every stored-attachment route
 * answers with. An `<img>` still displays it (it ignores the disposition);
 * navigating to it saves a file instead of running whatever the bytes are,
 * and the sandbox CSP holds even if a browser renders it anyway.
 */
export function attachmentResponse(
	sha256: string,
	file: { value: string; mime?: string }
): Response {
	const { value, mime } = file;
	const b64Value = Buffer.from(value, "base64");
	return new Response(b64Value, {
		headers: {
			"Content-Type": mime ?? "application/octet-stream",
			"Content-Security-Policy":
				"default-src 'none'; script-src 'none'; style-src 'none'; sandbox;",
			"Content-Disposition": `attachment; filename="${sha256.slice(0, 8)}.${
				mime ? mimeTypes.extension(mime) || "bin" : "bin"
			}"`,
			"Content-Length": b64Value.length.toString(),
			"Accept-Range": "bytes",
		},
	});
}
