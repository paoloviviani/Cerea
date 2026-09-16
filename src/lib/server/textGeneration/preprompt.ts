import { injectArtifactsPrompt } from "./artifacts";
import { injectExecutionPrompt } from "./executionPrompt";
import {
	ML_ASSISTANT_BUDGET_RULES,
	ML_ASSISTANT_PREPROMPT,
	mlAssistantSessionContext,
} from "$lib/server/mlAssistantPrompt";
import type { MlBudget } from "$lib/types/Conversation";
import { formatMicroUsd, remainingMicroUsd } from "$lib/utils/mlBudget";

export interface PrepromptInput {
	/** The conversation's stored system prompt. */
	conversationPreprompt?: string;
	/** Whether this conversation runs the ML Assistant preset. */
	mlAssistant: boolean;
	/** Per-model user override for artifacts, from the model settings page. */
	artifactsOverride?: boolean;
	/** Whether the model advertises artifact support (supportsArtifacts). */
	supportsArtifacts?: boolean;
	/** Signed-in user's Hub username. The preset's namespace rule reads it back. */
	username?: string;
	/** IANA zone from the request, so the stamped time is the user's. */
	timezone?: string;
	/** Injectable clock, for tests. */
	now?: Date;
	/** The conversation's compute budget; presence turns on the budget rules. */
	budget?: MlBudget;
	/**
	 * The turn's skill context (Phase 1, ADR 0072): stage-1 frontmatter for
	 * every enabled skill plus bodies for `@name` mentions. Appended after
	 * the execution prompt it builds on — skills are carried out through
	 * those same sandbox channels — and before the ML budget lines, which
	 * stay last where the namespace rule reads them.
	 */
	skillsPreprompt?: string;
}

/**
 * The system prompt for one generation.
 *
 * Artifacts are unchanged by the preset: outside it they stay opt-in per model
 * with a per-model user override, exactly as before. The preset force-enables
 * them on top of that — it is not a gate, and a conversation that would have got
 * the artifacts prompt still gets it whether or not the mode exists.
 */
export function resolvePreprompt({
	conversationPreprompt,
	mlAssistant,
	artifactsOverride,
	supportsArtifacts,
	username,
	timezone,
	now,
	budget,
	skillsPreprompt,
}: PrepromptInput): string | undefined {
	const base = mlAssistant ? ML_ASSISTANT_PREPROMPT : conversationPreprompt;
	const artifacts = mlAssistant || (artifactsOverride ?? supportsArtifacts);
	// Execution is a client capability, so the prompt is unconditional: models
	// must know python blocks auto-run in the browser and that they never see
	// the output themselves.
	const resolved = injectExecutionPrompt(artifacts ? injectArtifactsPrompt(base) : base);
	// Skills ride on top of the execution contract: a skill body is a
	// procedure the model carries out through those same channels, never
	// execution of its own.
	const withSkills = skillsPreprompt ? `${resolved}\n\n${skillsPreprompt}` : resolved;
	if (!mlAssistant) return withSkills;
	// The mode is always budget-gated; a conversation without a stored budget is
	// a zero budget, and the rules — including how to ask for a grant — must
	// reach the model exactly then.
	const effective = budget ?? { totalMicroUsd: 0, spentMicroUsd: 0, reservations: [] };
	// Stamped last, after the artifacts prompt, because the preset reads the User
	// value back out of it — and stamped here rather than onto the tool preprompt
	// so it still reaches the model on the plain generation path, which has none.
	return `${withSkills}\n\n${ML_ASSISTANT_BUDGET_RULES}\n\n${mlAssistantSessionContext({
		username,
		timezone,
		now,
		budget: {
			remaining: formatMicroUsd(remainingMicroUsd(effective)),
			total: formatMicroUsd(effective.totalMicroUsd),
		},
	})}`;
}
