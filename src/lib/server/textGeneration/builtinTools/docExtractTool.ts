import { fileTypeFromBuffer } from "file-type";
import { maxAttachmentBytesFor } from "$lib/constants/mime";
import { downloadFile } from "$lib/server/files/downloadFile";
import { logger } from "$lib/server/logger";
import {
	documentMime,
	extractDocument,
	isExtractableDocument,
	type ExtractionFailure,
} from "$lib/server/files/extractDocument";
import {
	getCachedExtraction,
	putCachedExtraction,
	readerKey,
	type CachedExtraction,
} from "$lib/server/files/extractCache";
import {
	VERSION_PROPERTY,
	branchOfCall,
	findConversationFile,
	listFileVersions,
	parseVersion,
} from "./conversationFiles";
import { parsePages } from "./lookDocTool";
import type { BuiltinTool } from "./types";

export const DOC_EXTRACT_TOOL_NAME = "doc_extract";

/** Pages one call returns at most (the rest are one more call away; the file is read, and billed, once). */
export const DOC_EXTRACT_MAX_PAGES = 40;
/** The result never grows past this many characters; `offset` continues from where it was cut. */
export const DOC_EXTRACT_MAX_CHARS = 60_000;
/** Loop protection, not capability: a turn makes at most this many calls. */
export const MAX_EXTRACT_CALLS_PER_TURN = 10;

const TURN_LIMIT_MESSAGE =
	`doc_extract has reached its limit of ${MAX_EXTRACT_CALLS_PER_TURN} calls for this turn. ` +
	"Say what you read and let the user ask for more.";

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface DocExtractParams {
	/** The turn's credential: the reader is called as the user, like an upload's. */
	token?: string;
	/** The user's own default document reader (their setting), as uploads use it. */
	readerModel?: string | null;
	readerLocal?: boolean;
}

/** What a failed read tells the model: the reason, and what to do (or not do) about it. */
export function failureMessage(name: string, failure: ExtractionFailure): string {
	if (failure.withheld) {
		const { rule, pipeline } = failure.withheld;
		return (
			`The document reader refused "${name}" because of a privacy rule ('${rule}'${pipeline ? `, pipeline '${pipeline}'` : ""}). ` +
			"This is a policy, not a fault: do not retry, and do not try to read the file by other means. Tell the user."
		);
	}
	switch (failure.kind) {
		case "no-text":
		case "empty":
			return (
				`No text could be read from "${name}": ${failure.reason} ` +
				"Do not retry. If you can see images, try look_doc (or view_image for a picture) instead."
			);
		case "unsupported":
			return `The document reader cannot take "${name}": ${failure.reason} Do not retry; try another approach (for example the sandbox).`;
		case "no-reader":
			return `${failure.reason} Do not retry; tell the user.`;
		case "no-credential":
			return `${failure.reason} Do not retry.`;
		case "refused":
			return `The document reader refused "${name}": ${failure.reason} Do not retry with the same file.`;
		default:
			return `The document reader could not read "${name}": ${failure.reason} You may try once more later; do not loop.`;
	}
}

/** `1-3, 7` from page numbers. */
function pageRanges(pages: number[]): string {
	const sorted = [...pages].sort((a, b) => a - b);
	const out: string[] = [];
	for (let i = 0; i < sorted.length;) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
		out.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
		i = j + 1;
	}
	return out.join(", ");
}

/**
 * `doc_extract`: send a file of the conversation to the document reader (OCR) and get its text.
 *
 * It is exactly the upload's extraction (`extractDocument`, the same reader resolution, as the user),
 * for a file that did not come in as an upload: one fetched, returned by a connector or made in the
 * sandbox. A file already read at upload returns that text with no call, and what is read here is kept by
 * content hash (`extractCache.ts`), so the same bytes are never read, or paid for, twice.
 *
 * Offered only where an upload would have been read (the caller checked: a direct OCR endpoint, or a
 * reader the gateway resolves).
 */
export function createDocExtractBuiltin(params: DocExtractParams): BuiltinTool[] {
	let calls = 0;
	return [
		{
			name: DOC_EXTRACT_TOOL_NAME,
			definition: {
				type: "function",
				function: {
					name: DOC_EXTRACT_TOOL_NAME,
					description:
						"Send a file of this conversation to the document reader (OCR) and get its text: a scanned PDF, a photographed or " +
						"scanned document (png, jpg, webp), or a long document where look_doc would need many page images. Works on a file " +
						"you fetched, that a connector returned or that you made in the sandbox, not only on uploads. " +
						"Use doc_read first when the file has a text layer (it is cheaper); use look_doc for layout or a visual check. " +
						"Reading may be billed per page, so ask once: the text is kept for the file, and asking again, or for other pages, " +
						"costs nothing. A file the user uploaded was already read when it arrived, and you get that text back. " +
						`Returns the text of up to ${DOC_EXTRACT_MAX_PAGES} pages per call (give \`pages\` for others), cut at ${DOC_EXTRACT_MAX_CHARS.toLocaleString("en-US")} characters; \`offset\` continues. ` +
						"A privacy rule can refuse the read: then do not retry.",
					parameters: {
						type: "object",
						properties: {
							file: {
								type: "string",
								description:
									"Name of the file in the conversation, e.g. scan.pdf (or /mnt/data/scan.pdf).",
							},
							version: VERSION_PROPERTY,
							pages: {
								description: `1-based pages to return: a number, a range string such as "2-4", or a list. At most ${DOC_EXTRACT_MAX_PAGES} pages. Default: the first ${DOC_EXTRACT_MAX_PAGES}.`,
								anyOf: [
									{ type: "integer" },
									{ type: "string" },
									{ type: "array", items: { anyOf: [{ type: "integer" }, { type: "string" }] } },
								],
							},
							offset: {
								type: "integer",
								description:
									"Character to continue from, when an earlier result said the text was cut.",
							},
						},
						required: ["file"],
					},
				},
			},
			async execute(args, ctx) {
				if (!ctx.conversationId)
					return { error: "There is no conversation to take the file from." };
				if (calls >= MAX_EXTRACT_CALLS_PER_TURN) return { error: TURN_LIMIT_MESSAGE };
				calls += 1;
				if (typeof args.file !== "string" || !args.file.trim()) {
					return { error: "Give `file`: the name of a file in this conversation, e.g. scan.pdf." };
				}
				const parsed = parsePages(args.pages, DOC_EXTRACT_MAX_PAGES);
				if (!parsed.ok)
					return { error: parsed.error.replaceAll("look_doc shows", "doc_extract returns") };
				const offset = args.offset === undefined || args.offset === null ? 0 : Number(args.offset);
				if (!Number.isInteger(offset) || offset < 0) {
					return { error: "`offset` is a whole number of characters, 0 or more." };
				}
				const version = parseVersion(args.version);
				if (!version.ok) return { error: version.error };

				const conversationId = ctx.conversationId;
				const branch = await branchOfCall(ctx);
				const file = await findConversationFile(conversationId, args.file, {
					prefer: "output",
					version: version.version,
					branch,
				});
				if (!file.ok) return { error: file.error };

				// What the bytes are decides, as at upload.
				const sniffed = (await fileTypeFromBuffer(file.bytes))?.mime ?? file.mime ?? "";
				const mime = documentMime(sniffed, file.name);
				if (!isExtractableDocument(mime) && !IMAGE_MIMES.has(mime)) {
					return {
						error:
							`"${file.name}" is not a document the reader takes (PDF, Word, Excel, PowerPoint, OpenDocument, EPUB or a png/jpg/webp image).` +
							" Text files need no reader: read them in the sandbox.",
					};
				}
				const limit = maxAttachmentBytesFor(mime);
				if (file.bytes.byteLength > limit) {
					return {
						error: `"${file.name}" is too large to send to the reader: files are limited to ${limit / 1024 / 1024} MB. Do not retry; split or shrink it in the sandbox first.`,
					};
				}

				const reader = readerKey(params.readerModel);
				const conv = conversationId.toString();
				let found: (CachedExtraction & { source: "upload" | "cache" | "reader" }) | undefined;

				// 1. Read at upload already: that text, with no call. It has no page boundaries, so a page
				// range is answered from a read of its own below (kept for next time).
				let uploaded: string | undefined;
				if (file.origin === "attachment" && parsed.pages === undefined) {
					const listing = await listFileVersions(conversationId, file.name, branch);
					const attachment = listing?.attachment?.file;
					if (attachment?.extracted && attachment.value === file.sha256) {
						uploaded = await downloadFile(attachment.extracted.value, conv)
							.then((stored) => Buffer.from(stored.value, "base64").toString("utf-8"))
							.catch(() => undefined);
						if (uploaded?.trim()) {
							found = {
								pages: [uploaded],
								readerModel: (attachment as { readerModel?: string }).readerModel,
								source: "upload",
							};
						}
					}
				}
				// 2. Read here before.
				if (!found) {
					const cached = await getCachedExtraction(conv, file.sha256, reader).catch(() => null);
					if (cached) found = { ...cached, source: "cache" };
				}
				// 3. The reader, exactly as an upload would call it.
				if (!found) {
					const extraction = await extractDocument({
						bytes: file.bytes.buffer.slice(
							file.bytes.byteOffset,
							file.bytes.byteOffset + file.bytes.byteLength
						) as ArrayBuffer,
						mime,
						filename: file.name,
						token: params.token,
						readerModel: params.readerModel,
						readerLocal: params.readerLocal,
					});
					if (!extraction.ok) {
						logger.info(
							{ file: file.name, kind: extraction.kind, status: extraction.status },
							"doc_extract_failed"
						);
						return { error: failureMessage(file.name, extraction) };
					}
					const value: CachedExtraction = {
						pages: extraction.pageTexts?.length ? extraction.pageTexts : [extraction.text],
						...(extraction.readerModel ? { readerModel: extraction.readerModel } : {}),
						...(extraction.readerFallback ? { readerFallback: true } : {}),
					};
					await putCachedExtraction(conv, file.sha256, reader, value).catch((err) =>
						logger.warn({ err }, "doc_extract_cache_write_failed")
					);
					found = { ...value, source: "reader" };
				}

				const total = found.pages.length;
				let selected: number[];
				if (parsed.pages) {
					const outside = parsed.pages.filter((n) => n > total);
					if (outside.length > 0) {
						return {
							error: `"${file.name}" has ${total} page${total === 1 ? "" : "s"}; there is no page ${outside.join(", ")}.`,
						};
					}
					selected = parsed.pages;
				} else {
					selected = Array.from(
						{ length: Math.min(total, DOC_EXTRACT_MAX_PAGES) },
						(_, i) => i + 1
					);
				}
				const body =
					found.source === "upload"
						? found.pages[0]
						: selected
								.map((n) => (selected.length > 1 ? `[page ${n}]\n` : "") + found.pages[n - 1])
								.join("\n\n");
				if (!body.trim()) {
					return {
						error: `The reader returned no text for ${parsed.pages ? `page${selected.length === 1 ? "" : "s"} ${pageRanges(selected)} of ` : ""}"${file.name}". Do not retry; look_doc can show the page if you can see images.`,
					};
				}
				if (offset >= body.length && offset > 0) {
					return {
						error: `The text has ${body.length} characters; there is nothing from ${offset}.`,
					};
				}
				const end = Math.min(body.length, offset + DOC_EXTRACT_MAX_CHARS);
				const text = body.slice(offset, end);

				const readerNote = found.readerModel ? ` with ${found.readerModel}` : "";
				const origin =
					found.source === "upload"
						? "read when it was uploaded, no new call"
						: found.source === "cache"
							? "already read, no new call"
							: "read now; extraction may be billed per page";
				const scope =
					found.source === "upload"
						? "the whole text"
						: `page${selected.length === 1 ? "" : "s"} ${pageRanges(selected)} of ${total}`;
				const more =
					end < body.length
						? ` Cut at character ${end} of ${body.length}: call again with offset ${end} for the rest.`
						: "";
				const rest =
					found.source !== "upload" && !parsed.pages && total > selected.length
						? ` ${total - selected.length} more page${total - selected.length === 1 ? "" : "s"}: ask with \`pages\`.`
						: "";
				const label = `${file.name}${file.version === file.currentVersion ? "" : ` (version ${file.version})`}`;
				return {
					resultText: `[${label}: ${scope}${readerNote} (${origin}).${more}${rest}]\n\n${text}`,
				};
			},
		},
	];
}
