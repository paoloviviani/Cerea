import type { BlockToken } from "$lib/utils/markedLight";

/**
 * Finished markdown renders, by their input, so a message whose component is
 * recreated (its turn regrouped when a history page is prepended, a branch
 * switch, a remount) paints its rendered blocks at once instead of the light
 * fallback until the worker answers. The fallback is shorter, so the swap back
 * moves everything below it, flashes unstyled text in a message the reader is
 * looking at, and skews any scroll compensation measured while it shows.
 *
 * Only settled content is stored (never a streaming render), bounded by entry
 * count and by size, least recently used out first.
 */
const MAX_ENTRIES = 200;
const MAX_CONTENT_CHARS = 100_000;

const cache = new Map<string, BlockToken[]>();

function keyOf(content: string, sources: unknown[]): string | null {
	if (content.length > MAX_CONTENT_CHARS) return null;
	return (sources.length ? JSON.stringify(sources) : "") + "\u0000" + content;
}

export function cachedMarkdownBlocks(content: string, sources: unknown[]): BlockToken[] | null {
	const key = keyOf(content, sources);
	if (key === null) return null;
	const hit = cache.get(key);
	if (!hit) return null;
	cache.delete(key);
	cache.set(key, hit);
	return hit;
}

export function rememberMarkdownBlocks(
	content: string,
	sources: unknown[],
	blocks: BlockToken[]
): void {
	const key = keyOf(content, sources);
	if (key === null) return;
	cache.delete(key);
	cache.set(key, blocks);
	if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
}
