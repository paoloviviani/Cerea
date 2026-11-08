/**
 * Instruction prefixes for embedding models.
 *
 * Some models are trained with a prefix on what they embed (e5: `query: ` and
 * `passage: `) and are less accurate without it. The prefixes are optional,
 * empty by default, and added only where the text goes to the embeddings
 * route: never stored in a chunk, a citation or anything a user reads.
 * Shared by the server and the admin screen.
 */

export const MAX_PREFIX_LENGTH = 200;

export interface PrefixPreset {
	name: string;
	query: string;
	passage: string;
}

/** What the model's own card documents. bge v1.5 prefixes queries only. */
export const PRESETS = {
	e5: { name: "e5", query: "query: ", passage: "passage: " },
	bge: {
		name: "bge v1.5",
		query: "Represent this sentence for searching relevant passages: ",
		passage: "",
	},
	nomic: { name: "nomic", query: "search_query: ", passage: "search_document: " },
} satisfies Record<string, PrefixPreset>;

/** The preset for a model id, or null when it is not one we know. */
export function detectPreset(modelId: string | null | undefined): PrefixPreset | null {
	const id = (modelId ?? "").toLowerCase();
	if (!id) return null;
	if (/(^|[^a-z0-9])e5([^a-z0-9]|$)/.test(id)) return PRESETS.e5;
	if (/bge-.*v1\.5/.test(id)) return PRESETS.bge;
	if (id.includes("nomic")) return PRESETS.nomic;
	return null;
}

/** An error message, or null when the prefix is acceptable. */
export function validatePrefix(value: unknown): string | null {
	if (typeof value !== "string") return "A prefix must be text.";
	if (value.length > MAX_PREFIX_LENGTH) {
		return `A prefix can be at most ${MAX_PREFIX_LENGTH} characters.`;
	}
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
		return "A prefix cannot contain control characters.";
	}
	return null;
}

/** The text as the model should see it; never prefixes twice. */
export function applyPrefix(prefix: string | null | undefined, text: string): string {
	if (!prefix || text.startsWith(prefix)) return text;
	return prefix + text;
}

/** Has the passage prefix moved since a base was indexed? Absent means empty. */
export function passagePrefixChanged(
	recorded: string | null | undefined,
	current: string | null | undefined
): boolean {
	return (recorded ?? "") !== (current ?? "");
}

/**
 * Which prefix an embed call takes. `passage` is indexed content and uses the
 * prefix the base was indexed with (so new documents match its existing
 * vectors); `query` is a search input and uses the current query prefix, or
 * the one recorded with the base while it is still on an older model.
 */
export function prefixFor(
	kind: "passage" | "query",
	base: { embeddingModel: string | null; passagePrefix?: string; queryPrefix?: string },
	current: { embeddingModel: string | null; queryPrefix?: string }
): string {
	if (kind === "passage") return base.passagePrefix ?? "";
	return base.embeddingModel === current.embeddingModel
		? (current.queryPrefix ?? "")
		: (base.queryPrefix ?? "");
}
