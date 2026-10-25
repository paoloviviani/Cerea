/**
 * Messages with markup: `"Set via {#code}TASK_MODEL{/code}."`.
 *
 * Paraglide compiles that to a flat string for `m.key()` and to a list of
 * parts for `m.key.parts()`. `richSegments` folds the parts into what a
 * template can render: plain text, and text wrapped in a named tag. The tag's
 * look stays in the template (`<Rich>` takes a snippet per tag), the words and
 * their order stay in the catalogue, so a translation can move the `<code>`
 * without touching a component.
 *
 * One level only: a tag inside a tag is rendered as plain text. A message that
 * needs more is a message that should be split.
 */
export interface MessagePartLike {
	type: string;
	value?: string;
	name?: string;
}

export type RichSegment = { tag?: undefined; text: string } | { tag: string; text: string };

export function richSegments(parts: readonly MessagePartLike[]): RichSegment[] {
	const out: RichSegment[] = [];
	let open: string | undefined;
	let inner = "";
	for (const part of parts) {
		if (part.type === "markup-start" && open === undefined && part.name) {
			open = part.name;
			inner = "";
		} else if (part.type === "markup-end" && open !== undefined && part.name === open) {
			out.push({ tag: open, text: inner });
			open = undefined;
		} else if (part.type === "text" || part.type === "markup-standalone") {
			const text = part.type === "text" ? (part.value ?? "") : "";
			if (open !== undefined) inner += text;
			else if (text) out.push({ text });
		}
	}
	return out;
}
