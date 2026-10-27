import { randomUUID } from "node:crypto";
import { storeDeliverable } from "$lib/server/execution/deliverables";
import { logger } from "$lib/server/logger";
import {
	ConversionError,
	MAX_HTML_BYTES,
	MAX_SOURCE_BYTES,
	convertHtmlToPdf,
	convertOfficeToPdf,
	extensionOf,
	isGotenbergEnabled,
	isOfficeDocument,
	markdownToHtml,
} from "$lib/server/office/gotenberg";
import { MessageCodeExecutionUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import { findConversationFile } from "./conversationFiles";
import type { BuiltinTool } from "./types";

export const CONVERT_DOCUMENT_TOOL_NAME = "convert_document";

/** Loop protection, not capability: a turn converts at most this many documents. */
export const MAX_CONVERSIONS_PER_TURN = 6;

const TURN_LIMIT_MESSAGE =
	`convert_document has reached its limit of ${MAX_CONVERSIONS_PER_TURN} calls for this turn. ` +
	"Tell the person what you converted and let them ask for more.";

/**
 * The tool is offered only where the deployment runs a converter
 * (`CHAT_GOTENBERG_URL`, the kit's `office` profile). Off, nothing registers.
 */
export function isConvertDocumentEnabled(): boolean {
	return isGotenbergEnabled();
}

type Source =
	| { kind: "office"; name: string; bytes: Buffer }
	| { kind: "markdown" | "html"; name: string; text: string };

type Found = { ok: true; source: Source } | { ok: false; error: string };

/** The pdf's name: the source's, with `.pdf`, or the given name made safe. */
export function outputNameFor(requested: unknown, fallbackStem: string): string {
	const wanted = typeof requested === "string" && requested.trim() ? requested : fallbackStem;
	const base = (wanted.replace(/\\/g, "/").split("/").pop() ?? "")
		// eslint-disable-next-line no-control-regex -- control bytes are valid filename attacks
		.replace(/[\u0000-\u001f]/g, "")
		.trim();
	const stem =
		base
			.replace(/\.pdf$/i, "")
			.replace(/^\.+/, "")
			.slice(0, 100) || "document";
	return `${stem}.pdf`;
}

/** The file as a conversion source: size and kind checked. */
async function findSource(
	conversationId: NonNullable<Parameters<BuiltinTool["execute"]>[1]["conversationId"]>,
	reference: string
): Promise<Found> {
	const file = await findConversationFile(conversationId, reference);
	if (!file.ok) return file;
	const { name, bytes } = file;
	if (bytes.byteLength > MAX_SOURCE_BYTES) {
		return {
			ok: false,
			error: `"${name}" is larger than the ${MAX_SOURCE_BYTES / (1024 * 1024)} MB conversion limit.`,
		};
	}
	const ext = extensionOf(name);
	if (isOfficeDocument(name)) return { ok: true, source: { kind: "office", name, bytes } };
	if (ext === "md" || ext === "markdown") {
		return { ok: true, source: { kind: "markdown", name, text: bytes.toString("utf-8") } };
	}
	if (ext === "html" || ext === "htm") {
		return { ok: true, source: { kind: "html", name, text: bytes.toString("utf-8") } };
	}
	if (ext === "pdf") return { ok: false, error: `"${name}" is already a PDF.` };
	return {
		ok: false,
		error:
			`"${name}" cannot be converted: this tool takes Word, Excel, PowerPoint and OpenDocument ` +
			"files, and Markdown or HTML.",
	};
}

/**
 * `convert_document`: a file or some content to PDF, through the deployment's
 * Gotenberg (`office/gotenberg.ts`). Local to the deployment, so nothing is
 * metered. The PDF is stored as a produced file of the conversation, listed
 * and previewed like any other.
 */
export function createConvertDocumentBuiltin(): BuiltinTool[] {
	if (!isConvertDocumentEnabled()) return [];

	// Built once per turn (getEnabledBuiltinTools runs per turn), so the count resets with it.
	let callsThisTurn = 0;

	return [
		{
			name: CONVERT_DOCUMENT_TOOL_NAME,
			definition: {
				type: "function",
				function: {
					name: CONVERT_DOCUMENT_TOOL_NAME,
					description:
						"Make a PDF. Give exactly one of: `file`, the name of a document already in this " +
						"conversation (an attachment or a file you produced; Word, Excel, PowerPoint or " +
						"OpenDocument, or a Markdown or HTML file), converted with its layout; or `markdown` / " +
						"`html`, content you write, rendered as a document (no JavaScript runs and nothing " +
						"is fetched from the internet: images must be inline data: URLs, styles inline). " +
						"The PDF is saved in the conversation as a new file and listed for the person, who " +
						"can open and download it; the result names it.",
					parameters: {
						type: "object",
						properties: {
							file: {
								type: "string",
								description:
									"Name of a file in the conversation, e.g. report.docx (or /mnt/data/report.docx).",
							},
							markdown: {
								type: "string",
								description: "Markdown to render as a document (alternative to file and html).",
							},
							html: {
								type: "string",
								description:
									"A complete or partial HTML document to render (alternative to file and markdown).",
							},
							name: {
								type: "string",
								description:
									"Name for the PDF, e.g. summary.pdf. Optional for `file` (the file's name with .pdf); " +
									"recommended with markdown or html (default document.pdf).",
							},
						},
					},
				},
			},
			preprompt:
				`PDF: ${CONVERT_DOCUMENT_TOOL_NAME} turns a document in this conversation, or Markdown or ` +
				"HTML you write, into a PDF the person can open and download. Use it only when they ask for a PDF. " +
				"It is not needed to read a document (its text is already given to you), and not to preview or " +
				"check a Word, Excel or PowerPoint file you made: the chat already shows the person a preview of it.",

			async execute(args, ctx) {
				if (!ctx.conversationId) return { error: "There is no conversation to save a PDF in." };
				if (!isGotenbergEnabled()) {
					return { error: "Document conversion is not available on this deployment." };
				}
				if (callsThisTurn >= MAX_CONVERSIONS_PER_TURN) return { error: TURN_LIMIT_MESSAGE };
				callsThisTurn += 1;

				const given = (["file", "markdown", "html"] as const).filter(
					(key) => typeof args[key] === "string" && String(args[key]).trim() !== ""
				);
				if (given.length !== 1) {
					return {
						error: "Give exactly one of `file`, `markdown` or `html`.",
					};
				}

				try {
					let pdf: Buffer;
					let fallbackStem = "document";
					if (given[0] === "file") {
						const found = await findSource(ctx.conversationId, String(args.file));
						if (!found.ok) return { error: found.error };
						const source = found.source;
						fallbackStem = source.name.replace(/\.[^.]*$/, "") || "document";
						pdf =
							source.kind === "office"
								? await convertOfficeToPdf(source.bytes, source.name, {
										signal: ctx.abortSignal,
									})
								: await convertHtmlToPdf(
										source.kind === "markdown" ? markdownToHtml(source.text) : source.text,
										{ title: fallbackStem, signal: ctx.abortSignal }
									);
					} else {
						const content = String(args[given[0]]);
						if (Buffer.byteLength(content) > MAX_HTML_BYTES) {
							return {
								error: `The content is larger than the ${MAX_HTML_BYTES / (1024 * 1024)} MB limit.`,
							};
						}
						pdf = await convertHtmlToPdf(
							given[0] === "markdown" ? markdownToHtml(content) : content,
							{ signal: ctx.abortSignal }
						);
					}

					const name = outputNameFor(args.name, fallbackStem);
					const stored = await storeDeliverable({
						conversationId: ctx.conversationId,
						userId: ctx.userId,
						name,
						mime: "application/pdf",
						bytes: pdf,
					});
					if (!stored.ok) return { error: stored.error };

					return {
						resultText:
							`Saved ${stored.ref.name} (${Math.max(1, Math.round(stored.ref.size / 1024))} KB) ` +
							"in this conversation; the person can open and download it.",
						// Listed like any produced file: the same record a run's files ride on.
						extraUpdates: [
							{
								type: MessageUpdateType.CodeExecution,
								subtype: MessageCodeExecutionUpdateType.Outputs,
								runKey: `${CONVERT_DOCUMENT_TOOL_NAME}:${randomUUID()}`,
								files: [stored.ref],
							},
						],
					};
				} catch (err) {
					if (err instanceof ConversionError) return { error: err.message };
					logger.error({ err }, "convert_document_failed");
					return { error: "The conversion failed." };
				}
			},
		},
	];
}
