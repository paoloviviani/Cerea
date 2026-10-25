/**
 * The think tag, in one place.
 *
 * Some reasoning models emit the think tags as special tokens and cannot type
 * them literally: an agent built on one that edits this code writes a broken
 * tag (the closing `>` goes missing) without noticing. So the literal tag
 * appears only in this file, assembled from pieces, and everything else
 * imports the constants and patterns below. A spec fails the build if a
 * literal tag shows up anywhere else under src/.
 */

export const THINK_OPEN = "<" + "think>";
export const THINK_CLOSE = "</" + "think>";

const OPEN_SOURCE = "<" + "think>";
const CLOSE_SOURCE = "<\\/" + "think>";

/** A think block, up to its closing tag or the end of the text when unclosed. */
export function thinkBlockPattern(flags?: string): RegExp {
	return new RegExp(OPEN_SOURCE + "[\\s\\S]*?(?:" + CLOSE_SOURCE + "|$)", flags);
}

/** Like {@link thinkBlockPattern}, with the block's inner text as group 1. */
export function thinkBlockCapturePattern(flags?: string): RegExp {
	return new RegExp(OPEN_SOURCE + "([\\s\\S]*?)(?:" + CLOSE_SOURCE + "|$)", flags);
}

/** Like {@link thinkBlockPattern}, with the whole block (tags included) as group 1. */
export function thinkBlockWholePattern(flags?: string): RegExp {
	return new RegExp("(" + OPEN_SOURCE + "[\\s\\S]*?(?:" + CLOSE_SOURCE + "|$))", flags);
}

/** Either think tag, opening or closing, on its own. */
export function thinkTagPattern(flags?: string): RegExp {
	return new RegExp("<\\/?" + "think>", flags);
}
