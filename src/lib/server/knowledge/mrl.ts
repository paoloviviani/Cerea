/**
 * Client-side Matryoshka (MRL) truncation for embeddings wider than the store
 * indexes.
 *
 * Some providers (Cortecs, for qwen3-embedding-8b) ignore the `dimensions`
 * request parameter and answer at the native width. For a model trained with
 * Matryoshka representation learning, the leading N components of the vector
 * are themselves a good N-wide embedding once renormalised, so cutting the
 * vector here is the same operation a provider that honours `dimensions` does
 * server-side. For any other model a cut vector is meaningless, so those keep
 * failing, honestly.
 *
 * The list is an allowlist: a model joins it only when its authors document
 * MRL training. Matched case-insensitively as a substring of the model id, so
 * provider prefixes ("cortecs/", "Qwen/") and size suffixes ("-8b") match.
 */
const MRL_FAMILIES: { match: string; source: string }[] = [
	// Qwen3 Embedding model cards: "MRL Support" for custom output dimensions.
	{ match: "qwen3-embedding", source: "huggingface.co/Qwen/Qwen3-Embedding-8B" },
	// OpenAI, "New embedding models and API updates" (2024-01-25): both are
	// trained so embeddings can be shortened via `dimensions`.
	{
		match: "text-embedding-3-small",
		source: "openai.com/index/new-embedding-models-and-api-updates",
	},
	{
		match: "text-embedding-3-large",
		source: "openai.com/index/new-embedding-models-and-api-updates",
	},
	// Nomic Embed Text v1.5 and v2 model cards: Matryoshka, 768 down to 64 (v2: 256).
	{ match: "nomic-embed-text-v1.5", source: "huggingface.co/nomic-ai/nomic-embed-text-v1.5" },
	{ match: "nomic-embed-text-v2", source: "huggingface.co/nomic-ai/nomic-embed-text-v2-moe" },
	// Jina embeddings v3 and v4 model cards: MRL-trained, truncatable.
	{ match: "jina-embeddings-v3", source: "huggingface.co/jinaai/jina-embeddings-v3" },
	{ match: "jina-embeddings-v4", source: "huggingface.co/jinaai/jina-embeddings-v4" },
	// Mixedbread's mxbai-embed-large-v1 post "64 bytes per embedding": MRL + binary quantisation.
	{ match: "mxbai-embed-large", source: "mixedbread.ai/blog/binary-mrl" },
	// Snowflake Arctic Embed L v2.0 model card: MRL-trained, truncatable to 256.
	{
		match: "snowflake-arctic-embed-l-v2",
		source: "huggingface.co/Snowflake/snowflake-arctic-embed-l-v2.0",
	},
];

/** The allowlisted family names, for messages and docs. */
export const MRL_MODEL_FAMILIES: readonly string[] = MRL_FAMILIES.map((f) => f.match);

export function isMrlModel(model: string): boolean {
	const id = model.toLowerCase();
	return MRL_FAMILIES.some((f) => id.includes(f.match));
}

/** The first `width` components, scaled to unit length. */
export function truncateRenormalise(vector: number[], width: number): number[] {
	const cut = vector.slice(0, width);
	let sum = 0;
	for (const v of cut) sum += v * v;
	const norm = Math.sqrt(sum);
	return norm > 0 ? cut.map((v) => v / norm) : cut;
}

/** The refusal for a model too wide for the store that is not known to be MRL. */
export function tooWideMessage(width: number, indexed: readonly number[], model: string): string {
	return (
		`The embedding model returns ${width} dimensions; this store indexes ${indexed.join(", ")}. ` +
		`Vectors are cut to fit only for known Matryoshka models (${MRL_MODEL_FAMILIES.join(", ")}), and "${model}" is not one of them.`
	);
}
