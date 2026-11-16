/**
 * What a connector says about itself, for the two connector lists (Workspace -> Agents and a
 * coding session's overlay): the connector's own description (an administrator's text, a
 * catalogue entry's, or what its server said about itself on the last check), made plain and
 * short. Never a tool's description: that describes one tool, not the connector.
 */

export const BLURB_MAX = 140;

/** Markdown reduced to plain words: headings, emphasis, code, links, lists and tags removed. */
export function stripMarkdown(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
		.replace(/^\s*>\s?/gm, "")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(\*|_)(.+?)\1/g, "$2")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

/** Plain text cut at a word boundary with an ellipsis, so it fits one or two lines. */
export function truncateWords(text: string, max = BLURB_MAX): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max - 1);
	const space = cut.lastIndexOf(" ");
	const head = (space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "");
	return `${head}…`;
}

/** The line a list shows for a connector; "" when it has no description of its own. */
export function connectorBlurb(...sources: Array<string | null | undefined>): string {
	for (const source of sources) {
		const plain = source ? stripMarkdown(source) : "";
		if (plain) return truncateWords(plain);
	}
	return "";
}

/**
 * The title and line for a server on the user's own computer. The machine reports a server id
 * (`calendar`) and a description that is often just its proper name ("Infomaniak Calendar"):
 * a short, name-like description becomes the title and the id stays as secondary text.
 */
export function localServerLabel(
	id: string,
	description: string | null | undefined
): { title: string; detail?: string; blurb: string } {
	const plain = description ? stripMarkdown(description) : "";
	const nameLike = plain.length > 0 && plain.length <= 40 && !/[.!?:]$/.test(plain);
	if (nameLike) {
		return plain.toLowerCase() === id.toLowerCase()
			? { title: plain, blurb: "" }
			: { title: plain, detail: id, blurb: "" };
	}
	return { title: id, blurb: plain ? truncateWords(plain) : "" };
}

/** One order for both lists: alphabetical by display title, local servers mixed in. */
export function compareConnectors(a: { name: string }, b: { name: string }): number {
	return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}
