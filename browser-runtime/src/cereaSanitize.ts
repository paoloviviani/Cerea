/**
 * COPY of Cerea's `src/lib/server/browser/sanitize.ts` (made by scripts/sync-contract.mjs): never edit it here.
 */
/**
 * Text that came from the page or the runtime is data. This removes what could pretend to be the
 * fence around it (`<untrusted_page_content>` in any spelling) and control characters, and
 * flattens it to one line. Used wherever such text reaches a prompt, a sentence or a card.
 */

const FENCE_TAG = /<\s*\/?\s*untrusted_page_content[^>]*>/gi;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Fence tags and control characters out; newlines kept (for page bodies). */
export function stripFence(text: string): string {
	return text.replace(FENCE_TAG, "[page text removed]").replace(CONTROL, "");
}

/** One line, fence tags out: for a name, an outcome, an error, a file name. */
export function sanitizeText(text: string): string {
	return stripFence(text).replace(/\s+/g, " ");
}
