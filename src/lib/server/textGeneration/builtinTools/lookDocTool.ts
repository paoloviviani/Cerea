import { DocumentsError, renderPdf, type DocumentCapabilities } from "$lib/server/documents/client";
import {
	ConversionError,
	MAX_SOURCE_BYTES,
	extensionOf,
	isGotenbergEnabled,
	isOfficeDocument,
} from "$lib/server/office/gotenberg";
import { getOrCreatePreview, previewOwner } from "$lib/server/office/previewStore";
import { logger } from "$lib/server/logger";
import { VERSION_PROPERTY, findConversationFile, parseVersion } from "./conversationFiles";
import type { DocumentTurnState } from "./documentTools";
import {
	MAX_IMAGES_PER_TURN,
	IMAGES_UNAVAILABLE_ERROR,
	type PictureState,
} from "../mcp/pictureMessages";
import type { BuiltinTool } from "./types";

export const LOOK_DOC_TOOL_NAME = "look_doc";

/** Images per call: each costs the model about a thousand tokens or more. */
export const LOOK_DOC_MAX_PAGES = 6;
/** Loop protection, not capability: a turn makes at most this many calls. */
export const MAX_LOOK_CALLS_PER_TURN = 10;
/** The longest side of a slide image, and the width of a page image, in pixels. */
export const SLIDE_MAX_SIDE_PX = 1200;
export const PAGE_WIDTH_PX = 1000;
/** A PDF larger than this is not sent to the renderer (the service's own cap is larger). */
const MAX_PDF_BYTES = 32 * 1024 * 1024;

const IMAGE_LIMIT_MESSAGE = (shown: number) =>
	`look_doc has already shown you ${shown} images this turn, and the limit is ${MAX_IMAGES_PER_TURN}. ` +
	"Say what you saw and let the user ask for more.";

const TURN_LIMIT_MESSAGE =
	`look_doc has reached its limit of ${MAX_LOOK_CALLS_PER_TURN} calls for this turn. ` +
	"Say what you saw and let the user ask for more.";

const SLIDE_EXTENSIONS = new Set([
	"ppt",
	"pptx",
	"pptm",
	"pps",
	"ppsx",
	"odp",
	"otp",
	"fodp",
	"key",
]);

/** Whether a file is a deck, so that its pages are called slides and drawn by their longest side. */
export function isSlideDeck(name: string): boolean {
	return SLIDE_EXTENSIONS.has(extensionOf(name));
}

export type ParsedPages = { ok: true; pages: number[] | undefined } | { ok: false; error: string };

/**
 * `pages` as the model may give it: a number (`3`), a range string (`"2-4"`, `"1, 3-5"`), or a list of
 * either. Absent or empty means "the default" (undefined). More than `cap` pages is refused with the count
 * and the cap, before anything is converted or drawn.
 */
export function parsePages(input: unknown, cap = LOOK_DOC_MAX_PAGES): ParsedPages {
	if (input === undefined || input === null || input === "") return { ok: true, pages: undefined };
	const items = Array.isArray(input) ? input : [input];
	if (items.length === 0) return { ok: true, pages: undefined };
	const bad = (what: string): ParsedPages => ({
		ok: false,
		error:
			`Cannot read pages ${what}. Give 1-based page numbers or ranges, for example 3, "2-4", ` +
			`or [1, 5, "7-8"].`,
	});
	const pages: number[] = [];
	let count = 0;
	for (const item of items) {
		const parts =
			typeof item === "number" ? [String(item)] : typeof item === "string" ? item.split(",") : null;
		if (!parts) return bad(JSON.stringify(item) ?? String(item));
		for (const raw of parts) {
			const text = raw.trim();
			if (text === "") continue;
			const matched = /^(\d{1,6})(?:\s*(?:-|–|to)\s*(\d{1,6}))?$/.exec(text);
			if (!matched) return bad(JSON.stringify(raw));
			const from = Number(matched[1]);
			const to = Number(matched[2] ?? matched[1]);
			if (from < 1 || to < 1) return { ok: false, error: "Pages are numbered from 1." };
			if (to < from) {
				return {
					ok: false,
					error: `The range "${text}" runs backwards; write it as "${to}-${from}".`,
				};
			}
			count += to - from + 1;
			if (count > cap) {
				return {
					ok: false,
					error:
						`Too many pages: look_doc shows at most ${cap} per call and this asks for ${count} or more. ` +
						"Ask for the ones you need now and the others in a later call.",
				};
			}
			for (let n = from; n <= to; n += 1) if (!pages.includes(n)) pages.push(n);
		}
	}
	return { ok: true, pages: pages.length > 0 ? pages : undefined };
}

/** Whether the document service can draw pages (`/v1/render`): the first half of the tool's gate. */
export function canRenderPages(caps: DocumentCapabilities | null | undefined): boolean {
	return Boolean(caps?.render?.formats.includes("pdf"));
}

/**
 * `look_doc`: images of pages or slides of a document in the conversation, for a model that can see.
 *
 * Offered only when it can work: the caller has checked that the turn's model takes images, and this checks
 * that the document service draws pages (it needs `/v1/render`). Office files go to PDF through the same
 * preview cache the chat's own previews use (`previewStore.ts`: a file already previewed costs no
 * conversion); without Gotenberg only PDFs can be looked at, and the description says so.
 *
 * A tool message is text only, so the images ride in `images` and reach the model as image content in the
 * round's next request (`pictureMessage` in `mcp/toolInvocation.ts`).
 */
export function createLookDocBuiltins(
	caps: DocumentCapabilities | null | undefined,
	turn?: DocumentTurnState,
	pictureState?: PictureState
): BuiltinTool[] {
	if (!caps || !canRenderPages(caps)) return [];
	const cap = Math.max(
		1,
		Math.min(LOOK_DOC_MAX_PAGES, caps.limits?.max_render_pages ?? LOOK_DOC_MAX_PAGES)
	);
	const office = isGotenbergEnabled();
	let calls = 0;
	let imagesShown = 0;

	return [
		{
			name: LOOK_DOC_TOOL_NAME,
			definition: {
				type: "function",
				function: {
					name: LOOK_DOC_TOOL_NAME,
					description:
						(office
							? "Look at pages or slides of a Word, Excel, PowerPoint or PDF file in this conversation (an attachment or a file you made)"
							: "Look at pages of a PDF file in this conversation (an attachment or a file you made); Word, Excel and PowerPoint files cannot be drawn on this deployment") +
						": you get images you can see. Use it to check the layout of what you produced (text running out of its box, overlaps, a table cut off, an empty slide), " +
						"or to read a form or a scanned page as it really looks. " +
						`At most ${cap} pages per call; the result says how many pages the file has, so you can ask for others. ` +
						'`pages` are 1-based numbers or ranges ("3", "2-4", [1, 5]); without it you get the first pages' +
						(office ? " (for a deck you just edited, the slides the edit touched)" : "") +
						". Each image is PNG or JPEG, whichever is smaller: slides about 1,200 px on the longest side, pages about 1,000 px wide. " +
						"Each costs about 1,100 tokens (a slide) to 1,900 (an A4 page), so look sparingly: once after a creation, a redesign or a layout change, " +
						"not after small text edits. " +
						(office
							? "Word, Excel and PowerPoint files are drawn by LibreOffice, so fonts and line breaks can differ slightly from Microsoft Office: good for spotting broken layouts, not for pixel checks."
							: ""),
					parameters: {
						type: "object",
						properties: {
							file: {
								type: "string",
								description:
									"Name of the file in the conversation, e.g. deck.pptx (or /mnt/data/deck.pptx).",
							},
							version: VERSION_PROPERTY,
							pages: {
								description: `1-based page or slide numbers: a number, a range string such as "2-4", or a list of them. At most ${cap} pages.`,
								anyOf: [
									{ type: "integer" },
									{ type: "string" },
									{ type: "array", items: { anyOf: [{ type: "integer" }, { type: "string" }] } },
								],
							},
						},
						required: ["file"],
					},
				},
			},

			async execute(args, ctx) {
				// The endpoint rejected a request carrying pictures earlier in this turn.
				if (pictureState?.unavailable) return { error: IMAGES_UNAVAILABLE_ERROR };
				if (!ctx.conversationId)
					return { error: "There is no conversation to take the file from." };
				if (calls >= MAX_LOOK_CALLS_PER_TURN) return { error: TURN_LIMIT_MESSAGE };
				calls += 1;
				if (imagesShown >= MAX_IMAGES_PER_TURN) return { error: IMAGE_LIMIT_MESSAGE(imagesShown) };
				if (typeof args.file !== "string" || !args.file.trim()) {
					return { error: "Give `file`: the name of a file in this conversation, e.g. deck.pptx." };
				}
				const parsed = parsePages(args.pages, cap);
				if (!parsed.ok) return { error: parsed.error };

				const version = parseVersion(args.version);
				if (!version.ok) return { error: version.error };
				const file = await findConversationFile(ctx.conversationId, args.file, {
					prefer: "output",
					version: version.version,
				});
				if (!file.ok) return { error: file.error };
				const ext = extensionOf(file.name);

				let pdf: Buffer;
				if (ext === "pdf") {
					if (file.bytes.byteLength > MAX_PDF_BYTES) {
						return {
							error: `"${file.name}" is larger than the ${MAX_PDF_BYTES / (1024 * 1024)} MB look_doc accepts.`,
						};
					}
					pdf = file.bytes;
				} else if (isOfficeDocument(file.name)) {
					if (!office) {
						return {
							error: `"${file.name}" cannot be drawn: this deployment has no document converter, so only PDF files can be looked at.`,
						};
					}
					if (file.bytes.byteLength > MAX_SOURCE_BYTES) {
						return {
							error: `"${file.name}" is larger than the ${MAX_SOURCE_BYTES / (1024 * 1024)} MB conversion limit.`,
						};
					}
					try {
						const preview = await getOrCreatePreview({
							bytes: file.bytes,
							name: file.name,
							owner: previewOwner(
								file.origin === "attachment" ? "att" : "out",
								ctx.conversationId.toString(),
								file.sha256
							),
							signal: ctx.abortSignal,
						});
						pdf = preview.pdf;
					} catch (err) {
						if (err instanceof ConversionError) {
							return { error: `"${file.name}" could not be converted to look at: ${err.message}` };
						}
						logger.error({ err }, "look_doc_conversion_failed");
						return { error: `"${file.name}" could not be converted to look at.` };
					}
				} else {
					return {
						error:
							`"${file.name}" cannot be drawn: look_doc shows Word, Excel, PowerPoint and PDF files` +
							(ext ? `, not .${ext} files.` : "."),
					};
				}

				const deck = isSlideDeck(file.name);
				const noun = deck ? "slide" : "page";
				const size = deck ? { max_side_px: SLIDE_MAX_SIDE_PX } : { width_px: PAGE_WIDTH_PX };
				const touched =
					deck && file.version === file.currentVersion
						? turn?.touchedSlides.get(file.name)
						: undefined;
				const asked = parsed.pages ?? touched?.slice(0, cap);

				try {
					let rendered;
					try {
						rendered = await renderPdf(
							pdf,
							{ ...(asked ? { pages: asked } : {}), ...size },
							{ signal: ctx.abortSignal }
						);
					} catch (err) {
						// The slides a past edit touched are a guess about numbering (an edit can move slides):
						// when they do not exist, show the first ones rather than fail on a default.
						if (!(
							parsed.pages === undefined &&
							touched &&
							err instanceof DocumentsError &&
							err.kind === "rejected"
						)) {
							throw err;
						}
						rendered = await renderPdf(pdf, size, { signal: ctx.abortSignal });
					}
					if (imagesShown + rendered.pages.length > MAX_IMAGES_PER_TURN) {
						return {
							error:
								`${IMAGE_LIMIT_MESSAGE(imagesShown)} This call would add ${rendered.pages.length} more; ` +
								"ask for fewer pages.",
						};
					}
					imagesShown += rendered.pages.length;
					const shown = rendered.pages.map((p) => p.page);
					const more = rendered.page_count - shown.length;
					const formats = [...new Set(rendered.pages.map((p) => p.format.toUpperCase()))].join(
						" and "
					);
					const first = rendered.pages[0];
					return {
						resultText:
							`${file.name}${file.version === file.currentVersion ? "" : ` (version ${file.version})`} has ${rendered.page_count} ${noun}${rendered.page_count === 1 ? "" : "s"}. ` +
							`Showing ${noun}${shown.length === 1 ? "" : "s"} ${shown.join(", ")} as ${formats} image${shown.length === 1 ? "" : "s"} ` +
							`(${first ? `${first.width}x${first.height} px` : ""}), next to this result. ` +
							(more > 0 ? `${more} more not shown: ask for them with \`pages\`. ` : "") +
							(ext === "pdf"
								? ""
								: "Drawn by LibreOffice: fonts and line breaks can differ slightly from Microsoft Office. ") +
							// The pictures ride in this turn's requests only: a later turn replays this text, not them.
							"Shown to you as images in this turn only; call look_doc again to see them later.",
						imagesOf: `${file.name}, ${noun}${shown.length === 1 ? "" : "s"} ${shown.join(", ")}`,
						images: rendered.pages.map((p) => ({
							mime: p.content_type,
							base64: p.base64,
							label: `${file.name}, ${noun} ${p.page} of ${rendered.page_count}`,
						})),
					};
				} catch (err) {
					if (err instanceof DocumentsError) return { error: err.message };
					logger.error({ err }, "look_doc_failed");
					return { error: "The pages could not be drawn." };
				}
			},
		},
	];
}
