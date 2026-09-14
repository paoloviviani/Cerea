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
 * Which model does it, in order: the Knowledge screen's choice, then
 * `CHAT_OCR_MODEL` when the screen has not named one, then the first model the
 * caller may use whose `kind` is `ocr`. The deployment's own extractor is not
 * a special case here — it is an ordinary model row on the gateway, whose
 * provider is the local extractor service, and it shows up in the catalogue
 * like any other reader. There is deliberately no stored value that means
 * "extract nothing": an unset choice is the deployment default, so a save that
 * never touched extraction can never turn it off, and with no reader anywhere
 * the reason comes back spelled out rather than as a silent absence of text.
 */

import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { gateway, GatewayCallFailed } from "$lib/server/gatewayServer";
import { readConfig } from "$lib/server/knowledge/service";

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

export interface Extracted {
	text: string;
	pages: number;
}

/**
 * Why there is no text, said so the person reading it can act.
 *
 * `reason` is a sentence for the screen; `status` is the HTTP shape of the
 * same fact — 503 when the deployment lacks a reader, 422 when the document
 * itself is the problem, 502 when the reader could not be reached.
 */
export type Extraction = ({ ok: true } & Extracted) | { ok: false; reason: string; status: number };

/**
 * The model this document would be read with, or null if the deployment has
 * none the caller may use.
 *
 * Resolved per call rather than cached: an administrator adding a reader
 * should not need the chat restarted, and this runs once per uploaded document
 * — not per turn — so one extra request is not a cost worth caching against.
 * Exported because `attachFile` asks the same question before creating a
 * document row, so the refusal lands before anything half-exists.
 */
export async function resolveExtractorModel(token: string): Promise<string | null> {
	// The Knowledge screen's choice, when it has made one. Only a named model
	// is a choice: an unset field and a stored null are both "Automatic", and
	// mean the deployment default below. There is no third value that means
	// "read nothing" — that state was once expressible here and it extracted
	// nothing while the screen promised the opposite.
	const knowledge = await readConfig();
	const chosen = knowledge.extractorModel?.trim();
	if (chosen) return chosen;
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

/** Nothing anywhere to read with — not the document's fault, the deployment's. */
export const NO_READER_MESSAGE =
	"This deployment has no document reader configured, so PDFs and Office files cannot be read yet. An administrator picks one on the Knowledge screen.";

const NO_READER: { ok: false; reason: string; status: number } = {
	ok: false,
	status: 503,
	reason: NO_READER_MESSAGE,
};

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
}): Promise<Extraction> {
	const { bytes, mime, filename, token } = options;
	if (!token) {
		return {
			ok: false,
			status: 401,
			reason:
				"This session has no gateway credential, so the document cannot be read. Sign out and back in.",
		};
	}

	const model = await resolveExtractorModel(token);
	if (!model) {
		logger.info(
			{ filename },
			"document_extraction_skipped: this deployment has no reader configured"
		);
		return NO_READER;
	}

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
			return {
				ok: false,
				status: 422,
				reason:
					"This document has no readable text. A scan needs an OCR model — this deployment's own reader reads text layers only.",
			};
		}
		return {
			ok: true,
			text,
			pages: answer.usage_info?.pages_processed ?? (answer.pages ?? []).length,
		};
	} catch (err) {
		const status = err instanceof GatewayCallFailed ? err.status : 502;
		// The gateway's own refusals are written to be acted on ("this document
		// has no text layer — use an OCR model for this document"); quoting them
		// beats paraphrasing them into something generic.
		const reason =
			err instanceof GatewayCallFailed && status === 422
				? err.message
				: "The document reader could not be reached, so the file was stored without text.";
		logger.warn(
			{
				filename,
				model,
				status: err instanceof GatewayCallFailed ? err.status : undefined,
				err,
			},
			"document_extraction_failed: the attachment is stored without text"
		);
		return { ok: false, status, reason };
	}
}
