/**
 * What a link lets a visitor download (ADR 0120): the snapshot's own file and
 * nothing else. The name must equal the snapshot's, so no path, however it is
 * spelled, reaches anything but that. Always an attachment, never sniffed, and
 * as a type browsers will not run.
 */
import type { RequestHandler } from "./$types";
import { Readable } from "node:stream";
import { collections } from "$lib/server/database";
import { isBlobNotFound } from "$lib/server/blobs/types";
import { findActiveShare } from "$lib/server/sharing/shares";
import { accessFor, notAvailable } from "$lib/server/sharing/serve";
import { attachmentHeaders, downloadName } from "$lib/server/sharing/pages";

export const GET: RequestHandler = async (event) => {
	const { token, name } = event.params;
	const locale = event.locals.locale ?? "en";
	const share = await findActiveShare(token);
	if (!share || name !== downloadName(share)) return notAvailable(locale);

	if (accessFor(event, share) !== "ok") return notAvailable(locale);

	const snapshot = share.snapshot;
	if (snapshot.kind === "text") {
		const bytes = Buffer.from(snapshot.content, "utf8");
		return new Response(bytes, { headers: attachmentHeaders(name, "text/plain", bytes.length) });
	}

	const row = await collections.codeExecutionOutputs.findOne({
		conversationId: share.conversationId,
		sha256: snapshot.sha256,
		name: snapshot.name,
	});
	if (!row || row.withheld) return notAvailable(locale);
	try {
		const stream = await collections.blobStore.open("codeOutputs", row.gridFsId);
		return new Response(Readable.toWeb(stream) as ReadableStream, {
			headers: attachmentHeaders(snapshot.name, snapshot.mime, row.size),
		});
	} catch (err) {
		if (isBlobNotFound(err)) return notAvailable(locale);
		throw err;
	}
};
