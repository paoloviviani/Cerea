import { fileTypeFromBuffer } from "file-type";
import { maxAttachmentBytesFor } from "$lib/constants/mime";
import { downloadFile } from "$lib/server/files/downloadFile";
import { logger } from "$lib/server/logger";
import {
	NO_READER_MESSAGE,
	directOcrConfigured,
	documentMime,
	extractDocument,
	isExtractableDocument,
	readerSelectsPages,
	resolvedReader,
	type ExtractionFailure,
} from "$lib/server/files/extractDocument";
import {
	getCachedExtraction,
	putCachedExtraction,
	type CachedExtraction,
	type MergedExtraction,
} from "$lib/server/files/extractCache";
import { pdfPageCount } from "$lib/server/files/pdfPageCount";
import { withholdStoredFile } from "$lib/server/files/withholdRefusedImages";
import { withholdDeliverable } from "$lib/server/execution/deliverables";
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
/** Pages one turn may have read (and billed) across its calls; beyond it the user decides. */
export const DOC_EXTRACT_TURN_PAGE_BUDGET = 200;
/** Loop protection, not capability: a turn makes at most this many calls. */
export const MAX_EXTRACT_CALLS_PER_TURN = 10;

const TURN_LIMIT_MESSAGE =
	`doc_extract has reached its limit of ${MAX_EXTRACT_CALLS_PER_TURN} calls for this turn. ` +
	"Say what you read and let the user ask for more.";

const budgetMessage = (needed: number, billed: number) =>
	`The page budget for this turn (${DOC_EXTRACT_TURN_PAGE_BUDGET} pages read by the document reader) is reached: ` +
	`${billed} already read and this read needs about ${needed} more. Do not retry; tell the user and ask whether to go on.`;

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

/** Calls that read the same bytes run one after another, so the second finds what the first kept. */
const inFlight = new Map<string, Promise<unknown>>();
function exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
	const previous = inFlight.get(key) ?? Promise.resolve();
	const next = previous.then(run, run);
	const tail = next.catch(() => undefined);
	inFlight.set(key, tail);
	void tail.then(() => {
		if (inFlight.get(key) === tail) inFlight.delete(key);
	});
	return next;
}

type Served =
	{ error: string } | { merged: MergedExtraction; source: "cache" | "reader"; want?: number[] };

/**
 * `doc_extract`: send a file of the conversation to the document reader (OCR) and get its text.
 *
 * It is the upload's extraction (`extractDocument`, the same reader resolution, as the user), for a
 * file that did not come in as an upload: one fetched, returned by a connector or made in the sandbox.
 * A file already read at upload returns that text with no call, ever (a page range of it is answered
 * from the same text). What is read here is kept by content hash and reader (`extractCache.ts`), only
 * the pages asked for are sent to a reader that takes a page selection, calls on the same bytes run one
 * at a time, and a turn reads at most `DOC_EXTRACT_TURN_PAGE_BUDGET` pages.
 *
 * Offered only where an upload would have been read (the caller checked: a direct OCR endpoint, or a
 * reader the gateway resolves).
 */
export function createDocExtractBuiltin(params: DocExtractParams): BuiltinTool[] {
	let calls = 0;
	let billed = 0;
	// A direct OCR endpoint reads PDFs only; images need a gateway reader.
	const images = !directOcrConfigured();
	return [
		{
			name: DOC_EXTRACT_TOOL_NAME,
			definition: {
				type: "function",
				function: {
					name: DOC_EXTRACT_TOOL_NAME,
					description:
						"Send a file of this conversation to the document reader (OCR) and get its text: a scanned PDF, " +
						(images ? "a photographed or scanned document (png, jpg, webp), " : "") +
						"or a long document where look_doc would need many page images. Works on a file " +
						"you fetched, that a connector returned or that you made in the sandbox, not only on uploads. " +
						"Use doc_read first when the file has a text layer (it is cheaper); use look_doc for layout or a visual check. " +
						"Reading may be billed per page: a turn reads at most " +
						`${DOC_EXTRACT_TURN_PAGE_BUDGET} pages in all, and only the pages you ask for are read where the reader allows it, ` +
						`so name the \`pages\` you need (up to ${DOC_EXTRACT_MAX_PAGES} per call). The text is kept: asking again costs nothing. ` +
						"A file the user uploaded was already read when it arrived, and you get that text back (it has no page boundaries: " +
						"`pages` does not apply, `offset` pages through it). Some readers return a whole document as one text; the result says so. " +
						`Text is cut at ${DOC_EXTRACT_MAX_CHARS.toLocaleString("en-US")} characters; \`offset\` continues. ` +
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
								description: `1-based pages to read: a number, a range string such as "2-4", or a list. At most ${DOC_EXTRACT_MAX_PAGES} pages. Default: the first ${DOC_EXTRACT_MAX_PAGES}.`,
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
				if (!parsed.ok) {
					return { error: parsed.error.replaceAll("look_doc shows", "doc_extract reads") };
				}
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
				const isImage = IMAGE_MIMES.has(mime);
				if (isImage && !images) {
					return {
						error: `"${file.name}" is an image, and this deployment's OCR endpoint reads PDFs only. Use view_image to look at it.`,
					};
				}
				if (!isExtractableDocument(mime) && !isImage) {
					return {
						error:
							`"${file.name}" is not a document the reader takes (PDF, Word, Excel, PowerPoint, OpenDocument, EPUB${images ? " or a png/jpg/webp image" : ""}).` +
							" Text files need no reader: read them in the sandbox.",
					};
				}
				const limit = maxAttachmentBytesFor(mime);
				if (file.bytes.byteLength > limit) {
					return {
						error: `"${file.name}" is too large to send to the reader: files are limited to ${limit / 1024 / 1024} MB. Do not retry; split or shrink it in the sandbox first.`,
					};
				}

				const conv = conversationId.toString();
				const label = `${file.name}${file.version === file.currentVersion ? "" : ` (version ${file.version})`}`;
				const token = params.token;

				// Read at upload already: that text, no call, whatever is asked (it has no page boundaries).
				if (file.origin === "attachment") {
					const listing = await listFileVersions(conversationId, file.name, branch);
					const attachment = listing?.attachment?.file;
					if (attachment?.extracted && attachment.value === file.sha256) {
						const uploaded = await downloadFile(attachment.extracted.value, conv)
							.then((stored) => Buffer.from(stored.value, "base64").toString("utf-8"))
							.catch(() => undefined);
						if (uploaded?.trim()) {
							return render({
								label,
								body: uploaded,
								offset,
								scope: "the whole text",
								reader: (attachment as { readerModel?: string }).readerModel,
								origin: "read when it was uploaded, no new call",
								note: parsed.pages
									? " `pages` was ignored: the upload's text has no page boundaries; use `offset`."
									: "",
							});
						}
					}
				}

				if (!token) {
					return { error: failureMessage(file.name, noCredential) };
				}
				const reader = await resolvedReader({ token, readerModel: params.readerModel, mime });
				if (!reader) return { error: `${NO_READER_MESSAGE} Do not retry; tell the user.` };

				const total = mime === "application/pdf" ? await pdfPageCount(file.bytes) : null;
				const want =
					parsed.pages ?? (total ? range(Math.min(total, DOC_EXTRACT_MAX_PAGES)) : undefined);
				if (want && total) {
					const outside = want.filter((n) => n > total);
					if (outside.length > 0) {
						return {
							error: `"${file.name}" has ${total} page${total === 1 ? "" : "s"}; there is no page ${outside.join(", ")}.`,
						};
					}
				}

				const served: Served = await exclusive(`${conv}|${file.sha256}|${reader}`, async () => {
					const cached = await getCachedExtraction(conv, file.sha256, reader).catch(() => null);
					const have = cached?.pages ?? new Map<number, string>();
					const missing = want ? want.filter((n) => !have.has(n)) : undefined;
					const covered =
						cached !== null &&
						(cached.text !== undefined || (missing ? missing.length === 0 : have.size > 0));
					if (covered) return { merged: cached, source: "cache", want };

					// Only what is asked for goes to a reader that takes a selection; else the whole file is read.
					const selects =
						Boolean(missing?.length) && (await readerSelectsPages(token, reader, mime));
					const cost = selects ? (missing?.length ?? 0) : (total ?? 1);
					if (billed + cost > DOC_EXTRACT_TURN_PAGE_BUDGET) {
						return { error: budgetMessage(cost, billed) };
					}
					const extraction = await extractDocument({
						bytes: file.bytes.buffer.slice(
							file.bytes.byteOffset,
							file.bytes.byteOffset + file.bytes.byteLength
						) as ArrayBuffer,
						mime,
						filename: file.name,
						token,
						readerModel: params.readerModel,
						readerLocal: params.readerLocal,
						...(selects && missing ? { pages: missing } : {}),
					});
					if (!extraction.ok) {
						logger.info(
							{ file: file.name, kind: extraction.kind, status: extraction.status },
							"doc_extract_failed"
						);
						if (extraction.withheld) {
							// As an upload is: the bytes are marked, and nothing reads them again.
							await Promise.all([
								withholdStoredFile(conversationId, file.sha256, extraction.withheld),
								withholdDeliverable(conversationId, file.sha256, extraction.withheld),
							]).catch((err) => logger.error({ err }, "doc_extract_withhold_failed"));
						}
						return { error: failureMessage(file.name, extraction) };
					}
					billed += Math.max(extraction.pages, 0);

					const entry: CachedExtraction = extraction.unpaged
						? { text: extraction.text, readerModel: extraction.readerModel }
						: {
								pages: Object.fromEntries(
									(extraction.pageEntries ?? []).map((e) => [e.page, e.text])
								),
								...(total
									? { total }
									: !extraction.pagesSelected && extraction.pageEntries
										? { total: Math.max(0, ...extraction.pageEntries.map((e) => e.page)) }
										: {}),
								readerModel: extraction.readerModel,
							};
					// A read by another reader than the one keyed (a fallback) is not kept under this key.
					const keep = !extraction.readerFallback && (extraction.readerModel ?? reader) === reader;
					if (keep) {
						await putCachedExtraction(conv, file.sha256, reader, entry).catch((err) =>
							logger.warn({ err }, "doc_extract_cache_write_failed")
						);
					}
					const merged: MergedExtraction = {
						pages: new Map([
							...have,
							...Object.entries(entry.pages ?? {}).map(([n, t]) => [Number(n), t] as const),
						]),
						total: entry.total ?? cached?.total,
						text: entry.text ?? cached?.text,
						readerModel: entry.readerModel ?? cached?.readerModel,
					};
					return { merged, source: "reader", want };
				});
				if ("error" in served) return served;

				const { merged } = served;
				const origin =
					served.source === "cache"
						? "already read, no new call"
						: "read now; extraction may be billed per page";
				if (merged.text !== undefined) {
					return render({
						label,
						body: merged.text,
						offset,
						scope: "the whole text",
						reader: merged.readerModel,
						origin,
						note: parsed.pages
							? " The reader returns this document as one text with no page boundaries, so `pages` was ignored; use `offset`."
							: " The reader returns this document as one text with no page boundaries.",
					});
				}
				const selected =
					served.want ??
					[...merged.pages.keys()].sort((a, b) => a - b).slice(0, DOC_EXTRACT_MAX_PAGES);
				const present = selected.filter((n) => (merged.pages.get(n) ?? "").trim());
				if (present.length === 0) {
					return {
						error: `The reader returned no text for ${parsed.pages ? `page${selected.length === 1 ? "" : "s"} ${pageRanges(selected)} of ` : ""}"${file.name}". Do not retry; look_doc can show the page if you can see images.`,
					};
				}
				const text = present
					.map((n) => (present.length > 1 ? `[page ${n}]\n` : "") + merged.pages.get(n))
					.join("\n\n");
				const known = merged.total ?? total ?? undefined;
				const rest =
					!parsed.pages && known && known > selected.length
						? ` ${known - selected.length} more page${known - selected.length === 1 ? "" : "s"}: ask with \`pages\`.`
						: "";
				return render({
					label,
					body: text,
					offset,
					scope: `page${selected.length === 1 ? "" : "s"} ${pageRanges(selected)}${known ? ` of ${known}` : ""}`,
					reader: merged.readerModel,
					origin,
					note: rest,
				});
			},
		},
	];
}

const noCredential: ExtractionFailure = {
	ok: false,
	kind: "no-credential",
	status: 401,
	reason: "The document cannot be read because your sign-in is incomplete. Sign out and back in.",
};

function range(n: number): number[] {
	return Array.from({ length: n }, (_, i) => i + 1);
}

/** The result text: a header line, then the text from `offset`, cut at the character cap. */
function render(options: {
	label: string;
	body: string;
	offset: number;
	scope: string;
	reader?: string;
	origin: string;
	note?: string;
}): { resultText: string } | { error: string } {
	const { label, body, offset, scope, reader, origin, note = "" } = options;
	if (offset > 0 && offset >= body.length) {
		return { error: `The text has ${body.length} characters; there is nothing from ${offset}.` };
	}
	const end = Math.min(body.length, offset + DOC_EXTRACT_MAX_CHARS);
	const more =
		end < body.length
			? ` Cut at character ${end} of ${body.length}: call again with offset ${end} for the rest.`
			: "";
	return {
		resultText: `[${label}: ${scope}${reader ? ` with ${reader}` : ""} (${origin}).${note}${more}]\n\n${body.slice(offset, end)}`,
	};
}
