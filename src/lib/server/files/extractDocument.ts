/**
 * Turning an attached document into text, once.
 *
 * A PDF or a `.docx` attached to a message is bytes the model cannot read.
 * `POST /v1/ocr` in the gateway turns it into markdown — metered by the page,
 * with either this deployment's own extractor or an upstream OCR model
 * depending on which model is named (ADR 0055).
 *
 * **It runs at upload and its result is stored.** That is the whole design
 * decision here, and it is a billing decision rather than a performance one:
 * extraction is priced per page, so re-extracting on every turn would charge
 * for the same twelve-page PDF again on the second question about it, and
 * again on the third. Once per file, kept beside the file.
 *
 * Which model does it is the deployment's choice: `CHAT_OCR_MODEL` if set,
 * otherwise the first model the caller may use whose `kind` is `ocr`. With no
 * such model the attachment is still stored and simply carries no text — said
 * out loud in the message rather than left as a document the assistant
 * silently ignores.
 */

import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { gateway, GatewayCallFailed } from "$lib/server/gatewayServer";

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

interface OcrPage {
	markdown?: string;
}

interface OcrResponse {
	pages?: OcrPage[];
	usage_info?: { pages_processed?: number };
}

interface ModelCard {
	id: string;
	kind?: string;
}

/**
 * The model to extract with, or null if this deployment has none.
 *
 * Resolved per call rather than cached: an administrator adding an OCR model
 * should not need the chat restarted, and this runs once per uploaded document
 * — not per turn — so one extra request is not a cost worth caching against.
 */
async function extractorModel(token: string): Promise<string | null> {
	const configured = config.CHAT_OCR_MODEL?.trim();
	if (configured) return configured;
	try {
		const answer = await gateway.get<{ data: ModelCard[] }>(token, "models");
		return answer.data.find((model) => model.kind === "ocr")?.id ?? null;
	} catch (err) {
		logger.warn({ err }, "document_extraction_unavailable: could not list models");
		return null;
	}
}

export interface Extracted {
	text: string;
	pages: number;
}

/**
 * The text of one document, or null when there is none to be had.
 *
 * Null covers every reason — no OCR model configured, a scan with no text
 * layer, a provider that refused, a gateway that could not be reached — and
 * each is logged with which. The caller stores the attachment either way: an
 * upload that fails because its text could not be read is worse than an
 * attachment the assistant cannot see, because the person loses the file too.
 */
export async function extractDocument(options: {
	bytes: ArrayBuffer;
	mime: string;
	filename: string;
	token: string | undefined;
}): Promise<Extracted | null> {
	const { bytes, mime, filename, token } = options;
	if (!token) return null;

	const model = await extractorModel(token);
	if (!model) {
		logger.info(
			{ filename },
			"document_extraction_skipped: this deployment has no OCR model configured"
		);
		return null;
	}

	// A `data:` URI rather than a URL, deliberately: the other form has the
	// provider fetch the document, which means this deployment never holds it
	// and cannot redact it. Sending the bytes is what keeps the document inside
	// the gateway's own reach — and with the built-in extractor, inside the
	// deployment entirely.
	const uri = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

	try {
		const answer = await gateway.post<OcrResponse>(token, "ocr", {
			model,
			// `type` is required and is the provider's own discriminator, passed
			// through rather than reinterpreted — the gateway refuses the request
			// without it (`document.type: Field required`).
			document: { type: "document_url", document_url: uri },
		});
		const text = (answer.pages ?? [])
			.map((page) => page.markdown ?? "")
			.filter((page) => page.trim())
			.join("\n\n");
		if (!text.trim()) {
			logger.info(
				{ filename, model },
				"document_extraction_empty: no text layer — a scan needs an OCR model"
			);
			return null;
		}
		return { text, pages: answer.usage_info?.pages_processed ?? (answer.pages ?? []).length };
	} catch (err) {
		logger.warn(
			{
				filename,
				model,
				status: err instanceof GatewayCallFailed ? err.status : undefined,
				err,
			},
			"document_extraction_failed: the attachment is stored without text"
		);
		return null;
	}
}
