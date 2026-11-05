import { config } from "$lib/server/config";
import { gateway } from "$lib/server/gatewayServer";
import { logger } from "$lib/server/logger";

/** The `kind: decision` models this token may use, straight from the gateway's catalogue. */
export async function probeDecisionModels(
	token: string | undefined
): Promise<{ models: string[]; reachable: boolean; configured: boolean }> {
	if (!config.OPENAI_BASE_URL || !token) return { models: [], reachable: false, configured: false };
	try {
		const answer = await gateway.get<{ data: { id: string; kind?: string }[] }>(
			token,
			"models?include=decision",
			{ timeoutMs: 2000 }
		);
		return {
			models: answer.data.filter((card) => card.kind === "decision").map((card) => card.id),
			reachable: true,
			configured: true,
		};
	} catch (err) {
		logger.warn({ err }, "agent_review: could not list decision models");
		return { models: [], reachable: false, configured: true };
	}
}
