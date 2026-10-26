import { randomUUID } from "node:crypto";
import { collections } from "$lib/server/database";
import {
	DOCUMENT_FORMATS,
	DocumentsError,
	editDocument,
	outlineDocument,
	readDocument,
	type DocumentCapabilities,
	type DocumentFormat,
	type EditResult,
	type FormatCapabilities,
	type JsonSchema,
} from "$lib/server/documents/client";
import { storeDeliverable } from "$lib/server/execution/deliverables";
import { logger } from "$lib/server/logger";
import { MessageCodeExecutionUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import { bareName, findConversationFile, type ConversationFile } from "./conversationFiles";
import type { BuiltinTool, BuiltinToolContext } from "./types";

export const DOC_OUTLINE_TOOL_NAME = "doc_outline";
export const DOC_READ_TOOL_NAME = "doc_read";
export const DOC_EDIT_TOOL_NAME = "doc_edit";

/** Loop protection, not capability: a turn makes at most this many document calls. */
export const MAX_DOCUMENT_CALLS_PER_TURN = 30;

/** A document the tools take: not larger than this (the service's own cap is the real one). */
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
/** At most this many diff lines go back to the model. */
const MAX_DIFF_LINES = 120;
/** The tool result never grows past this many characters. */
const MAX_RESULT_CHARS = 60_000;

const TURN_LIMIT_MESSAGE =
	`The document tools have reached their limit of ${MAX_DOCUMENT_CALLS_PER_TURN} calls for this turn. ` +
	"Tell the person what you did and let them ask for more.";

const FORMAT_LABEL: Record<DocumentFormat, string> = {
	docx: "Word (.docx)",
	xlsx: "Excel (.xlsx)",
	pptx: "PowerPoint (.pptx)",
};

/** A short type for one property of an operation schema: `string`, `0|1`, `object[]`. */
function typeOf(schema: JsonSchema | undefined): string {
	if (!schema) return "any";
	if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join("|");
	const type = Array.isArray(schema.type) ? schema.type.join("|") : (schema.type ?? "any");
	if (type === "array") return `${typeOf(schema.items)}[]`;
	return type;
}

/**
 * One operation as the model reads it: `replace_text{find: string, replace: string, scope?: string}`.
 * Generated from the service's own JSON schema, so the contract has one source
 * and a new operation appears in the tool as soon as the service lists it.
 */
export function describeOperation(name: string, schema: JsonSchema | undefined): string {
	const props = schema?.properties;
	if (!props) return name;
	const required = new Set(schema.required ?? []);
	const parts = Object.entries(props)
		.filter(([key]) => key !== "op")
		.map(([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${typeOf(value)}`);
	return `${name}{${parts.join(", ")}}`;
}

function operationLines(caps: DocumentCapabilities): string[] {
	const lines: string[] = [];
	for (const format of DOCUMENT_FORMATS) {
		const entry = caps.formats[format];
		if (!entry || entry.operations.length === 0) continue;
		const ops = entry.operations.map((op) => describeOperation(op, entry.operation_schemas?.[op]));
		lines.push(`${FORMAT_LABEL[format]}: ${ops.join("; ")}`);
	}
	return lines;
}

/** Every operation name the service lists, across formats. */
export function listedOperations(caps: DocumentCapabilities): string[] {
	return [
		...new Set(
			DOCUMENT_FORMATS.flatMap(
				(format) => (caps.formats[format] as FormatCapabilities | undefined)?.operations ?? []
			)
		),
	];
}

const SHARED_PREPROMPT =
	"Word, Excel and PowerPoint files: use doc_outline to see a file's structure, doc_read for exact content, " +
	"and doc_edit to change it. Never write code to edit a supplied Office file, and never rewrite a whole file " +
	"to change a part of it; the edit tools touch only what the operations name. Files are given by name (an " +
	"attachment, or a file you produced); an edit is saved as a new version under the same name, and the " +
	"person's original stays as it was.";

function userMessage(error: unknown): string {
	if (error instanceof DocumentsError) return error.message;
	logger.error({ err: error }, "document_tool_failed");
	return "The document tool failed.";
}

/** The person's display name, the default author of tracked changes. */
async function authorFor(userId: BuiltinToolContext["userId"]): Promise<string> {
	if (!userId) return "Cerea";
	const user = await collections.users
		.findOne({ _id: userId }, { projection: { name: 1, username: 1 } })
		.catch(() => null);
	return (user?.name || user?.username || "Cerea").slice(0, 120);
}

type Loaded =
	{ ok: true; file: Extract<ConversationFile, { ok: true }> } | { ok: false; error: string };

async function loadDocument(ctx: BuiltinToolContext, reference: unknown): Promise<Loaded> {
	if (!ctx.conversationId)
		return { ok: false, error: "There is no conversation to take the file from." };
	if (typeof reference !== "string" || !reference.trim()) {
		return {
			ok: false,
			error: "Give `file`: the name of a document in this conversation, e.g. report.docx.",
		};
	}
	const file = await findConversationFile(ctx.conversationId, reference, { prefer: "output" });
	if (!file.ok) return file;
	if (file.bytes.byteLength > MAX_DOCUMENT_BYTES) {
		return {
			ok: false,
			error: `"${file.name}" is larger than the ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB the document tools accept.`,
		};
	}
	return { ok: true, file };
}

function capped(value: unknown): string {
	const text = JSON.stringify(value);
	return text.length > MAX_RESULT_CHARS
		? `${text.slice(0, MAX_RESULT_CHARS)}... [cut: ${text.length - MAX_RESULT_CHARS} more characters; ask for a narrower target]`
		: text;
}

/** What the model is told about the verify report: the verdict and what moved. */
function verifySummary(verify: EditResult["verify"]) {
	const pick = (key: string) => (key in verify ? { [key]: verify[key] } : {});
	return {
		ok: verify.ok === true,
		...pick("parts"),
		...pick("byte_identical"),
		...pick("changed"),
		...pick("added"),
		...pick("removed"),
		...pick("reopened_with"),
		...pick("problems"),
	};
}

/**
 * The edited file's name: its source's. A produced source keeps its path, so
 * the result is the next version of the same file artifact; an attachment's
 * edit starts the artifact under the attachment's name (the attachment itself
 * stays on the person's message, untouched).
 */
function savedName(file: Extract<ConversationFile, { ok: true }>): string {
	const base = file.origin === "output" ? file.name : (file.name.split("/").pop() ?? file.name);
	// eslint-disable-next-line no-control-regex -- control bytes are valid filename attacks
	return base.replace(/[\u0000-\u001f]/g, "").slice(0, 160) || "document";
}

/**
 * `doc_outline`, `doc_read` and `doc_edit` (ADR 0103): Word, Excel and
 * PowerPoint files through the deployment's document service, as typed tools.
 *
 * Offered only with the service configured and answering (`caps` is resolved
 * by the caller, `getCapabilities`), and `doc_edit` only with the operations
 * the service says it implements. The model never handles bytes: it names a
 * file the conversation already has, Cerea reads it from the store (checking it
 * belongs to this conversation), and an edit comes back as a stored file the
 * person sees as an ordinary file card.
 */
export function createDocumentBuiltins(
	caps: DocumentCapabilities | null | undefined
): BuiltinTool[] {
	if (!caps) return [];
	const formats = DOCUMENT_FORMATS.filter((f) => caps.formats[f]);
	const canOutline = formats.some((f) => caps.formats[f]?.outline);
	const canRead = formats.some((f) => caps.formats[f]?.read);
	const operations = listedOperations(caps);
	const canTrack = formats.some((f) => caps.formats[f]?.track_changes);
	const tools: BuiltinTool[] = [];

	// Built once per turn (getEnabledBuiltinTools runs per turn), so the count resets with it.
	let calls = 0;
	const countCall = (): string | undefined => {
		if (calls >= MAX_DOCUMENT_CALLS_PER_TURN) return TURN_LIMIT_MESSAGE;
		calls += 1;
		return undefined;
	};

	const fileProperty = {
		type: "string",
		description:
			"Name of a Word, Excel or PowerPoint file in the conversation: an attachment or a file you " +
			"produced, e.g. report.docx (or /mnt/data/report.docx).",
	};

	if (canOutline) {
		tools.push({
			name: DOC_OUTLINE_TOOL_NAME,
			definition: {
				type: "function",
				function: {
					name: DOC_OUTLINE_TOOL_NAME,
					description:
						"The structure of a Word, Excel or PowerPoint file with stable ids and short text previews: " +
						"Word paragraphs (p1...), tables (t1...) and images; Excel sheets, used ranges, tables and charts; " +
						"PowerPoint slides, shapes, placeholders, images and notes. Call it first; the ids it gives are " +
						"what doc_read and doc_edit take.",
					parameters: {
						type: "object",
						properties: { file: fileProperty },
						required: ["file"],
					},
				},
			},
			preprompt: SHARED_PREPROMPT,
			async execute(args, ctx) {
				const limit = countCall();
				if (limit) return { error: limit };
				const loaded = await loadDocument(ctx, args.file);
				if (!loaded.ok) return { error: loaded.error };
				try {
					const outline = await outlineDocument(loaded.file, { signal: ctx.abortSignal });
					return { resultText: capped(outline) };
				} catch (err) {
					return { error: userMessage(err) };
				}
			},
		});
	}

	if (canRead) {
		const shapes: string[] = [];
		if (caps.formats.docx?.read)
			shapes.push('Word: ["p3", "t1"] (paragraph or table ids from doc_outline)');
		if (caps.formats.xlsx?.read) shapes.push('Excel: [{"sheet": "Data", "range": "A1:C10"}]');
		if (caps.formats.pptx?.read) shapes.push('PowerPoint: [{"slide": 2}]');
		tools.push({
			name: DOC_READ_TOOL_NAME,
			definition: {
				type: "function",
				function: {
					name: DOC_READ_TOOL_NAME,
					description:
						"The exact content of parts of a document: Word paragraph text with run formatting and table " +
						"cells; an Excel range with values and formulas; a PowerPoint slide's text and notes. " +
						`Targets: ${shapes.join("; ")}.`,
					parameters: {
						type: "object",
						properties: {
							file: fileProperty,
							targets: {
								type: "array",
								description: "What to read, in the shapes above (at most 200).",
								items: {},
							},
						},
						required: ["file", "targets"],
					},
				},
			},
			preprompt: canOutline ? undefined : SHARED_PREPROMPT,
			async execute(args, ctx) {
				const limit = countCall();
				if (limit) return { error: limit };
				if (!Array.isArray(args.targets) || args.targets.length === 0) {
					return { error: "Give `targets`: a non-empty list of what to read." };
				}
				const loaded = await loadDocument(ctx, args.file);
				if (!loaded.ok) return { error: loaded.error };
				try {
					const content = await readDocument(loaded.file, args.targets, {
						signal: ctx.abortSignal,
					});
					return { resultText: capped(content) };
				} catch (err) {
					return { error: userMessage(err) };
				}
			},
		});
	}

	if (operations.length > 0) {
		tools.push({
			name: DOC_EDIT_TOOL_NAME,
			definition: {
				type: "function",
				function: {
					name: DOC_EDIT_TOOL_NAME,
					description:
						"Change a Word, Excel or PowerPoint file with typed operations; only what they name is touched and " +
						"everything else in the file stays byte for byte. All operations apply or none do. References " +
						"(p3, t1, slide numbers) always mean the file as it is now, not as earlier operations in the same " +
						"call leave it. The result is saved as a new version of the file (the original is kept) with a " +
						"diff and a verification report. Operations, `?` marking an optional property: " +
						`${operationLines(caps).join(" | ")}.`,
					parameters: {
						type: "object",
						properties: {
							file: fileProperty,
							operations: {
								type: "array",
								description:
									"The edits, in order. Each is an object with `op` (the operation's name) and its properties.",
								items: {
									type: "object",
									properties: { op: { type: "string", enum: operations } },
									required: ["op"],
								},
							},
							...(canTrack
								? {
										track_changes: {
											type: "boolean",
											description:
												"Word only: record the edit as tracked changes the person can accept or reject.",
										},
										author: {
											type: "string",
											description:
												"Author shown on tracked changes; defaults to the person's name.",
										},
									}
								: {}),
							images: {
								type: "array",
								description:
									"Image files (PNG, JPEG or GIF) the operations use: names of images in the conversation. " +
									"An operation's `image` property is the same name.",
								items: { type: "string" },
							},
						},
						required: ["file", "operations"],
					},
				},
			},
			preprompt: SHARED_PREPROMPT,
			async execute(args, ctx) {
				const limit = countCall();
				if (limit) return { error: limit };
				if (!ctx.conversationId) return { error: "There is no conversation to save the file in." };
				if (!Array.isArray(args.operations) || args.operations.length === 0) {
					return { error: "Give `operations`: a non-empty list of edits." };
				}
				const unknown = args.operations.filter(
					(op) =>
						!op ||
						typeof op !== "object" ||
						!operations.includes(String((op as { op?: unknown }).op))
				);
				if (unknown.length > 0) {
					return {
						error: `Each operation needs an \`op\` from this list: ${operations.join(", ")}.`,
					};
				}
				const loaded = await loadDocument(ctx, args.file);
				if (!loaded.ok) return { error: loaded.error };
				const source = loaded.file;

				const images: Array<{ name: string; bytes: Buffer }> = [];
				for (const reference of Array.isArray(args.images) ? args.images : []) {
					if (typeof reference !== "string" || !reference.trim()) continue;
					const image = await findConversationFile(ctx.conversationId, reference, {
						prefer: "output",
					});
					if (!image.ok) return { error: image.error };
					images.push({ name: bareName(reference), bytes: image.bytes });
				}

				const track = canTrack && args.track_changes === true;
				const request = {
					operations: args.operations,
					...(track
						? {
								track_changes: true,
								author:
									typeof args.author === "string" && args.author.trim()
										? args.author.trim().slice(0, 120)
										: await authorFor(ctx.userId),
							}
						: {}),
				};

				let edited: EditResult;
				try {
					edited = await editDocument(source, request, images, { signal: ctx.abortSignal });
				} catch (err) {
					return { error: userMessage(err) };
				}

				const name = savedName(source);
				const stored = await storeDeliverable({
					conversationId: ctx.conversationId,
					userId: ctx.userId,
					name,
					mime: edited.content_type,
					bytes: edited.bytes,
					derivedFrom: { sha256: source.sha256, name: source.name },
				});
				if (!stored.ok) return { error: stored.error };

				if (stored.ref.sha256 === source.sha256) {
					return {
						resultText: capped({
							saved: false,
							note: "The operations left the file exactly as it was, so no new version was saved.",
							operations: edited.operations,
						}),
					};
				}
				const version = await collections.codeExecutionOutputs.countDocuments({
					conversationId: ctx.conversationId,
					name: stored.ref.name,
				});
				const diff = edited.diff.slice(0, MAX_DIFF_LINES);
				return {
					resultText: capped({
						saved: true,
						file: stored.ref.name,
						version,
						derived_from:
							source.origin === "attachment"
								? `${source.name} (the attachment)`
								: `${source.name} (previous version)`,
						note: "Saved as a new file version; the person can open and download it, and the previous one is unchanged. Refer to it by this name.",
						operations: edited.operations,
						diff,
						...(edited.diff.length > diff.length
							? { diff_truncated: edited.diff.length - diff.length }
							: {}),
						verify: verifySummary(edited.verify),
						...(edited.passed_through?.length ? { passed_through: edited.passed_through } : {}),
					}),
					extraUpdates: [
						{
							type: MessageUpdateType.CodeExecution,
							subtype: MessageCodeExecutionUpdateType.Outputs,
							runKey: `${DOC_EDIT_TOOL_NAME}:${randomUUID()}`,
							files: [stored.ref],
						},
					],
				};
			},
		});
	}

	return tools;
}
