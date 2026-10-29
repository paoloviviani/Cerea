/**
 * The client of the document service (`documents/`, ADR 0103): outline, read
 * and edit of Word, Excel and PowerPoint files over a small internal HTTP API.
 *
 * `CHAT_DOCUMENTS_URL` and `CHAT_DOCUMENTS_SECRET` say where it is and what it
 * expects; either empty means the feature is off, which every caller treats as
 * "not offered", never as an error. The service is on an internal network, so
 * this client adds only what a client can: a deadline on every call, a cap on
 * what comes back and a plain message for every way a call can fail.
 */
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";

/** A call gives up after this; the service's own wall-clock limit is shorter (30 s). */
export const DOCUMENTS_TIMEOUT_MS = 60_000;
/** The capabilities answer is reused this long. */
export const CAPABILITIES_TTL_MS = 60_000;
/** A failed capabilities call is not retried for this long (a dead service must not slow every turn). */
export const CAPABILITIES_FAILURE_TTL_MS = 15_000;
/** The largest edited file read back (the service's own cap is larger). */
export const MAX_RESULT_BYTES = 64 * 1024 * 1024;

/** What `doc_outline` and `doc_edit` take. PDF is here for its forms: it has one operation, `fill_form`, and no `doc_read`. */
export const DOCUMENT_FORMATS = ["docx", "xlsx", "pptx", "pdf"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];
/** What `doc_create` makes. */
export const CREATE_FORMATS = ["docx", "xlsx", "pptx", "pdf"] as const;
export type CreateFormat = (typeof CREATE_FORMATS)[number];

export interface FormatCapabilities {
	outline: boolean;
	read: boolean;
	operations: string[];
	/** JSON schema of each operation, by name (the single source of the tool text). */
	operation_schemas?: Record<string, JsonSchema>;
	track_changes?: boolean;
}

export type JsonSchema = {
	type?: string | string[];
	enum?: unknown[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	default?: unknown;
	pattern?: string;
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number;
	[key: string]: unknown;
};

/** The creation schemas of one format, as the service publishes them (the single source of the tool text). */
export interface CreateFormatSchemas {
	/** The document spec's top level: properties such as title, theme, blocks, sheets or slides. */
	document: JsonSchema;
	/** Block types by name (Word, PDF and the bodies of slides). */
	blocks: Record<string, JsonSchema>;
	sheet?: JsonSchema;
	slide?: JsonSchema;
}

export interface DocumentCapabilities {
	engine?: string;
	formats: Partial<Record<DocumentFormat, FormatCapabilities>>;
	/** The service can create files from a spec (`/v1/create`). */
	create?: boolean;
	create_from_template?: boolean;
	create_formats?: CreateFormat[];
	create_schemas?: Partial<Record<CreateFormat, CreateFormatSchemas>>;
	/** Pages of a PDF as images (`/v1/render`); absent on a service that predates it. */
	render?: { formats: string[]; image_types: string[] };
	/** The most pages one render call draws, and the longest side of one image (the service's own limits). */
	limits?: { max_render_pages?: number; max_render_px?: number };
}

export type DocumentsFailure =
	"unauthorized" | "too_large" | "unsupported" | "rejected" | "timeout" | "unavailable" | "failed";

/** A call that did not produce a result; `message` is safe to show a model. */
export class DocumentsError extends Error {
	constructor(
		readonly kind: DocumentsFailure,
		message: string
	) {
		super(message);
		this.name = "DocumentsError";
	}
}

/** The service's base URL without a trailing slash, or "" when it is not configured. */
export function documentsUrl(): string {
	const raw = String(config.CHAT_DOCUMENTS_URL ?? "").trim();
	if (!raw) return "";
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return "";
		return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
	} catch {
		return "";
	}
}

function documentsSecret(): string {
	return String(config.CHAT_DOCUMENTS_SECRET ?? "").trim();
}

/** Both settings present: the tools are offered (when the service also answers). */
export function isDocumentsConfigured(): boolean {
	return documentsUrl() !== "" && documentsSecret() !== "";
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
	return { "X-Cerea-Documents-Secret": documentsSecret(), ...extra };
}

let cached: { key: string; at: number; value: DocumentCapabilities | null } | undefined;

/** Forget the cached capabilities (tests, and a settings change). */
export function resetCapabilitiesCache(): void {
	cached = undefined;
}

function parseCapabilities(raw: unknown): DocumentCapabilities | null {
	if (!raw || typeof raw !== "object") return null;
	const formats = (raw as { formats?: unknown }).formats;
	if (!formats || typeof formats !== "object") return null;
	const out: DocumentCapabilities = { formats: {} };
	for (const name of DOCUMENT_FORMATS) {
		const entry = (formats as Record<string, unknown>)[name];
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		out.formats[name] = {
			outline: e.outline === true,
			read: e.read === true,
			operations: Array.isArray(e.operations)
				? e.operations.filter((op): op is string => typeof op === "string")
				: [],
			...(e.operation_schemas && typeof e.operation_schemas === "object"
				? { operation_schemas: e.operation_schemas as Record<string, JsonSchema> }
				: {}),
			track_changes: e.track_changes === true,
		};
	}
	const engine = (raw as { engine?: unknown }).engine;
	if (typeof engine === "string") out.engine = engine;
	const r = raw as Record<string, unknown>;
	out.create = r.create === true;
	out.create_from_template = r.create_from_template === true;
	if (Array.isArray(r.create_formats)) {
		out.create_formats = r.create_formats.filter((f): f is CreateFormat =>
			(CREATE_FORMATS as readonly unknown[]).includes(f)
		);
	}
	if (r.create_schemas && typeof r.create_schemas === "object") {
		out.create_schemas = r.create_schemas as DocumentCapabilities["create_schemas"];
	}
	const render = r.render;
	if (render && typeof render === "object") {
		const entry = render as Record<string, unknown>;
		const strings = (value: unknown): string[] =>
			Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
		out.render = { formats: strings(entry.formats), image_types: strings(entry.image_types) };
	}
	if (r.limits && typeof r.limits === "object") {
		const limits = r.limits as Record<string, unknown>;
		const whole = (value: unknown): number | undefined =>
			typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
		out.limits = {
			max_render_pages: whole(limits.max_render_pages),
			max_render_px: whole(limits.max_render_px),
		};
	}
	return out;
}

/**
 * What the service can do, or null when it is not configured or does not
 * answer. Cached for a minute (a quarter of that after a failure), so a turn
 * costs no call in the usual case and a dead service costs one short one.
 */
export async function getCapabilities(
	options: { signal?: AbortSignal } = {}
): Promise<DocumentCapabilities | null> {
	if (!isDocumentsConfigured()) return null;
	const key = `${documentsUrl()}|${documentsSecret()}`;
	const now = Date.now();
	if (cached && cached.key === key) {
		const ttl = cached.value ? CAPABILITIES_TTL_MS : CAPABILITIES_FAILURE_TTL_MS;
		if (now - cached.at < ttl) return cached.value;
	}
	let value: DocumentCapabilities | null = null;
	try {
		const signal = AbortSignal.timeout(5_000);
		const response = await fetch(`${documentsUrl()}/v1/capabilities`, {
			headers: headers(),
			signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
		});
		if (response.ok) {
			value = parseCapabilities(await response.json());
		} else {
			logger.warn({ status: response.status }, "documents_capabilities_refused");
		}
	} catch (err) {
		logger.warn({ err }, "documents_capabilities_unreachable");
	}
	cached = { key, at: now, value };
	return value;
}

/** What a failed call looked like on the wire. */
interface ServiceError {
	code?: string;
	message?: string;
	operation_index?: number;
	details?: Record<string, unknown>;
}

async function failure(
	response: Response,
	creating = false,
	rendering = false
): Promise<DocumentsError> {
	// A render changes nothing, so its refusals say only what was wrong.
	const untouched = rendering ? "" : creating ? "No file was made." : "Nothing was changed.";
	let error: ServiceError = {};
	const text = await response.text().catch(() => "");
	try {
		const parsed = JSON.parse(text) as { error?: ServiceError };
		if (parsed.error && typeof parsed.error === "object") error = parsed.error;
	} catch {
		// Not JSON: the status alone is what there is.
	}
	const said = (error.message ?? "").slice(0, 2000);
	const hint =
		error.details && Object.keys(error.details).length > 0
			? ` Details: ${JSON.stringify(error.details).slice(0, 1500)}`
			: "";
	switch (response.status) {
		case 401:
			logger.error({ status: 401 }, "documents_secret_rejected");
			return new DocumentsError(
				"unauthorized",
				"The document service refused the chat's credentials (the shared secret does not match). " +
					"This is a configuration problem for the administrator; nothing can be done in this conversation."
			);
		case 413:
			return new DocumentsError(
				"too_large",
				`The document or the request is too large for the document service. ${said}`.trim()
			);
		case 415:
			return new DocumentsError(
				"unsupported",
				`The document service cannot work on this file: ${said || "it is not a Word, Excel or PowerPoint file"}.`
			);
		case 422:
			return new DocumentsError(
				"rejected",
				`${said || "The document service refused the request."}${hint} ${untouched}`.trim()
			);
		case 504:
			return new DocumentsError(
				"timeout",
				`The document service took too long and stopped the work. ${untouched} ` +
					(creating
						? "Try a smaller document, fewer charts or smaller images."
						: "Try fewer operations at once, or a smaller file.")
			);
		default:
			logger.warn({ status: response.status, code: error.code }, "documents_call_failed");
			return new DocumentsError(
				"failed",
				`The document service failed (HTTP ${response.status}). ${said}`.trim()
			);
	}
}

async function call(
	route: string,
	form: FormData,
	options: { signal?: AbortSignal; accept?: string }
): Promise<Response> {
	const creating = route.startsWith("/v1/create");
	const rendering = route.startsWith("/v1/render");
	if (!isDocumentsConfigured()) {
		throw new DocumentsError("unavailable", "Document tools are not available on this deployment.");
	}
	const deadline = AbortSignal.timeout(DOCUMENTS_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(`${documentsUrl()}${route}`, {
			method: "POST",
			body: form,
			headers: headers(options.accept ? { Accept: options.accept } : {}),
			signal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline,
		});
	} catch (err) {
		if (deadline.aborted || (err instanceof Error && err.name === "TimeoutError")) {
			throw new DocumentsError(
				"timeout",
				creating
					? "The document service did not answer in time, so no file was made. " +
							"Try a smaller document, fewer charts or smaller images."
					: "The document service did not answer in time, so nothing was changed. " +
							"Try fewer operations at once, or a smaller file."
			);
		}
		if (options.signal?.aborted) throw new DocumentsError("timeout", "The call was cancelled.");
		logger.warn({ err, route }, "documents_unreachable");
		throw new DocumentsError("unavailable", "The document service is not reachable right now.");
	}
	if (!response.ok) throw await failure(response, creating, rendering);
	return response;
}

function documentForm(file: { name: string; bytes: Buffer }, body?: unknown): FormData {
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(file.bytes)]), file.name);
	if (body !== undefined) form.append("body", JSON.stringify(body));
	return form;
}

export async function outlineDocument(
	file: { name: string; bytes: Buffer },
	options: { signal?: AbortSignal } = {}
): Promise<unknown> {
	const response = await call("/v1/outline", documentForm(file), options);
	return response.json();
}

export async function readDocument(
	file: { name: string; bytes: Buffer },
	targets: unknown[],
	options: { signal?: AbortSignal } = {}
): Promise<unknown> {
	const response = await call("/v1/read", documentForm(file, { targets }), options);
	return response.json();
}

/** The file part of a JSON answer, with the size caps applied. */
async function readFile(
	response: Response,
	what: string
): Promise<{ json: Record<string, unknown>; bytes: Buffer }> {
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (declared > MAX_RESULT_BYTES * 1.4) {
		await response.body?.cancel().catch(() => undefined);
		throw new DocumentsError("too_large", `The ${what} is too large to keep.`);
	}
	const json = (await response.json()) as Record<string, unknown>;
	const base64 = json.file_base64;
	if (typeof base64 !== "string") {
		throw new DocumentsError("failed", "The document service returned no file.");
	}
	const bytes = Buffer.from(base64, "base64");
	if (bytes.byteLength > MAX_RESULT_BYTES) {
		throw new DocumentsError("too_large", `The ${what} is too large to keep.`);
	}
	return { json, bytes };
}

export interface EditResult {
	format: string;
	engine?: string;
	operations: unknown[];
	diff: string[];
	verify: Record<string, unknown> & { ok?: boolean };
	passed_through?: unknown[];
	file_name: string;
	content_type: string;
	bytes: Buffer;
}

export async function editDocument(
	file: { name: string; bytes: Buffer },
	request: { operations: unknown[]; track_changes?: boolean; author?: string },
	images: Array<{ name: string; bytes: Buffer }> = [],
	options: { signal?: AbortSignal } = {}
): Promise<EditResult> {
	const form = documentForm(file, request);
	for (const image of images) {
		form.append("image", new Blob([new Uint8Array(image.bytes)]), image.name);
	}
	const response = await call("/v1/edit", form, { ...options, accept: "application/json" });
	const { json, bytes } = await readFile(response, "edited document");
	return {
		format: String(json.format ?? ""),
		engine: typeof json.engine === "string" ? json.engine : undefined,
		operations: Array.isArray(json.operations) ? json.operations : [],
		diff: Array.isArray(json.diff) ? json.diff.map(String) : [],
		verify: (json.verify as EditResult["verify"]) ?? {},
		passed_through: Array.isArray(json.passed_through) ? json.passed_through : [],
		file_name: String(json.file_name ?? file.name),
		content_type: String(json.content_type ?? "application/octet-stream"),
		bytes,
	};
}

/** What a creation call returns about the file it made (the bytes are separate). */
export interface CreateResult {
	format: string;
	engine?: string;
	file_name: string;
	content_type: string;
	/** A short outline of what was written, with ids the edit tools take. */
	outline: unknown;
	verify: Record<string, unknown> & { ok?: boolean };
	/** One entry per chart: the type, what was asked and what was written (native or image). */
	charts: Array<Record<string, unknown>>;
	notes: string[];
	styled_from?: string;
	/** `create_from_template` only. */
	diff?: string[];
	filled?: string[];
	unfilled?: string[];
	passed_through?: unknown[];
	bytes: Buffer;
}

function createResult(
	json: Record<string, unknown>,
	bytes: Buffer,
	fallbackName: string
): CreateResult {
	const strings = (value: unknown): string[] | undefined =>
		Array.isArray(value) ? value.map(String) : undefined;
	return {
		format: String(json.format ?? ""),
		engine: typeof json.engine === "string" ? json.engine : undefined,
		file_name: String(json.file_name ?? fallbackName),
		content_type: String(json.content_type ?? "application/octet-stream"),
		outline: json.outline,
		verify: (json.verify as CreateResult["verify"]) ?? {},
		charts: Array.isArray(json.charts) ? (json.charts as Array<Record<string, unknown>>) : [],
		notes: strings(json.notes) ?? [],
		styled_from: typeof json.styled_from === "string" ? json.styled_from : undefined,
		diff: strings(json.diff),
		filled: strings(json.filled),
		unfilled: strings(json.unfilled),
		passed_through: Array.isArray(json.passed_through) ? json.passed_through : undefined,
		bytes,
	};
}

function withImages(form: FormData, images: Array<{ name: string; bytes: Buffer }>): FormData {
	for (const image of images) {
		form.append("image", new Blob([new Uint8Array(image.bytes)]), image.name);
	}
	return form;
}

/**
 * `POST /v1/create`: a new file from a document spec. `template` is the file
 * `spec.theme.template` names (styles are taken from it), sent as the `file`
 * part; it is optional.
 */
export async function createDocument(
	request: { format: CreateFormat; spec: unknown; file_name?: string },
	images: Array<{ name: string; bytes: Buffer }> = [],
	template?: { name: string; bytes: Buffer },
	options: { signal?: AbortSignal } = {}
): Promise<CreateResult> {
	const form = new FormData();
	if (template) form.append("file", new Blob([new Uint8Array(template.bytes)]), template.name);
	form.append("body", JSON.stringify(request));
	const response = await call("/v1/create", withImages(form, images), {
		...options,
		accept: "application/json",
	});
	const { json, bytes } = await readFile(response, "document");
	return createResult(json, bytes, request.file_name ?? `document.${request.format}`);
}

/** `POST /v1/create_from_template`: fill the placeholders of a template the person uploaded. */
export async function createFromTemplate(
	template: { name: string; bytes: Buffer },
	request: { values: Record<string, unknown>; file_name?: string },
	images: Array<{ name: string; bytes: Buffer }> = [],
	options: { signal?: AbortSignal } = {}
): Promise<CreateResult> {
	const response = await call(
		"/v1/create_from_template",
		withImages(documentForm(template, request), images),
		{ ...options, accept: "application/json" }
	);
	const { json, bytes } = await readFile(response, "filled document");
	return createResult(json, bytes, template.name);
}

/** One page the service drew. */
export interface RenderedPage {
	page: number;
	width: number;
	height: number;
	/** "png" or "jpeg": whichever was smaller for this page. */
	format: string;
	content_type: string;
	base64: string;
	/** With a `region`: the area really drawn (the request clamped to the page), in PDF points. */
	region?: { x: number; y: number; width: number; height: number };
	/** With a `grid`: the spacing of its lines, in points. */
	grid_step_pt?: number;
}

function isRegion(value: unknown): value is NonNullable<RenderedPage["region"]> {
	const r = value as Record<string, unknown> | null | undefined;
	return (
		!!r &&
		typeof r === "object" &&
		["x", "y", "width", "height"].every((key) => typeof r[key] === "number")
	);
}

export interface RenderResult {
	page_count: number;
	pages: RenderedPage[];
}

/**
 * `POST /v1/render`: pages of a PDF as images. `pages` are 1-based; absent means the first ones up to the
 * service's cap. Exactly one of `width_px` (pages) and `max_side_px` (slides) says the size.
 */
export async function renderPdf(
	pdf: Buffer,
	request: {
		pages?: number[];
		width_px?: number;
		max_side_px?: number;
		grid?: boolean;
		region?: { x: number; y: number; width: number; height: number };
	},
	options: { signal?: AbortSignal } = {}
): Promise<RenderResult> {
	const response = await call(
		"/v1/render",
		documentForm({ name: "document.pdf", bytes: pdf }, request),
		options
	);
	const json = (await response.json()) as {
		page_count?: unknown;
		images?: Array<Record<string, unknown>>;
	};
	if (typeof json.page_count !== "number" || !Array.isArray(json.images)) {
		throw new DocumentsError("failed", "The document service returned no pages.");
	}
	return {
		page_count: json.page_count,
		pages: json.images.map((item) => ({
			page: Number(item.page),
			width: Number(item.width),
			height: Number(item.height),
			format: String(item.format),
			content_type: String(item.content_type),
			base64: String(item.data_base64),
			...(isRegion(item.region) ? { region: item.region } : {}),
			...(typeof item.grid_step_pt === "number" ? { grid_step_pt: item.grid_step_pt } : {}),
		})),
	};
}
