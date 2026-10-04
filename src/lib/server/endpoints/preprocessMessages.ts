import type { Message, MessageFile } from "$lib/types/Message";
import type { EndpointMessage } from "./endpoints";
import { downloadFile } from "../files/downloadFile";
import { documentMime, isExtractableDocument } from "../files/extractDocument";
import { missingTextNotice } from "../files/missingTextNotice";
import { scanNotice, wordScanMarkers } from "../files/scanNotice";
import type { ObjectId } from "mongodb";

export async function preprocessMessages(
	messages: Message[],
	convId: ObjectId,
	/** The turn's model reads images (`modelReadsImages`); decides what a scanned PDF becomes. */
	canReadImages = false
): Promise<EndpointMessage[]> {
	return Promise.resolve(messages)
		.then((msgs) => downloadFiles(msgs, convId, canReadImages))
		.then((msgs) => injectClipboardFiles(msgs))
		.then(stripEmptyInitialSystemMessage);
}

/**
 * One stored attachment, as the model should see it.
 *
 * A document — a PDF, a `.docx` — is bytes no model reads, so what goes into
 * the prompt is the text the gateway's extractor read out of it at upload
 * time, fetched by the hash on `extracted` and handed over as
 * `text/markdown`. The existing text path in `prepareFiles` then inlines it
 * under the document's own name, so nothing downstream needs to know that
 * extraction happened.
 *
 * When there is no text — no reader configured, a scan with no text layer,
 * an extractor that refused — the model gets **a sentence saying so, and which
 * of those it was** (`missingTextNotice`), in place of the document. That is the whole reason this is not simply a filter: an
 * attachment dropped silently makes the assistant answer as though nothing was
 * attached, and the person watching it sees their file in the transcript and
 * an answer that ignores it.
 */
async function resolveFile(
	file: Message["files"] extends (infer F)[] | undefined ? F : never,
	convId: ObjectId,
	canReadImages: boolean
) {
	if (file.pageImages && file.extracted) {
		return resolveWithPages(file, file.extracted, file.pageImages, convId, canReadImages);
	}
	return [await resolveOne(file, convId)];
}

/**
 * A PDF with pages that were pictures, read at upload: the page-ordered text,
 * worded for this turn's model, and — only for one that reads images — the
 * pages themselves, in page order, as the same files an uploaded image is, so
 * they take the same route through `prepareFiles` (resizing, limits). Judged
 * per turn, not at upload: switch to a model that cannot read images and the
 * pages stay stored but are not sent, and the text says so; switch back and
 * they are sent again.
 */
async function resolveWithPages(
	file: MessageFile,
	extracted: NonNullable<MessageFile["extracted"]>,
	scan: NonNullable<MessageFile["pageImages"]>,
	convId: ObjectId,
	canReadImages: boolean
) {
	const stored = await downloadFile(extracted.value, convId);
	const text = Buffer.from(stored.value, "base64").toString("utf-8");
	const body = `${scanNotice(file.name, scan, canReadImages)}\n\n${wordScanMarkers(text, canReadImages)}`;
	const document = {
		type: "base64" as const,
		name: file.name,
		mime: "text/markdown",
		value: Buffer.from(body, "utf-8").toString("base64"),
	};
	if (!canReadImages) return [document];
	const byHash = new Map<string, ReturnType<typeof downloadFile>>();
	const images = await Promise.all(
		[...scan.files]
			.sort((a, b) => a.page - b.page)
			.map((image) => {
				if (!byHash.has(image.value)) byHash.set(image.value, downloadFile(image.value, convId));
				return byHash.get(image.value) as ReturnType<typeof downloadFile>;
			})
	);
	return [document, ...images];
}

async function resolveOne(
	file: Message["files"] extends (infer F)[] | undefined ? F : never,
	convId: ObjectId
) {
	if (!file.extracted) {
		const downloaded = await downloadFile(file.value, convId);
		if (!isExtractableDocument(documentMime(file.mime, file.name))) return downloaded;
		return {
			type: "base64" as const,
			name: file.name,
			mime: "text/markdown",
			value: Buffer.from(missingTextNotice(file.extractionError), "utf-8").toString("base64"),
		};
	}
	const text = await downloadFile(file.extracted.value, convId);
	// The document's own name, not the text entry's: a citation should name
	// the file somebody attached.
	return { ...text, name: file.name, mime: "text/markdown" };
}

async function downloadFiles(
	messages: Message[],
	convId: ObjectId,
	canReadImages: boolean
): Promise<EndpointMessage[]> {
	return Promise.all(
		messages.map<Promise<EndpointMessage>>((message) =>
			Promise.all(
				(message.files ?? []).map((file) => resolveFile(file, convId, canReadImages))
			).then((files) => ({ ...message, files: files.flat() }))
		)
	);
}

async function injectClipboardFiles(messages: EndpointMessage[]) {
	return Promise.all(
		messages.map((message) => {
			const plaintextFiles = message.files
				?.filter((file) => file.mime === "application/vnd.chatui.clipboard")
				.map((file) => Buffer.from(file.value, "base64").toString("utf-8"));

			if (!plaintextFiles || plaintextFiles.length === 0) return message;

			return {
				...message,
				content: `${plaintextFiles.join("\n\n")}\n\n${message.content}`,
				files: message.files?.filter((file) => file.mime !== "application/vnd.chatui.clipboard"),
			};
		})
	);
}

/**
 * Remove an initial system message if its content is empty/whitespace only.
 * This prevents sending an empty system prompt to any provider.
 */
function stripEmptyInitialSystemMessage(messages: EndpointMessage[]): EndpointMessage[] {
	if (!messages?.length) return messages;
	const first = messages[0];
	if (first?.from !== "system") return messages;

	const content = first?.content as unknown;
	const isEmpty = typeof content === "string" ? content.trim().length === 0 : false;

	if (isEmpty) {
		return messages.slice(1);
	}

	return messages;
}
