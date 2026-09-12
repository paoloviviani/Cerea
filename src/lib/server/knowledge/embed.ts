/**
 * Embedding through the gateway, as the person whose text this is (ADR 0070).
 *
 * The gateway's job in the knowledge pipeline is exactly two inference
 * services, and this is the first: an embedding model, catalogue-managed,
 * metered and billed to the caller. Chunks are embedded with the *owner's*
 * token (their document, their spend); a search query with the *base's* owner,
 * so a shared base's retrieval cost lands on whoever shares it, not on whoever
 * happened to ask.
 */
import { gateway, GatewayCallFailed } from "$lib/server/gatewayServer";
import { logger } from "$lib/server/logger";

export interface Embedding {
	index: number;
	embedding: number[];
}

/** One embedding call, up to `texts.length` vectors in one request. */
export async function embed(token: string, model: string, texts: string[]): Promise<number[][]> {
	if (texts.length === 0) return [];
	try {
		const answer = await gateway.post<{ data: Embedding[] }>(token, "embeddings", {
			model,
			input: texts,
		});
		const byIndex = new Map(answer.data.map((row) => [row.index, row.embedding]));
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i++) {
			const vector = byIndex.get(i);
			if (!vector) {
				throw new GatewayCallFailed(502, "The embedding response skipped an input.");
			}
			out.push(vector);
		}
		return out;
	} catch (err) {
		if (err instanceof GatewayCallFailed) {
			logger.warn({ err, model }, "knowledge_embed_failed");
			throw err;
		}
		throw new GatewayCallFailed(502, "The embedding call could not be made.");
	}
}
