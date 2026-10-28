import { randomUUID } from "node:crypto";
import { collections } from "$lib/server/database";
import {
	CREATE_FORMATS,
	DOCUMENT_FORMATS,
	DocumentsError,
	createDocument,
	createFromTemplate,
	editDocument,
	outlineDocument,
	readDocument,
	type CreateFormat,
	type CreateFormatSchemas,
	type CreateResult,
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
import type { BuiltinTool, BuiltinToolContext, BuiltinToolResult } from "./types";

export const DOC_OUTLINE_TOOL_NAME = "doc_outline";
export const DOC_READ_TOOL_NAME = "doc_read";
export const DOC_EDIT_TOOL_NAME = "doc_edit";
export const DOC_CREATE_TOOL_NAME = "doc_create";
export const DOC_CREATE_FROM_TEMPLATE_TOOL_NAME = "doc_create_from_template";

/**
 * What one turn's document tools tell each other. `doc_edit` records the slides a deck edit touched, by the
 * saved file's name, and `look_doc` shows those by default: the slides that changed are the ones worth a look.
 */
export interface DocumentTurnState {
	touchedSlides: Map<string, number[]>;
}

/** The (1-based, current) slide numbers a deck edit's operations report, in order, without repeats. */
export function slidesTouched(operations: unknown[]): number[] {
	const found: number[] = [];
	for (const operation of operations) {
		const result = (operation as { result?: Record<string, unknown> } | null)?.result;
		if (!result || typeof result !== "object") continue;
		for (const key of ["slide", "new_slide_position"] as const) {
			const value = result[key];
			if (
				typeof value === "number" &&
				Number.isInteger(value) &&
				value > 0 &&
				!found.includes(value)
			) {
				found.push(value);
			}
		}
	}
	return found.sort((a, b) => a - b);
}

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
	pdf: "PDF (.pdf)",
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

/**
 * What a model needs to know about PDF beyond the generated operation lines: a PDF has two operations and no
 * other edit; `values` says what each kind of field takes; positions are PDF points from the bottom left.
 */
function pdfNote(caps: DocumentCapabilities): string {
	const ops = caps.formats.pdf?.operations ?? [];
	if (!ops.includes("fill_form")) return "";
	const place = ops.includes("place_text");
	return (
		"A PDF has " +
		(place ? "two operations, fill_form and place_text" : "one operation, fill_form") +
		", and no other edit. Call doc_outline first (fields have `rect`, `label`, `table`); map values by " +
		"label and position, never by name order. fill_form `values`: text; true, false or the on-state for a " +
		"checkbox; one option for a radio group; an option's value or label for a list (a list for a " +
		"multi-select). Bad values are refused with what the field takes; the result lists any that did not " +
		"take. Never `flatten` unless the user asks: it is saved as <name>-flattened.pdf and the fillable file " +
		"stays. Signed and XFA PDFs cannot be filled. " +
		(place
			? "place_text writes text at positions (points from the page's bottom left; doc_outline lists " +
				"the text lines) on a PDF with no fields; refused on one with fields unless allow_on_form. "
			: "") +
		"Latin text only. "
	);
}

/** The preprompt of the document tools. place_text is named only when the service offers it. */
function sharedPreprompt(caps: DocumentCapabilities): string {
	const place = caps.formats.pdf?.operations.includes("place_text") === true;
	return (
		"Word, Excel and PowerPoint files: use doc_outline to see a file's structure, doc_read for exact content, " +
		"and doc_edit to change it. Never write code to edit a supplied Office file, and never rewrite a whole file " +
		"to change a part of it; the edit tools touch only what the operations name. Files are given by name (an " +
		"attachment, or a file you produced); an edit is saved as a new version under the same name, and the " +
		"user's original stays as it was. To fill a PDF form, doc_outline lists its fields and doc_edit fill_form " +
		"fills them; " +
		(place ? "to write on a PDF without fields, doc_edit place_text; " : "") +
		"never fill a form in the sandbox."
	);
}

const CREATE_LABEL: Record<CreateFormat, string> = FORMAT_LABEL;

/** Shared definitions printed once and referred to by name (the theme, a text run, a table cell). */
type Aliases = Map<string, string>;

/** Text of a JSON schema, `depth` levels of object properties deep: `{level: 1|2, text?: string}`. */
export function describeSchema(
	schema: JsonSchema | undefined,
	depth = 2,
	aliases?: Aliases
): string {
	if (!schema) return "any";
	const alias = aliases?.get(JSON.stringify(schema));
	if (alias) return alias;
	if (typeof schema.$ref === "string") return schema.$ref.split("/").pop() ?? "any";
	if ("const" in schema) return JSON.stringify(schema.const);
	if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join("|");
	if (Array.isArray(schema.anyOf)) {
		return (schema.anyOf as JsonSchema[]).map((s) => describeSchema(s, depth, aliases)).join(" | ");
	}
	const type = Array.isArray(schema.type) ? schema.type.join("|") : schema.type;
	if (type === "array") {
		const inner = describeSchema(schema.items, depth, aliases);
		return /[ |]/.test(inner) && !inner.startsWith("{") ? `(${inner})[]` : `${inner}[]`;
	}
	if (type === "object" && schema.properties) {
		if (depth <= 0) return "object";
		return `{${propertyList(schema, depth - 1, true, aliases)}}`;
	}
	return type ?? "any";
}

function propertyList(
	schema: JsonSchema,
	depth: number,
	notes: boolean,
	aliases?: Aliases
): string {
	const required = new Set(schema.required ?? []);
	return Object.entries(schema.properties ?? {})
		.filter(([key]) => key !== "type")
		.map(([key, value]) => {
			const hint =
				notes &&
				typeof value.description === "string" &&
				value.description.length <= 110 &&
				!aliases?.has(JSON.stringify(value))
					? ` (${value.description})`
					: "";
			return `${key}${required.has(key) ? "" : "?"}: ${describeSchema(value, depth, aliases)}${hint}`;
		})
		.join(", ");
}

/** A block as `table{header?: string[], rows: ...}`; the block's name is its `type`. */
export function describeBlock(name: string, schema: JsonSchema, aliases?: Aliases): string {
	return `${name}{${propertyList(schema, 2, true, aliases)}}`;
}

/** The pieces that recur across blocks and formats, found in the schemas themselves. */
function sharedAliases(schemas: Partial<Record<CreateFormat, CreateFormatSchemas>>): {
	aliases: Aliases;
	legend: string[];
} {
	const aliases: Aliases = new Map();
	const legend: string[] = [];
	const first = Object.values(schemas)[0];
	const define = (name: string, schema: JsonSchema | undefined, depth: number) => {
		if (!schema) return;
		legend.push(`${name} = ${describeSchema(schema, depth, aliases)}`);
		aliases.set(JSON.stringify(schema), name);
	};
	// a hex colour appears dozens of times: written once
	const hex = first?.document.properties?.theme?.properties?.accent;
	if (hex) {
		legend.push("Hex = hex colour string such as 1F3864");
		aliases.set(JSON.stringify(hex), "Hex");
	}
	define("Theme", first?.document.properties?.theme, 3);
	const slide = schemas.pptx?.slide;
	define("Background", slide?.properties?.background, 2);
	const deck = schemas.pptx?.document.properties?.theme;
	const base = first?.document.properties?.theme;
	if (deck && base && JSON.stringify(deck) !== JSON.stringify(base)) {
		// the deck's theme is the shared one plus what only decks have
		const extra = Object.fromEntries(
			Object.entries(deck.properties ?? {}).filter(([key]) => !(key in (base.properties ?? {})))
		);
		legend.push(
			`PptxTheme = Theme plus {${propertyList({ properties: extra }, 2, true, aliases)}}`
		);
		aliases.set(JSON.stringify(deck), "PptxTheme");
	}
	const paragraph = first?.blocks.paragraph;
	define("Run", paragraph?.properties?.runs?.items, 1);
	const rows = first?.blocks.table?.properties?.rows;
	define("Cell", rows?.items?.items, 2);
	const item = Object.values(first?.blocks ?? {}).find((b) => b.$defs)?.$defs as
		Record<string, JsonSchema> | undefined;
	if (item?.item) legend.push(`item = ${describeSchema(item.item, 2, aliases)}`);
	return { aliases, legend };
}

/** The spec of one format as the model reads it, generated from the service's schemas. */
function describeCreateFormat(
	format: CreateFormat,
	entry: CreateFormatSchemas,
	aliases: Aliases
): string {
	const lines = [`spec: {${propertyList(entry.document, 2, true, aliases)}}`];
	const blocks = Object.entries(entry.blocks).map(([name, schema]) =>
		describeBlock(name, schema, aliases)
	);
	if (blocks.length > 0) {
		lines.push(
			`${format === "pptx" ? "Slide body blocks" : "Blocks"} (each an object whose \`type\` is the name): ${blocks.join("; ")}`
		);
	}
	if (entry.sheet) lines.push(`A sheet: {${propertyList(entry.sheet, 3, true, aliases)}}`);
	if (entry.slide) lines.push(`A slide: {${propertyList(entry.slide, 3, true, aliases)}}`);
	return lines.join("\n");
}

/** Names and spec text for `doc_create`, from `create_schemas`. */
export function createToolText(caps: DocumentCapabilities): {
	formats: CreateFormat[];
	body: string;
} {
	const schemas = caps.create_schemas ?? {};
	const formats = (caps.create_formats ?? CREATE_FORMATS).filter(
		(f): f is CreateFormat => !!schemas[f]
	);
	const { aliases, legend } = sharedAliases(schemas);
	const seen = new Map<string, CreateFormat>();
	const per = formats.map((f) => {
		const text = describeCreateFormat(f, schemas[f] as CreateFormatSchemas, aliases);
		const same = seen.get(text);
		seen.set(text, same ?? f);
		return same
			? `${CREATE_LABEL[f]}: the same spec and blocks as ${CREATE_LABEL[same]}` +
					(f === "pdf" ? "; charts are always images and theme.template is not available." : ".")
			: `${CREATE_LABEL[f]} ${text}`;
	});
	return { formats, body: [...per, ...legend].join("\n") };
}

/** A safe file name for a created file: letters, digits, dots, dashes, spaces, with the right extension. */
export function createdName(requested: unknown, title: unknown, format: string): string {
	const raw = typeof requested === "string" && requested.trim() ? requested : String(title ?? "");
	// eslint-disable-next-line no-control-regex -- control bytes are valid filename attacks
	const clean = raw.replace(/[\u0000-\u001f]/g, "").trim();
	const stem = (clean.split(/[\\/]/).pop() ?? "")
		.replace(/\.[A-Za-z0-9]{1,5}$/, "")
		.replace(/[\\/:*?"<>|]+/g, "-")
		.replace(/^\.+/, "")
		.slice(0, 120)
		.trim();
	return `${stem || "document"}.${format}`;
}

const SHARED_CREATE_PREPROMPT =
	"To make a NEW Word, Excel, PowerPoint or PDF file, use doc_create (or doc_create_from_template for a " +
	"template the person uploaded). These tools are the only way to create documents here: the service builds, " +
	"checks and saves the file, and you never write code for a document or handle its bytes. Charts and images " +
	"go inside the spec (a chart is a chart block; an image you made in the sandbox is passed by name). Say in " +
	"a line what the file contains and anything you could not do.";

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

type LoadedImages =
	{ ok: true; images: Array<{ name: string; bytes: Buffer }> } | { ok: false; error: string };

/** The image files a call names: attachments, files produced earlier, sandbox outputs. */
async function loadImages(
	conversationId: NonNullable<BuiltinToolContext["conversationId"]>,
	references: unknown
): Promise<LoadedImages> {
	const images: Array<{ name: string; bytes: Buffer }> = [];
	for (const reference of Array.isArray(references) ? references : []) {
		if (typeof reference !== "string" || !reference.trim()) continue;
		const image = await findConversationFile(conversationId, reference, { prefer: "output" });
		if (!image.ok) return { ok: false, error: image.error };
		images.push({ name: bareName(reference), bytes: image.bytes });
	}
	return { ok: true, images };
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
		...pick("fields_checked"),
		...pick("filled"),
		...pick("not_taken"),
		...pick("flattened"),
		...pick("items_checked"),
		...pick("found_at_position"),
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
 * A flattened PDF is a copy: the service says so (`save_as_suffix` on the operation's result) and the file is
 * saved as `<name>-flattened.pdf`, leaving the fillable file as it was.
 */
function savedSuffix(edited: EditResult): string {
	for (const operation of edited.operations ?? []) {
		const result = (operation as { result?: { save_as_suffix?: unknown } }).result;
		if (typeof result?.save_as_suffix === "string" && /^[-\w]{1,20}$/.test(result.save_as_suffix)) {
			return result.save_as_suffix;
		}
	}
	return "";
}

function withSuffix(name: string, suffix: string): string {
	if (!suffix) return name;
	const dot = name.lastIndexOf(".");
	return dot > 0 ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}` : `${name}${suffix}`;
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
	caps: DocumentCapabilities | null | undefined,
	turn?: DocumentTurnState
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
			"Name of a Word, Excel, PowerPoint or PDF file in the conversation: an attachment or a file you " +
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
						"The structure of a Word, Excel, PowerPoint or PDF file with stable ids and short text previews: " +
						"Word paragraphs (p1...), tables (t1...) and images; Excel sheets, used ranges, tables and charts; " +
						"PowerPoint slides, shapes, placeholders, images and notes; a PDF's pages (size and text lines with " +
						"positions) and, when it has a form, its fields (name, type, page, current value, allowed values, " +
						"flags, rect, label, table). PDF positions are points, origin at the page's bottom left. " +
						"Call it first; the ids it " +
						"gives are what doc_read and doc_edit take.",
					parameters: {
						type: "object",
						properties: { file: fileProperty },
						required: ["file"],
					},
				},
			},
			preprompt: sharedPreprompt(caps),
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
			preprompt: canOutline ? undefined : sharedPreprompt(caps),
			async execute(args, ctx) {
				const limit = countCall();
				if (limit) return { error: limit };
				if (!Array.isArray(args.targets) || args.targets.length === 0) {
					return { error: "Give `targets`: a non-empty list of what to read." };
				}
				const loaded = await loadDocument(ctx, args.file);
				if (!loaded.ok) return { error: loaded.error };
				if (/\.pdf$/i.test(loaded.file.name)) {
					return {
						error:
							"doc_read does not apply to a PDF: doc_outline lists its pages and form fields, and its text " +
							"is already in the conversation.",
					};
				}
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
						"Change a Word, Excel, PowerPoint or PDF file with typed operations; only what they name is touched and " +
						"everything else in the file stays byte for byte. All operations apply or none do. References " +
						"(p3, t1, slide numbers) always mean the file as it is now, not as earlier operations in the same " +
						"call leave it. The result is saved as a new version of the file (the original is kept) with a " +
						"diff and a verification report. " +
						pdfNote(caps) +
						"Operations, `?` marking an optional property: " +
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
			preprompt: sharedPreprompt(caps),
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

				const imageList = await loadImages(ctx.conversationId, args.images);
				if (!imageList.ok) return { error: imageList.error };
				const images = imageList.images;

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

				const name = withSuffix(savedName(source), savedSuffix(edited));
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
				if (turn && edited.format === "pptx") {
					const slides = slidesTouched(edited.operations);
					// An edit that reports no slides (replace_text, reorder) leaves nothing known to be touched,
					// and an older edit's slide numbers may no longer mean the same slides.
					if (slides.length > 0) turn.touchedSlides.set(stored.ref.name, slides);
					else turn.touchedSlides.delete(stored.ref.name);
				}
				return {
					resultText: capped({
						saved: true,
						file: stored.ref.name,
						version,
						derived_from:
							source.origin === "attachment"
								? `${source.name} (the attachment)`
								: `${source.name} (previous version)`,
						note: savedSuffix(edited)
							? `Saved as a separate file; ${source.name} is unchanged and still the fillable form. Refer to the new file by this name.`
							: "Saved as a new file version; the person can open and download it, and the previous one is unchanged. Refer to it by this name.",
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

	let createOffered = false;
	if (caps.create === true && caps.create_schemas) {
		const { formats: createFormats, body: specText } = createToolText(caps);
		if (createFormats.length > 0) {
			createOffered = true;
			tools.push({
				name: DOC_CREATE_TOOL_NAME,
				definition: {
					type: "function",
					function: {
						name: DOC_CREATE_TOOL_NAME,
						description:
							"Create a NEW Word, Excel, PowerPoint or PDF file from a document spec. The service builds it, " +
							"checks that it opens, and saves it as a file the person can open and download; you never write " +
							"code for it. All or nothing: a spec problem comes back as a message naming what is allowed. " +
							"A neutral built-in style is used; set `theme` only for what the person asked (fonts from the " +
							"list, hex colours, sizes, spacing, table style, accent). `theme.template` names a Word, Excel " +
							"or PowerPoint file the person uploaded in this conversation, whose styles, master or named " +
							'styles are then used. A chart block says `render`: "native" (editable in Office, the default) ' +
							'or "image" (a PNG); PDF charts are always images, and the result says what was written. ' +
							"Images are files in the conversation (an attachment, a file you made earlier, an image saved " +
							"to /mnt/output): list them in `images` and name them the same way in image blocks. Word and " +
							"PDF also take `markdown` instead of `blocks` (headings, lists, tables, **bold**, links, code; no " +
							"HTML). A slide may have a `background` (an image is a file in the conversation) and free `shapes` " +
							"(cm on the slide, kept inside it, text 8 pt or more): for designed slides on the blank or " +
							"title_only layout, not for ordinary text. The result gives the file's name, an outline and the charts' render; to change the file " +
							"afterwards use doc_edit with that name. Formats and their specs, `?` marking an optional property:\n" +
							specText,
						parameters: {
							type: "object",
							properties: {
								format: {
									type: "string",
									enum: createFormats,
									description: "The kind of file to create.",
								},
								spec: {
									type: "object",
									description: "The document spec for that format, as described above.",
								},
								file_name: {
									type: "string",
									description:
										"Name of the file, e.g. report.docx. Defaults to the spec's title. Using a name that already " +
										"exists saves a new version of that file.",
								},
								images: {
									type: "array",
									description:
										"Image files (PNG, JPEG or GIF) the spec uses: names of images in the conversation. " +
										"An image's `image` property is the same name.",
									items: { type: "string" },
								},
							},
							required: ["format", "spec"],
						},
					},
				},
				preprompt: SHARED_CREATE_PREPROMPT,
				async execute(args, ctx) {
					const limit = countCall();
					if (limit) return { error: limit };
					if (!ctx.conversationId)
						return { error: "There is no conversation to save the file in." };
					const format = String(args.format ?? "");
					if (!(createFormats as string[]).includes(format)) {
						return { error: `\`format\` must be one of: ${createFormats.join(", ")}.` };
					}
					if (!args.spec || typeof args.spec !== "object" || Array.isArray(args.spec)) {
						return { error: "Give `spec`: the document spec, an object." };
					}
					const spec = JSON.parse(JSON.stringify(args.spec)) as Record<string, unknown>;

					// A template the person uploaded: its bytes travel with the request.
					let template: { name: string; bytes: Buffer; sha256: string } | undefined;
					const theme = spec.theme as Record<string, unknown> | undefined;
					if (theme && typeof theme === "object" && theme.template !== undefined) {
						const loaded = await loadDocument(ctx, theme.template);
						if (!loaded.ok) return { error: `theme.template: ${loaded.error}` };
						const name = bareName(String(theme.template)).split("/").pop() ?? "template";
						theme.template = name;
						template = { name, bytes: loaded.file.bytes, sha256: loaded.file.sha256 };
					}

					const imageList = await loadImages(ctx.conversationId, args.images);
					if (!imageList.ok) return { error: imageList.error };

					let made: CreateResult;
					try {
						made = await createDocument(
							{ format: format as CreateFormat, spec },
							imageList.images,
							template,
							{ signal: ctx.abortSignal }
						);
					} catch (err) {
						return { error: userMessage(err) };
					}
					return saveCreated(ctx, made, {
						name: createdName(args.file_name, spec.title, format),
						derivedFrom: template ? { sha256: template.sha256, name: template.name } : undefined,
						runKey: DOC_CREATE_TOOL_NAME,
						canEdit: operations.length > 0,
						turn,
					});
				},
			});
		}
	}

	if (caps.create_from_template === true) {
		tools.push({
			name: DOC_CREATE_FROM_TEMPLATE_TOOL_NAME,
			definition: {
				type: "function",
				function: {
					name: DOC_CREATE_FROM_TEMPLATE_TOOL_NAME,
					description:
						"Fill a template the person uploaded in this conversation and save the result as a NEW file (the " +
						"template is kept). Word: {{name}} placeholders in the body, tables, headers and footers. PowerPoint: " +
						"{{name}} in text boxes, placeholders and notes. Excel: cells with {{name}} (a cell holding only the " +
						"placeholder keeps the value's type: number, date, boolean) and named ranges. `values` maps each " +
						"placeholder name to its value: text, a number or a boolean; `{image, width_cm?, alt?}` where a " +
						"paragraph, shape or cell holds only that placeholder, to put a picture there; and, for an Excel " +
						"named range, a list (one value per cell). Every key must exist in the template: an unknown one " +
						"fails the whole call and lists the placeholders that do exist. Placeholders you give no value " +
						"are left as they are and listed as `unfilled`. Use doc_outline on the template first to see them " +
						"(Word and PowerPoint outlines list them). Macro-enabled templates are refused.",
					parameters: {
						type: "object",
						properties: {
							template: {
								type: "string",
								description:
									"Name of the template file in the conversation (an attachment or a file you produced), e.g. invoice.docx.",
							},
							values: {
								type: "object",
								description:
									'Placeholder name to value, e.g. {"client": "Beta plc", "total": 1250.5, "logo": {"image": "logo.png"}}.',
							},
							file_name: {
								type: "string",
								description: "Name of the new file. Defaults to the template's name with -filled.",
							},
							images: {
								type: "array",
								description:
									"Image files (PNG, JPEG or GIF) the values use: names of images in the conversation.",
								items: { type: "string" },
							},
						},
						required: ["template", "values"],
					},
				},
			},
			preprompt: createOffered ? undefined : SHARED_CREATE_PREPROMPT,
			async execute(args, ctx) {
				const limit = countCall();
				if (limit) return { error: limit };
				if (!ctx.conversationId) return { error: "There is no conversation to save the file in." };
				if (!args.values || typeof args.values !== "object" || Array.isArray(args.values)) {
					return { error: "Give `values`: an object mapping each placeholder name to its value." };
				}
				if (Object.keys(args.values).length === 0) {
					return { error: "`values` is empty: give at least one placeholder." };
				}
				const loaded = await loadDocument(ctx, args.template);
				if (!loaded.ok) return { error: loaded.error };
				const source = loaded.file;
				const imageList = await loadImages(ctx.conversationId, args.images);
				if (!imageList.ok) return { error: imageList.error };

				const base = savedName(source);
				let made: CreateResult;
				try {
					made = await createFromTemplate(
						{ name: base, bytes: source.bytes },
						{ values: args.values as Record<string, unknown> },
						imageList.images,
						{ signal: ctx.abortSignal }
					);
				} catch (err) {
					return { error: userMessage(err) };
				}
				const dot = base.lastIndexOf(".");
				const fallback =
					dot > 0 ? `${base.slice(0, dot)}-filled${base.slice(dot)}` : `${base}-filled`;
				return saveCreated(ctx, made, {
					name: createdName(args.file_name, fallback, made.format || "docx"),
					derivedFrom: { sha256: source.sha256, name: source.name },
					runKey: DOC_CREATE_FROM_TEMPLATE_TOOL_NAME,
					canEdit: operations.length > 0,
					turn,
				});
			},
		});
	}

	return tools;
}

/** Store a created file as a deliverable and answer with what the model needs to continue. */
async function saveCreated(
	ctx: BuiltinToolContext,
	made: CreateResult,
	options: {
		name: string;
		derivedFrom?: { sha256: string; name: string };
		runKey: string;
		canEdit: boolean;
		turn?: DocumentTurnState;
	}
): Promise<BuiltinToolResult> {
	if (!ctx.conversationId) return { error: "There is no conversation to save the file in." };
	const stored = await storeDeliverable({
		conversationId: ctx.conversationId,
		userId: ctx.userId,
		name: options.name,
		mime: made.content_type,
		bytes: made.bytes,
		derivedFrom: options.derivedFrom,
	});
	if (!stored.ok) return { error: stored.error };
	options.turn?.touchedSlides.delete(stored.ref.name); // a new file: every slide is new
	const version = await collections.codeExecutionOutputs.countDocuments({
		conversationId: ctx.conversationId,
		name: stored.ref.name,
	});
	const diff = (made.diff ?? []).slice(0, MAX_DIFF_LINES);
	return {
		resultText: capped({
			saved: true,
			file: stored.ref.name,
			version,
			format: made.format,
			styled_from: made.styled_from,
			note:
				"Saved as a file the person can open and download; refer to it by this name." +
				(options.canEdit ? " To change it later use doc_edit with this name." : ""),
			outline: made.outline,
			...(made.charts.length > 0 ? { charts: made.charts } : {}),
			...(made.notes.length > 0 ? { notes: made.notes } : {}),
			...(made.filled ? { filled: made.filled } : {}),
			...(made.unfilled && made.unfilled.length > 0
				? {
						unfilled: made.unfilled,
						unfilled_note: "These placeholders got no value and remain in the file.",
					}
				: {}),
			...(diff.length > 0 ? { diff } : {}),
			verify: verifySummary(made.verify as EditResult["verify"]),
			...(made.passed_through?.length ? { passed_through: made.passed_through } : {}),
		}),
		extraUpdates: [
			{
				type: MessageUpdateType.CodeExecution,
				subtype: MessageCodeExecutionUpdateType.Outputs,
				runKey: `${options.runKey}:${randomUUID()}`,
				files: [stored.ref],
			},
		],
	};
}
