/**
 * The ⌘K / Ctrl-K palette's data: what can be jumped to, and how a typed query
 * ranks it. Pure, so the ranking is tested without a browser.
 */

export type PaletteKind = "chat" | "project" | "agent" | "schedule" | "page";

export interface PaletteItem {
	/** Unique across kinds: `chat:<id>`. */
	key: string;
	kind: PaletteKind;
	label: string;
	/** A second, quieter line: the machine of an agent session, the project of a chat. */
	detail?: string;
	/** Where it goes, without the app's base path (the caller prefixes it). */
	href: string;
}

/** Group order in the result list, and how many of each an empty query shows. */
export const KIND_ORDER: PaletteKind[] = ["page", "chat", "project", "agent", "schedule"];
const EMPTY_QUERY_LIMIT: Record<PaletteKind, number> = {
	page: 6,
	chat: 6,
	project: 4,
	agent: 4,
	schedule: 3,
};
export const MAX_RESULTS = 40;

const norm = (text: string) =>
	text
		.normalize("NFD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase();

/**
 * 0 = no match. Higher is better: the label starts with the query, then a word
 * in it starts with the query, then it appears inside, then every word of the
 * query is found somewhere in label or detail. Accents and case do not matter.
 */
export function scoreItem(item: PaletteItem, query: string): number {
	const q = norm(query.trim());
	if (!q) return 1;
	const label = norm(item.label);
	if (label.startsWith(q)) return 100;
	if (label.split(/[\s\-_/·›:.]+/).some((word) => word.startsWith(q))) return 80;
	if (label.includes(q)) return 60;
	const haystack = `${label} ${norm(item.detail ?? "")}`;
	const words = q.split(/\s+/).filter(Boolean);
	if (words.length > 1 && words.every((word) => haystack.includes(word))) return 40;
	if (norm(item.detail ?? "").includes(q)) return 20;
	return 0;
}

/**
 * The items to show for a query. Empty: a short list per kind, in `KIND_ORDER`
 * (the caller's order within a kind is kept, so recent chats stay recent).
 * Otherwise every match, best first, ties in the caller's order, up to
 * `MAX_RESULTS`.
 */
export function filterPalette(items: PaletteItem[], query: string): PaletteItem[] {
	if (!query.trim()) {
		const taken: Partial<Record<PaletteKind, number>> = {};
		return KIND_ORDER.flatMap((kind) =>
			items.filter((item) => {
				if (item.kind !== kind) return false;
				taken[kind] = (taken[kind] ?? 0) + 1;
				return (taken[kind] ?? 0) <= EMPTY_QUERY_LIMIT[kind];
			})
		);
	}
	return items
		.map((item, index) => ({ item, index, score: scoreItem(item, query) }))
		.filter((hit) => hit.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, MAX_RESULTS)
		.map((hit) => hit.item);
}
