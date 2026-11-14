import type { MessageUpdate } from "./MessageUpdate";
import type { Timestamps } from "./Timestamps";
import type { TurnStats } from "./TurnStats";
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

/** The privacy rule (and the pipeline it belongs to) that withheld a file. */
export interface WithheldByPrivacy {
	rule: string;
	pipeline?: string;
}

export type Message = Partial<Timestamps> & {
	from: "user" | "assistant" | "system";
	id: ReturnType<typeof v4>;
	content: string;
	updates?: MessageUpdate[];

	/**
	 * The memory block that rode in front of this user message when it was sent
	 * (the chat's notes and any personal or project memory changed since the chat
	 * started; see `$lib/server/memory/tail`). Stored so later turns replay it
	 * unchanged: the provider's prompt cache needs every byte before the newest
	 * message to be the same as last turn. Server-side only; never sent to a
	 * client, an export or the conversation API. Present only when it differed from
	 * the last block on the path. Dropped when a row it quotes is deleted or edited.
	 */
	memoryBlock?: string;

	// Optional server or client-side reasoning content (inside the think tag)
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
		provider?: string;
	};

	/**
	 * Numbers and the redaction summary for the turn's details overlay. Set by
	 * the server where the stream is read; absent on answers written before it
	 * existed. `redaction.values` is stripped from exports.
	 */
	stats?: TurnStats;

	// needed for conversation trees
	ancestors?: Message["id"][];

	// goes one level deep
	children?: Message["id"][];
};

export type MessageFile = {
	type: "hash" | "base64";
	name: string;
	/**
	 * Client only, never stored: the file itself, for an attachment sent as
	 * binary form data rather than base64 text (audio, up to 25 MB). `value`
	 * is empty then.
	 */
	binary?: File;
	value: string;
	mime: string;
	/**
	 * The file's number among the versions of its name, recorded at upload when
	 * the conversation already had versions under that name: an attachment
	 * uploaded after files were produced (or attached) under its name takes the
	 * next free one, so every version of the name keeps a single number.
	 * Absent means version 1, the first version of its name.
	 */
	version?: number;
	/**
	 * Set only on the copy of a file handed to the model for one turn
	 * (`preprocessMessages`), never stored: the name the original is mounted
	 * under in the code sandbox, so the prompt can say where it is when code is
	 * on offer. See `utils/execution/attachmentNames.ts`.
	 */
	mountName?: string;
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
	/**
	 * For a PDF with pages that have no text (scans): those pages as images,
	 * rendered by the local reader at upload and stored as conversation
	 * attachments, by hash and 1-based page number. The page-ordered text is in
	 * `extracted`, with a marker where each of these pages goes. Which model gets
	 * the images and which only a note is decided each turn
	 * (`preprocessMessages`): one that reads images gets them like images the
	 * person uploaded; any other gets a sentence, and the files stay stored for a
	 * later switch. `pageCount` is the PDF's own; `scannedTotal` is how many of its
	 * pages needed an image, of which `files` holds the first ones (`truncated`).
	 */
	pageImages?: {
		files: { page: number; value: string; mime: string }[];
		pageCount: number;
		scannedTotal: number;
		truncated: boolean;
	};
	extractionError?: {
		kind: ExtractionFailureKind;
		reason: string;
	};
	/**
	 * Set when a privacy rule of the gateway refused to let this file be read
	 * (extraction answered 403 "Refused by the privacy rule ..."). Unlike
	 * `extractionError`, which is a technical failure, this is a policy: the file
	 * stays stored and visible to its owner, but no tool, sandbox mount or
	 * re-extraction may read its bytes or text (`downloadFile` refuses it).
	 */
	withheld?: WithheldByPrivacy;
	/** The reader that read this document, when known. */
	readerModel?: string;
	/** The chosen reader was unavailable, so the default reader read it. */
	readerFallback?: boolean;
	/**
	 * For attached audio: what transcription reported, kept beside the
	 * transcript (`extracted`, `pages: 0`). Both are optional — a provider
	 * may return neither. The chip shows the duration; the prompt labels the
	 * transcript with it.
	 */
	audio?: {
		durationSeconds?: number;
		language?: string;
	};
};
