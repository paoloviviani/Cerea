// Centralized MIME allowlists used across client and server
// Keep these lists minimal and consistent with server processing.

export const TEXT_MIME_ALLOWLIST = [
	"text/*",
	"application/json",
	"application/xml",
	"application/csv",
] as const;

export const IMAGE_MIME_ALLOWLIST_DEFAULT = ["image/jpeg", "image/png"] as const;

/**
 * Documents the gateway's extractor can read (ADR 0055). Offered whatever the
 * model is, and not gated on multimodal support: the model never sees the
 * bytes — it sees the text the extractor read, which any model can read.
 *
 * The authoritative list is the extractor's, in the gateway. This one is the
 * composer's `accept` attribute, so it is a convenience and not a check: a
 * type the extractor cannot read produces an attachment with no text and a
 * prompt that says so.
 */
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

/**
 * Audio the gateway's transcription route reads (`POST /v1/audio/transcriptions`).
 * Offered in the composer when the user can use a transcription model; the
 * model never sees the bytes, only the transcript made at upload. Browsers
 * declare m4a as `audio/mp4`, `audio/x-m4a` or `audio/m4a`, so those are all here.
 */
export const AUDIO_MIME_ALLOWLIST = [
	"audio/mpeg",
	"audio/mp3",
	"audio/mp4",
	"audio/x-m4a",
	"audio/m4a",
	"audio/wav",
	"audio/x-wav",
	"audio/ogg",
	"audio/opus",
	"audio/webm",
	"audio/flac",
	"audio/x-flac",
] as const;

/**
 * What a knowledge base accepts, as an `accept` attribute: the extractable
 * documents and plain text. A convenience for the pickers; the server decides
 * from the bytes (`files/knowledgeUpload.ts`) and answers 415 for the rest.
 */
export const KNOWLEDGE_ACCEPT = [
	...DOCUMENT_MIME_ALLOWLIST,
	".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.epub",
	"text/*",
	".md,.markdown,.csv,.tsv,.json,.xml,.yaml,.yml,.txt",
].join(",");

/**
 * The per-file ceiling every attachment entry point enforces: chat's upload
 * (`conversation/[id]`), its drop zone, and the owner-keyed store's upload
 * route. One number, so an agent surface cannot drift from chat's limit.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** The gateway's own cap on one transcription: what an audio attachment may be. */
export const MAX_AUDIO_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** What the server says (and the client says before uploading) for audio past the cap. */
export const AUDIO_TOO_LONG_TEXT = "too long to transcribe here: up to 25 MB (about 25 minutes)";

/** Whether a declared type is one of the audio types an attachment may be. */
export function isAudioAttachmentMime(mime: string): boolean {
	return (AUDIO_MIME_ALLOWLIST as readonly string[]).includes(mime.toLowerCase());
}

/** Why one attachment is refused for its size, or null when it fits. */
export function attachmentSizeRefusal(file: {
	name: string;
	size: number;
	type: string;
}): string | null {
	if (file.size <= maxAttachmentBytesFor(file.type)) return null;
	return isAudioAttachmentMime(file.type)
		? `${file.name} is ${AUDIO_TOO_LONG_TEXT}.`
		: `${file.name} is too large: files are limited to 10 MB.`;
}

/** The size limit of one attachment: 25 MB for audio, 10 MB for everything else. */
export function maxAttachmentBytesFor(mime: string): number {
	return isAudioAttachmentMime(mime) ? MAX_AUDIO_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES;
}

/**
 * What a person may attach to a coding-agent message — the ceiling the
 * `/code` upload route enforces; a composer may offer a subset. Chat's text
 * and document lists, the images every agent provider reads, and chat's own
 * long-paste type (`application/vnd.chatui.clipboard`, plain text a composer
 * turned into a chip; a transport should hand it on as `text/plain`).
 */
export const AGENT_ATTACHMENT_MIME_ALLOWLIST = [
	...TEXT_MIME_ALLOWLIST,
	...DOCUMENT_MIME_ALLOWLIST,
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"application/vnd.chatui.clipboard",
] as const;
