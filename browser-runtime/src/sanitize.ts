/**
 * Everything that comes out of a page is untrusted text. Before it reaches the model it loses
 * what an attacker uses to hide or fake structure: control characters, zero-width and
 * direction-override characters, the Unicode "tag" block, variation selectors outside emoji,
 * line breaks (so a page cannot start a line that looks like one of ours) and anything that looks
 * like the closing delimiter of the page-content block.
 */

const INVISIBLE =
	/[\u0000-\u0008\u000b-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿￹-￻\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/** The tag that fences page content in a snapshot. A page's own copy of it is defanged. */
export const CONTENT_TAG = "page-content";
const FENCE = new RegExp(`<\\s*(/?)\\s*(${CONTENT_TAG}|untrusted_page_content)`, "gi");

/** Plain one-line text: invisible characters removed, whitespace collapsed, clipped with an ellipsis. */
export function clean(input: unknown, max = 300): string {
	if (input === undefined || input === null) return "";
	let text = String(input)
		.replace(INVISIBLE, "")
		.replace(FENCE, `‹$1$2`)
		.replace(/\s+/g, " ")
		.trim();
	if (text.length > max) {
		// Do not cut a surrogate pair in half.
		let end = max - 1;
		const code = text.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) end -= 1;
		text = `${text.slice(0, end)}…`;
	}
	return text;
}

/** Text with line breaks kept (for the text of a region), otherwise cleaned the same way. */
export function cleanMultiline(input: unknown, max = 20_000): string {
	if (input === undefined || input === null) return "";
	let text = String(input)
		.replace(INVISIBLE, (c) => (c === "\n" || c === "\t" ? c : ""))
		.replace(FENCE, `‹$1$2`)
		.replace(/[ \t\f\v ]+/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (text.length > max) text = `${text.slice(0, max - 1)}…`;
	return text;
}

/** A value as one quoted token on a line of the snapshot. */
export function quote(text: string): string {
	return JSON.stringify(text);
}

/** A file name from a page or a server: one path segment, no control characters, at most 255 characters. */
export function safeFileName(name: string): string {
	const base = clean(name, 255).split(/[\\/]/).pop()?.replace(/^\.+/, "") ?? "";
	return base || "download";
}
