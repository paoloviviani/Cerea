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
 * The per-file ceiling every attachment entry point enforces: chat's upload
 * (`conversation/[id]`), its drop zone, and the owner-keyed store's upload
 * route. One number, so an agent surface cannot drift from chat's limit.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

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
