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
