/**
 * Turning an attached document into text, once.
 *
 * A PDF or a `.docx` attached to a message is bytes the model cannot read.
 * `POST /v1/ocr` turns it into markdown — metered by the page, with either
 * this deployment's own extractor or an upstream OCR model depending on which
 * model is named (ADR 0055) — normally through the gateway, as the calling
 * user.
 *
 * **A deployment with no gateway at all reads documents by calling an OCR
 * endpoint directly instead** (`CHAT_OCR_BASE_URL`, `CHAT_OCR_API_KEY`,
 * `CHAT_OCR_MODEL`) — the "generic" profile's one functional gap otherwise,
 * since `/v1/ocr` is the one Pystino-specific limb in the whole document
 * path. The wire shape is unchanged either way (Mistral's and Cortecs' `/ocr`
 * already matches what the gateway forwards), so this is a routing and
 * configuration decision, not a protocol one: `CHAT_OCR_BASE_URL` set means
 * go direct, with `CHAT_OCR_MODEL` naming the model to send — there is no
 * catalogue to discover one from without a gateway, so it is required
 * whenever a base URL is set, checked at boot (`assertOcrConfigValid`) rather
 * than on somebody's first upload. Set deliberately, a direct endpoint
 * **overrides** the gateway path even where one would otherwise resolve: an
 * operator who names an endpoint means it, rather than "try this only when
 * nothing else works."
 *
 * **It runs at upload and its result is stored.** That is the whole design
 * decision here, and it is a billing decision rather than a performance one:
 * extraction is priced per page, so re-extracting on every turn would charge
 * for the same twelve-page PDF again on the second question about it, and
 * again on the third. Once per file, kept beside the file.
 *
 * Which model does it, in order (`resolveExtractor`,
 * `./knowledge/extractorResolution.ts` — the one place this is decided, so
 * the Knowledge screen's picker and this path can never disagree): a
 * configured direct endpoint (see above), else `CHAT_OCR_MODEL` naming a
 * model in the ordinary catalogue, else the Knowledge screen's stored
 * choice, else this deployment's own local extractor when the gateway has
 * one (`?include=ocr`'s `local: true`), else the first model the caller may
 * use whose `kind` is `ocr`. There is deliberately no stored value that
 * means "extract nothing": an unset choice is the deployment default, so a
 * save that never touched extraction can never turn it off, and with no
 * reader anywhere the reason comes back spelled out rather than as a silent
 * absence of text.
 *
 * **That choice is for PDFs and images only.** An upstream OCR model reads
 * page images; nobody has shown one reading `.docx`/`.xlsx`/`.pptx`, and a
 * Word file sent to one comes back as an opaque refusal or as nothing. Every
 * other format goes to this deployment's *local* reader (the gateway's
 * `local: true` model) whichever model is selected for PDFs, and with no local
 * reader the document fails with a reason saying so — it is never sent to an
 * OCR model in the hope that it copes (`resolveOfficeReader`, docs/knowledge.md).
 */

import type { ExtractionFailureKind } from "$lib/types/Message";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { gateway, GatewayCallFailed } from "$lib/server/gatewayServer";
import { readConfig } from "$lib/server/knowledge/service";
import {
	resolveExtractor,
	type ExtractorCandidate,
} from "$lib/server/knowledge/extractorResolution";

/** Document types worth sending to an extractor. Images go the vision route. */
export const DOCUMENT_MIME_ALLOWLIST = [
	"application/pdf",
	"application/msword",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.ms-powerpoint",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/vnd.oasis.opendocument.text",
	"application/vnd.oasis.opendocument.spreadsheet",
	"application/vnd.oasis.opendocument.presentation",
	"application/epub+zip",
] as const;

export function isExtractableDocument(mime: string): boolean {
	return (DOCUMENT_MIME_ALLOWLIST as readonly string[]).includes(mime);
}

/**
 * Formats an OCR model reads: page images. Everything else extractable is an
 * Office-style container and goes to the local reader instead.
 */
function isOcrNative(mime: string): boolean {
	return mime === "application/pdf" || mime.startsWith("image/");
}

/** What a file's extension says it is, for the containers whose bytes do not say it themselves. */
const EXTENSION_MIME: Record<string, string> = {
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	odt: "application/vnd.oasis.opendocument.text",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
	odp: "application/vnd.oasis.opendocument.presentation",
	epub: "application/epub+zip",
};

/** Which of those a legacy compound file (CFB) can be: the binary Office generations. */
const CFB_EXTENSIONS = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx"]);
/** Which a plain zip can be: the zipped formats. */
const ZIP_EXTENSIONS = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp", "epub"]);

/**
 * The document type to treat an upload as, given what its bytes sniffed as.
 *
 * `file-type` calls a legacy binary Office file `application/x-cfb` (a
 * `.doc`, a `.xls`, and equally a `.msi`) and an Office Open XML file it
 * cannot place `application/zip`. Neither is in the allowlist, so a legacy
 * `.doc` saved with a `.docx` name used to skip extraction without a word. A
 * compound or zip container whose *name* says Office is a candidate: it goes
 * to the reader under the type the name implies, and the reader — which can
 * read the magic bytes — decides, and says why when it refuses. Anything else
 * keeps its sniffed type.
 */
export function documentMime(sniffed: string, filename: string): string {
	if (isExtractableDocument(sniffed)) return sniffed;
	const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
	if (sniffed === "application/x-cfb" && CFB_EXTENSIONS.has(ext)) {
		// A `.docx` name on a compound file is a legacy file under the wrong name,
		// so the type is the binary generation, not the one the name claims.
		return EXTENSION_MIME[ext.slice(0, 3)];
	}
	if (sniffed === "application/zip" && ZIP_EXTENSIONS.has(ext)) return EXTENSION_MIME[ext];
	return sniffed;
}

/**
 * What a direct endpoint (no gateway in front of it) is known to read.
 *
 * Narrower than the gateway allowlist above, deliberately: Mistral's and
 * Cortecs' published OCR schemas document PDF and image inputs, not Office
 * formats, and OpenWebUI — which ships this same direct-to-vendor route —
 * sends only `.pdf` to Mistral's OCR API and routes every other format
 * through its own built-in loaders (unstructured/tika/docling), which this
 * deployment does not have. There is no evidence either vendor reads
 * `.docx`/`.xlsx`/`.pptx`/`.odt`/`.epub`, and no way to call either service
 * here to find out, so direct mode does not attempt them — an unsupported
 * type gets the spelled-out reason below rather than a raw provider error.
 */
const DIRECT_OCR_MIME_ALLOWLIST = ["application/pdf"] as const;

/**
 * A base64 `data:` URI of the document goes in the request body's JSON, and
 * nobody has size-tested that against Mistral's or Cortecs' actual limits —
 * OpenWebUI avoids the question by uploading the file first, which this
 * deployment deliberately does not implement (a much bigger job: Mistral's
 * `/v1/files` plus signed URLs, not part of the shared `/ocr` shape). Chat
 * attachments are already capped at 10 MB before reaching here
 * (`routes/conversation/[id]/+server.ts`), but a knowledge-base upload allows
 * up to `MAX_UPLOAD_BYTES` (20 MB) — base64 inflates that to a ~27 MB JSON
 * body, well past what many API gateways and load balancers accept without
 * special configuration. Capping direct mode at the same 10 MB this app
 * already treats as its safe raw-attachment ceiling keeps the encoded body
 * under ~13.3 MB, comfortably inside the common range, and turns an
 * oversized document into this module's own actionable message instead of an
 * opaque 413 from a third party.
 */
const DIRECT_OCR_MAX_BYTES = 10 * 1024 * 1024;

interface OcrPage {
	/** 0-based page number. */
	index?: number;
	markdown?: string;
}

interface OcrResponse {
	pages?: OcrPage[];
	usage_info?: { pages_processed?: number };
	/**
	 * Only when asked for, and only for a PDF with pages that have no text of
	 * their own: those pages, rendered (1-based `page`). The other pages come
	 * back as text in `pages`, as they always have.
	 */
	page_images?: { page?: number; mime?: string; data?: string }[];
	page_count?: number;
	/** More pages needed an image than the request allowed. */
	truncated?: boolean;
}

/** Page images asked for per PDF when `CHAT_PDF_IMAGE_PAGES` is unset. */
export const PDF_IMAGE_PAGES_DEFAULT = 20;
/** The gateway clamps the request to this; asking for more would only be refused. */
const PDF_IMAGE_PAGES_CEILING = 50;
/** Long side, in pixels, of a rendered page; the gateway clamps it to 2048. */
export const PAGE_IMAGE_LONG_SIDE = 1280;
/** What one rendered page may weigh, decoded. The reader caps the total; this is the belt. */
const PAGE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const PAGE_IMAGE_MIMES = new Set(["image/jpeg", "image/png"]);

/**
 * How many image pages to ask the local reader for: `CHAT_PDF_IMAGE_PAGES`,
 * 20 when unset or unreadable, and 0 — off, the old behaviour — when set to 0.
 */
export function pdfImagePageLimit(): number {
	const raw = config.CHAT_PDF_IMAGE_PAGES?.toString().trim();
	if (!raw) return PDF_IMAGE_PAGES_DEFAULT;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) return PDF_IMAGE_PAGES_DEFAULT;
	return Math.min(n, PDF_IMAGE_PAGES_CEILING);
}

/**
 * Marks where a page the reader rendered as an image sits in the page-ordered
 * text. Stored as is and worded at send time (`preprocessMessages`), because
 * what to say depends on the model that turn: "attached as an image" is true
 * for one that sees images and false for one that does not.
 */
export const SCAN_PAGE_MARKER = /\[\[cerea:scan-page:(\d+)\]\]/g;
const scanPageMarker = (page: number) => `[[cerea:scan-page:${page}]]`;

/** The image pages of a PDF, rendered by the local reader. */
export interface ScannedPages {
	images: { page: number; mime: string; bytes: Buffer }[];
	pageCount: number;
	/** Image pages the PDF has in all: those attached, plus any past the limit. */
	scannedTotal: number;
	truncated: boolean;
}

/**
 * A PDF with some pages that are pictures, put back in page order.
 *
 * The reader answers per page: a page with real text comes back as text in
 * `pages` (0-based `index`), one without as an image in `page_images`
 * (1-based `page`). This walks the pages in order and writes the text where a
 * page has it, a marker where it has an image, and a plain sentence where it
 * has neither — a scan page past the reader's limit, which nobody read. Null
 * when there are no usable images, so a response that is only text, or only
 * nothing, goes the ordinary way.
 *
 * Read defensively — this is another service's output: only well-formed
 * images, at most `limit`, each page once.
 */
function composePages(
	answer: OcrResponse,
	limit: number
): { text: string; scan: ScannedPages } | null {
	const images = new Map<number, ScannedPages["images"][number]>();
	for (const entry of answer.page_images ?? []) {
		if (images.size >= limit) break;
		const page = entry?.page;
		if (!Number.isInteger(page) || (page as number) < 1 || images.has(page as number)) continue;
		if (typeof entry.data !== "string" || !PAGE_IMAGE_MIMES.has(entry.mime ?? "")) continue;
		const bytes = Buffer.from(entry.data, "base64");
		if (bytes.length === 0 || bytes.length > PAGE_IMAGE_MAX_BYTES) continue;
		images.set(page as number, { page: page as number, mime: entry.mime as string, bytes });
	}
	if (images.size === 0) return null;

	const textByPage = new Map<number, string>();
	for (const [position, page] of (answer.pages ?? []).entries()) {
		const markdown = page.markdown ?? "";
		const index = Number.isInteger(page.index) ? (page.index as number) : position;
		if (markdown.trim() && !images.has(index + 1)) textByPage.set(index + 1, markdown);
	}
	const pageCount = Math.max(
		answer.page_count ?? 0,
		(answer.pages ?? []).length,
		...images.keys(),
		...textByPage.keys()
	);

	const parts: string[] = [];
	let unread = 0;
	for (let page = 1; page <= pageCount; page += 1) {
		const text = textByPage.get(page);
		if (text !== undefined) parts.push(text);
		else if (images.has(page)) parts.push(scanPageMarker(page));
		else {
			unread += 1;
			parts.push(
				`Page ${page} is a scan that was not read: it is past the limit of ${limit} image pages.`
			);
		}
	}
	const sorted = [...images.values()].sort((a, b) => a.page - b.page);
	return {
		text: parts.join("\n\n"),
		scan: {
			images: sorted,
			pageCount,
			scannedTotal: sorted.length + unread,
			truncated: answer.truncated === true || unread > 0,
		},
	};
}

interface ModelCard {
	id: string;
	kind?: string;
	/** This deployment's own infrastructure (the local extractor), per
	 * Pystino's `?include=ocr`. Absent on an older gateway. */
	local?: boolean;
}

export interface Extracted {
	text: string;
	pages: number;
}

/** The direct endpoint's base URL, trimmed, or undefined when unset — the one switch between routes. */
function directOcrBaseUrl(): string | undefined {
	return config.CHAT_OCR_BASE_URL?.trim() || undefined;
}

/**
 * Fails at boot, not at somebody's first upload: a direct endpoint has no
 * catalogue to discover a reader model from, so a missing `CHAT_OCR_MODEL`
 * would otherwise surface as a 503 on the first attachment instead of at
 * startup, where a misconfiguration belongs. Called once from `initServer`.
 */
export function assertOcrConfigValid(): void {
	if (directOcrBaseUrl() && !config.CHAT_OCR_MODEL?.trim()) {
		throw new Error(
			'CHAT_OCR_BASE_URL is set but CHAT_OCR_MODEL is not. A direct OCR endpoint has no catalogue to discover a reader model from — set CHAT_OCR_MODEL to the model name it expects (e.g. "mistral-ocr-latest").'
		);
	}
}

/**
 * A provider-side failure (429, 5xx), named rather than paraphrased as "not
 * available" — the reader is configured and reachable, its upstream just
 * refused this call, and the model name is what an administrator needs to
 * act on it (a different reader, or a quota to raise).
 */
function readerFailureReason(status: number, model: string): string {
	if (status === 429) return `The document reader ${model} is rate-limited by its provider.`;
	return `The document reader ${model} is unavailable right now — its provider answered ${status}.`;
}

/** The text of an OCR response, or null when it carries none. Shared by both routes. */
/** What an answer without text looked like, for the log: field names and
 * lengths only, never the document's content. */
function ocrResponseShape(answer: unknown): Record<string, unknown> {
	if (!answer || typeof answer !== "object") return { type: typeof answer };
	const record = answer as Record<string, unknown>;
	const pages = Array.isArray(record.pages) ? (record.pages as Record<string, unknown>[]) : null;
	return {
		keys: Object.keys(record).sort(),
		pages: pages?.length ?? null,
		pageKeys: pages?.[0] && typeof pages[0] === "object" ? Object.keys(pages[0]).sort() : null,
		markdownChars: pages?.map((page) =>
			typeof page?.markdown === "string" ? page.markdown.length : null
		),
		usage: record.usage_info ?? null,
	};
}

function textFromOcrResponse(answer: OcrResponse): Extracted | null {
	const text = (answer.pages ?? [])
		.map((page) => page.markdown ?? "")
		.filter((page) => page.trim())
		.join("\n\n");
	if (!text.trim()) return null;
	return { text, pages: answer.usage_info?.pages_processed ?? (answer.pages ?? []).length };
}

/**
 * Why there is no text, said so the person reading it can act.
 *
 * `reason` is a sentence for the screen; `status` is the HTTP shape of the
 * same fact — 503 when the deployment lacks a reader, 422 when the document
 * itself is the problem, 502 when the reader could not be reached.
 */
export type Extraction = ({ ok: true } & Extracted & { scan?: ScannedPages }) | ExtractionFailure;

export type { ExtractionFailureKind };

export interface ExtractionFailure {
	ok: false;
	kind: ExtractionFailureKind;
	reason: string;
	status: number;
}

/**
 * The model this document would be read with, or null if the deployment has
 * none the caller may use.
 *
 * The priority is `resolveExtractor`'s (`./knowledge/extractorResolution`),
 * the one place it is decided so the Knowledge screen's picker and this
 * upload path can never show one reader and use another: an env value, then
 * the Knowledge screen's stored choice, then this deployment's own local
 * extractor, then the first available reader, then none.
 *
 * Resolved per call rather than cached: an administrator adding a reader
 * should not need the chat restarted, and this runs once per uploaded document
 * — not per turn — so one extra request is not a cost worth caching against.
 * Exported because `attachFile` asks the same question before creating a
 * document row, so the refusal lands before anything half-exists.
 */
export async function resolveExtractorModel(token: string): Promise<string | null> {
	// A configured direct endpoint overrides everything below it: an operator
	// who names `CHAT_OCR_BASE_URL` means it, not "try this only when the
	// gateway has nothing." `assertOcrConfigValid` guarantees `CHAT_OCR_MODEL`
	// is set whenever this is reached; the `|| null` is only for callers that
	// reach this function without going through that boot-time check (tests).
	if (directOcrBaseUrl()) return config.CHAT_OCR_MODEL?.trim() || null;

	// An env value beats even the screen's own stored choice — the same
	// "operator who names one means it" rule the direct endpoint follows
	// above, generalized to naming a model in the ordinary gateway-routed
	// catalogue rather than a whole endpoint of its own.
	const envModel = config.CHAT_OCR_MODEL?.trim() || null;
	if (envModel) return envModel;

	const knowledge = await readConfig();
	const storedModel = knowledge.extractorModel?.trim() || null;
	if (storedModel) return storedModel;

	// Neither named one: this deployment's own local extractor, when the
	// gateway has one (`?include=ocr`'s `local: true`), else the first
	// reader in the catalogue this caller may use, else none. An older
	// gateway that does not flag `local` at all degrades to "first
	// available" — the same answer it gave before this flag existed.
	try {
		const answer = await gateway.get<{ data: ModelCard[] }>(token, "models?include=ocr");
		const candidates: ExtractorCandidate[] = answer.data
			.filter((model) => model.kind === "ocr")
			.map((model) => ({ id: model.id, local: model.local === true }));
		return resolveExtractor({ envModel: null, storedModel: null, candidates }).model;
	} catch (err) {
		logger.warn({ err }, "document_extraction_unavailable: could not list models");
		return null;
	}
}

/** Nothing anywhere to read with — not the document's fault, the deployment's. */
export const NO_READER_MESSAGE =
	"This deployment has no document reader configured, so PDFs and Office files cannot be read yet. An administrator picks one on the Knowledge screen.";

const NO_READER: ExtractionFailure = {
	ok: false,
	kind: "no-reader",
	status: 503,
	reason: NO_READER_MESSAGE,
};

function formatLabel(mime: string): string {
	if (mime.includes("word") || mime === "application/msword") return "Word documents";
	if (mime.includes("excel") || mime.includes("spreadsheet")) return "spreadsheets";
	if (mime.includes("powerpoint") || mime.includes("presentation")) return "presentations";
	if (mime === "application/epub+zip") return "e-books";
	return "this kind of document";
}

/**
 * The reader for an Office-style document: this deployment's *local* one — the
 * gateway's `local: true` model — whichever model is selected for PDFs, or
 * null. Not the env value, not the screen's choice: those name an OCR model,
 * and an OCR model is for page images.
 */
export async function resolveOfficeReader(token: string): Promise<string | null> {
	try {
		const answer = await gateway.get<{ data: ModelCard[] }>(token, "models?include=ocr");
		return answer.data.find((model) => model.kind === "ocr" && model.local === true)?.id ?? null;
	} catch (err) {
		logger.warn({ err }, "document_extraction_unavailable: could not list models");
		return null;
	}
}

/**
 * The text of one document, or the reason there is none.
 *
 * Every failure comes back spelled out rather than as a bare null: an
 * attachment is stored either way (losing somebody's file because its text
 * could not be read is worse than an attachment the assistant cannot see),
 * and a knowledge base attaches the reason to the document row, where "failed"
 * without a why would send somebody looking for one.
 */
export async function extractDocument(options: {
	bytes: ArrayBuffer;
	mime: string;
	filename: string;
	token: string | undefined;
	/**
	 * Ask the local reader for the pages of a PDF that have no text as images
	 * (up to `CHAT_PDF_IMAGE_PAGES`), returned in `scan` beside the page-ordered
	 * text. Asked for only when the model that reads PDFs *is* the local reader
	 * — a remote OCR model reads a scan itself and is never sent the request —
	 * and by callers that can store and use the pages: a chat attachment, not a
	 * knowledge base's text.
	 */
	pageImages?: boolean;
}): Promise<Extraction> {
	const { bytes, mime, filename, token } = options;
	if (!token) {
		return {
			ok: false,
			kind: "no-credential",
			status: 401,
			reason:
				"This session has no gateway credential, so the document cannot be read. Sign out and back in.",
		};
	}

	// PDFs and images go to the selected OCR model; every other format goes to
	// the local reader, whatever is selected, or fails saying there is none.
	if (!isOcrNative(mime)) {
		const reader = await resolveOfficeReader(token);
		if (!reader) {
			// A direct endpoint reads PDFs only and says so in its own words.
			const baseUrl = directOcrBaseUrl();
			if (baseUrl) {
				const model = config.CHAT_OCR_MODEL?.trim() ?? "";
				return extractDocumentDirect({ bytes, mime, filename, baseUrl, model });
			}
			const label = formatLabel(mime);
			logger.info(
				{ filename, mime },
				"document_extraction_skipped: no local reader for this format"
			);
			return {
				ok: false,
				kind: "no-reader",
				status: 503,
				reason: `No reader for ${label} is configured: this deployment has no local document reader, and an OCR model cannot read them. An administrator needs to enable the local reader on the Knowledge screen.`,
			};
		}
		return extractViaGateway({ bytes, mime, filename, token, model: reader });
	}

	const model = await resolveExtractorModel(token);
	if (!model) {
		logger.info(
			{ filename },
			"document_extraction_skipped: this deployment has no reader configured"
		);
		return NO_READER;
	}

	const baseUrl = directOcrBaseUrl();
	if (baseUrl) return extractDocumentDirect({ bytes, mime, filename, baseUrl, model });
	// Page images are for the local reader only: a remote OCR model reads a scan
	// itself, and is never sent the request. The same rule for the fallback below.
	const wantsPages =
		options.pageImages === true && mime === "application/pdf" && pdfImagePageLimit() > 0;
	const first = await extractViaGateway({
		bytes,
		mime,
		filename,
		token,
		model,
		imagePages: wantsPages && (await isLocalReader(token, model)) ? pdfImagePageLimit() : 0,
	});
	if (first.ok || mime !== "application/pdf" || first.kind === "no-credential") return first;

	// The OCR model failed (rate limited, down, or empty). A PDF with a text
	// layer does not need OCR at all, so the local reader gets a turn before
	// the upload is given up on; its answer is used only when it found text —
	// or, for pages that are pictures, rendered them.
	const local = await resolveOfficeReader(token);
	if (!local || local === model) return first;
	const fallback = await extractViaGateway({
		bytes,
		mime,
		filename,
		token,
		model: local,
		imagePages: wantsPages ? pdfImagePageLimit() : 0,
	});
	if (!fallback.ok) return first;
	logger.info(
		{ filename, model, fallback: local, firstStatus: first.status },
		"document_extraction_fallback: the OCR model failed, the local reader read the document"
	);
	return fallback;
}

/** Whether `model` is this deployment's own reader (the gateway's `local: true`). */
async function isLocalReader(token: string, model: string): Promise<boolean> {
	try {
		const answer = await gateway.get<{ data: ModelCard[] }>(token, "models?include=ocr");
		return answer.data.some((card) => card.id === model && card.local === true);
	} catch (err) {
		logger.warn({ err }, "document_extraction_unavailable: could not list models");
		return false;
	}
}

/** One `POST /v1/ocr` call with the model already chosen, as the calling user. */
async function extractViaGateway(options: {
	bytes: ArrayBuffer;
	mime: string;
	filename: string;
	token: string;
	model: string;
	/** Image pages to ask for; 0 asks for none. */
	imagePages?: number;
}): Promise<Extraction> {
	const { bytes, mime, filename, token, model, imagePages = 0 } = options;

	// A `data:` URI rather than a URL, deliberately: the other form has the
	// provider fetch the document, which means this deployment never holds it
	// and cannot redact it. Sending the bytes is what keeps the document inside
	// the gateway's own reach — and with the local extractor, inside the
	// deployment entirely.
	const uri = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

	try {
		const answer = await gateway.post<OcrResponse>(token, "ocr", {
			model,
			// `type` is required and is the provider's own discriminator, passed
			// through rather than reinterpreted — the gateway refuses the request
			// without it (`document.type: Field required`).
			document: { type: "document_url", document_url: uri },
			...(imagePages > 0
				? { page_images: { max_pages: imagePages, long_side: PAGE_IMAGE_LONG_SIDE } }
				: {}),
		});
		// Pages that are pictures come back beside the pages that are text; put
		// them back in order. Without any, it is an ordinary answer.
		const composed = imagePages > 0 ? composePages(answer, imagePages) : null;
		if (composed) {
			logger.info(
				{
					filename,
					model,
					imagePages: composed.scan.images.length,
					pageCount: composed.scan.pageCount,
					truncated: composed.scan.truncated,
				},
				"document_extraction_page_images: pages without text rendered as images"
			);
			return {
				ok: true,
				text: composed.text,
				pages: composed.scan.pageCount - composed.scan.images.length,
				scan: composed.scan,
			};
		}
		const extracted = textFromOcrResponse(answer);
		if (!extracted) {
			logger.info(
				{ filename, model, shape: ocrResponseShape(answer) },
				"document_extraction_empty: the reader answered without text"
			);
			if (!isOcrNative(mime)) {
				return {
					ok: false,
					kind: "empty",
					status: 422,
					reason: `The local reader found no text in this document. It may be empty, or hold only images or drawings.`,
				};
			}
			const localReader = await resolveOfficeReader(token);
			if (localReader && localReader !== model) {
				// An OCR model reads scans, so "use an OCR model" would send the
				// person round in a circle; say which model came back empty.
				return {
					ok: false,
					kind: "empty",
					status: 422,
					reason: `The OCR model ${model} returned no text for this document. Try again, or pick another reader on the Knowledge screen.`,
				};
			}
			return {
				ok: false,
				kind: "no-text",
				status: 422,
				reason:
					"This document has no readable text. A scan needs an OCR model — this deployment's own reader reads text layers only.",
			};
		}
		return { ok: true, ...extracted };
	} catch (err) {
		const status = err instanceof GatewayCallFailed ? err.status : 502;
		// The gateway's own refusals are written to be acted on ("this document
		// has no text layer — use an OCR model for this document"); quoting them
		// beats paraphrasing them into something generic. A provider-side failure
		// (429, 5xx) is not the gateway's own refusal — the gateway's message is
		// often just the upstream's status wrapped, e.g. "the provider answered
		// 429" — so this names the reader instead of leaving the upload looking
		// like nothing works at all.
		let reason = "The document reader could not be reached, so the file was stored without text.";
		let kind: ExtractionFailureKind = "unreachable";
		if (err instanceof GatewayCallFailed) {
			if (status === 422) {
				reason = err.message;
				kind = "refused";
			} else if (status === 429 || status >= 500) reason = readerFailureReason(status, model);
			else {
				// Any other refusal (400, 415…) is the reader's own word on this file.
				reason = err.message || reason;
				kind = "refused";
			}
		}
		logger.warn(
			{
				filename,
				model,
				status: err instanceof GatewayCallFailed ? err.status : undefined,
				err,
			},
			"document_extraction_failed: the attachment is stored without text"
		);
		return { ok: false, kind, status, reason };
	}
}

/**
 * The gateway path above, but called directly against an OCR endpoint with no
 * gateway in front of it — a shared deployment key rather than the caller's
 * own credential, since there is no per-user accounting to preserve without
 * one.
 *
 * Bytes rather than a URL for the same reason as the gateway path: the
 * alternative has the *provider* fetch the document. The property that
 * preserves is different here, though, worth being honest about in this
 * comment rather than just copying the one above — in direct mode the bytes
 * go to a third party either way, gateway or not. What is preserved is that
 * *this deployment* decides what is sent, not that the document stays local.
 */
async function extractDocumentDirect(options: {
	bytes: ArrayBuffer;
	mime: string;
	filename: string;
	baseUrl: string;
	model: string;
}): Promise<Extraction> {
	const { bytes, mime, filename, baseUrl, model } = options;

	if (!(DIRECT_OCR_MIME_ALLOWLIST as readonly string[]).includes(mime)) {
		return {
			ok: false,
			kind: "unsupported",
			status: 422,
			reason: `This deployment's OCR endpoint reads PDFs only; "${filename}" is ${
				mime || "not a recognized document type"
			}, which needs a gateway reader instead.`,
		};
	}

	if (bytes.byteLength > DIRECT_OCR_MAX_BYTES) {
		return {
			ok: false,
			kind: "unsupported",
			status: 413,
			reason: `This document is too large to send directly to the configured OCR endpoint (limit ${Math.floor(
				DIRECT_OCR_MAX_BYTES / (1024 * 1024)
			)} MB). Use a smaller file, or ask an administrator to configure a gateway reader instead.`,
		};
	}

	const uri = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
	const apiKey = config.CHAT_OCR_API_KEY?.trim();

	let response: Response;
	try {
		response = await fetch(`${baseUrl.replace(/\/$/, "")}/ocr`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({
				model,
				document: { type: "document_url", document_url: uri },
			}),
		});
	} catch (err) {
		logger.warn(
			{ filename, model, baseUrl, err },
			"document_extraction_failed: the direct OCR endpoint could not be reached"
		);
		return {
			ok: false,
			kind: "unreachable",
			status: 502,
			reason: "The document reader could not be reached, so the file was stored without text.",
		};
	}

	if (!response.ok) {
		// Mistral's and Cortecs' published schemas document only 200 responses —
		// their error envelopes are undocumented, and Cortecs' OCR is labelled
		// BETA with no versioning policy — so this is read defensively and never
		// trusted to have any particular shape.
		let detail: string | undefined;
		try {
			const parsed = (await response.json()) as {
				error?: { message?: string };
				message?: string;
			};
			detail = parsed?.error?.message ?? parsed?.message;
		} catch {
			/* not JSON, or not the shape hoped for — the status is all there is */
		}
		logger.warn(
			{ filename, model, baseUrl, status: response.status, detail },
			"document_extraction_failed: the direct OCR endpoint refused"
		);
		// The endpoint's own detail wins when it has one; a 429 or 5xx with no
		// parseable envelope still names the reader rather than reading as
		// "not available" (the same mapping the gateway path uses).
		const fallback =
			response.status === 429 || response.status >= 500
				? readerFailureReason(response.status, model)
				: "The document reader could not be reached, so the file was stored without text.";
		return {
			ok: false,
			kind:
				response.status === 429 || response.status >= 500 ? ("unreachable" as const) : "refused",
			status: response.status,
			reason: detail ?? fallback,
		};
	}

	let answer: OcrResponse;
	try {
		answer = (await response.json()) as OcrResponse;
	} catch (err) {
		logger.warn(
			{ filename, model, baseUrl, err },
			"document_extraction_failed: the direct OCR endpoint returned an unreadable response"
		);
		return {
			ok: false,
			kind: "unreachable",
			status: 502,
			reason: "The document reader could not be reached, so the file was stored without text.",
		};
	}

	const extracted = textFromOcrResponse(answer);
	if (!extracted) {
		logger.info(
			{ filename, model, shape: ocrResponseShape(answer) },
			"document_extraction_empty: the configured OCR endpoint returned no text"
		);
		return {
			ok: false,
			kind: "no-text",
			status: 422,
			reason:
				"The configured OCR endpoint returned no text for this document — it may be blank, corrupted, or a file the endpoint could not parse.",
		};
	}
	return { ok: true, ...extracted };
}
