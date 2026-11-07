import { PREVIEW_CSP } from "$lib/utils/previewSrcdoc";

/** The headers every print page carries. */
export const PRINT_HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	// Opaque origin, scripts and the print dialog; nothing else (no same-origin, popups, forms or downloads)
	"Content-Security-Policy": `sandbox allow-scripts allow-modals; ${PREVIEW_CSP}`,
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
} as const;
