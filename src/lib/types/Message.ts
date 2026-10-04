import type { InferenceProvider } from "@huggingface/inference";
import type { MessageUpdate } from "./MessageUpdate";
import type { Timestamps } from "./Timestamps";
import type { v4 } from "uuid";

/**
 * Why an attached document has no extracted text; `extractDocument.ts` words
 * each one. `no-reader` nothing configured can read the format; `no-credential`
 * the session has no gateway credential; `refused` a reader looked and said no
 * (its own reason); `unreachable` the reader or its provider could not be
 * reached; `no-text` a PDF with no text layer (a scan); `empty` an Office-style
 * file with no text in it; `unsupported` the configured endpoint does not take
 * this format or size.
 */
export type ExtractionFailureKind =
	"no-reader" | "no-credential" | "refused" | "unreachable" | "no-text" | "empty" | "unsupported";

export type Message = Partial<Timestamps> & {
	from: "user" | "assistant" | "system";
	id: ReturnType<typeof v4>;
	content: string;
	updates?: MessageUpdate[];

	// Optional server or client-side reasoning content (<think> blocks)
	reasoning?: string;
	score?: -1 | 0 | 1;

	/**
	 * The run that produced this message. Absent on messages written before
	 * generation events existed, which is how a reader tells the two apart.
	 */
	generationId?: string;
	/**
	 * Highest `generationEvents.seq` already folded into `content`/`reasoning`.
	 * A reader resumes from here. Written in the same $set as the content it
	 * describes, so the two can never disagree — except on a stopped run, whose
	 * content is deliberately clamped back to what the user saw.
	 */
	materializedSeq?: number;
	/**
	 * Either contains the base64 encoded image data
	 * or the hash of the file stored on the server
	 **/
	files?: MessageFile[];
	interrupted?: boolean;

	/**
	 * The coding-agent panel's own id for this message, on the machine's own
	 * transcript (`consumeAgentUpdates`, from an `AgentMessageBoundaryUpdate`).
	 * Absent for an ordinary chat message — nothing sets it outside `/code`.
	 * What a fork handoff's "carry up to here" names (parity plan §4.2(a)).
	 */
	machineMessageId?: string;

	/** The transcript marker on the user message a coding-agent slash
	 * command produced (PROTOCOL.md §7): the bubble renders "/name args"
	 * and the expanded template folds beneath it. Never set on an ordinary
	 * chat message. */
	command?: { name: string; arguments: string };

	/** Set on a coding-agent user message another session wrote with
	 * `session_send` (PROTOCOL.md §7): rendered as "From agent ‹title›",
	 * not as the person's own. Never set on an ordinary chat message. */
	sentBy?: { sessionId: string; title: string; hop: number };

	// Router metadata when using llm-router
	routerMetadata?: {
		route: string;
		model: string;
		provider?: InferenceProvider;
	};

	// needed for conversation trees
	ancestors?: Message["id"][];

	// goes one level deep
	children?: Message["id"][];
};

export type MessageFile = {
	type: "hash" | "base64";
	name: string;
	value: string;
	mime: string;
	/**
	 * For an attached document — a PDF, a `.docx` — the text the gateway's
	 * extractor read out of it, stored as its own GridFS entry and named here
	 * by hash.
	 *
	 * Extraction happens **once, at upload**, and this is where the result
	 * lives. That is a billing decision rather than a caching one: `/v1/ocr` is
	 * priced per page, so extracting on every turn would charge for the same
	 * twelve-page PDF again on the second question about it.
	 *
	 * Absent means there is no text: no OCR model configured, a scan with no
	 * text layer, or an extractor that refused. The attachment is still stored
	 * — losing somebody's file because its text could not be read is worse than
	 * an attachment the assistant cannot see — and the prompt says so rather
	 * than leaving a document silently ignored.
	 */
	extracted?: {
		/** GridFS hash of the extracted markdown. */
		value: string;
		/** Pages the extractor reported, which is what was billed. */
		pages: number;
	};
	/**
	 * Why `extracted` is absent, when extraction was attempted and failed. The
	 * prompt words itself from this, so the assistant — and through it the
	 * person — is told what actually went wrong (no reader, the reader refused
	 * the format, it could not be reached, the file has no text) rather than
	 * one fixed guess. Absent on files stored before this was recorded, and on
	 * files that are not documents.
	 */
	extractionError?: {
		kind: ExtractionFailureKind;
		reason: string;
	};
};
