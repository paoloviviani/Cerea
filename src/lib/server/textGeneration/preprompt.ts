import { currentTimeLine } from "./utils/clock";
import { artifactsEnabledForTurn, artifactsModeForTurn, injectArtifactsPrompt } from "./artifacts";
import type { ArtifactsMode } from "./artifacts";
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
	/** The person's global system prompt (settings); every chat turn. */
	globalPrompt?: string;
	/** The prompt of the custom model the conversation is on, if any. */
	customModelPrompt?: string;
	/** Whether this conversation runs the ML Assistant preset. */
	mlAssistant: boolean;
	/** Per-model user override for artifacts, from the model settings page. */
	artifactsOverride?: boolean;
	/** Whether the model advertises artifact support (supportsArtifacts). */
	supportsArtifacts?: boolean;
	/** Whether the model advertises tool calling (supportsTools). Decides tool-vs-tags mode. */
	supportsTools?: boolean;
	/** Per-model user override for tool calling; wins over supportsTools in both directions. */
	forceTools?: boolean;
	/**
	 * Explicit per-model artifact surface override. Wins over the default
	 * (`"tool"` when tools are on, else `"tags"`); presets may set one.
	 */
	artifactsMode?: ArtifactsMode;
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
 * The person's own instructions for a chat turn, in the one order they apply:
 * their global prompt, then the custom model's prompt, then the conversation's
 * stored prompt (the deployment model's default, or an imported share's).
 * Empty and whitespace-only parts are skipped, so an unset global prompt leaves
 * no stray blank lines. Everything `resolvePreprompt` adds after this (the
 * artifacts and execution contracts, skills) and everything the turn appends
 * after it (memory, then the project's context) reads below these.
 *
 * The one function that composes them: a caller never joins prompts itself.
 */
export function composeUserPrompt({
	globalPrompt,
	customModelPrompt,
	conversationPreprompt,
}: Pick<PrepromptInput, "globalPrompt" | "customModelPrompt" | "conversationPreprompt">): string {
	return [globalPrompt, customModelPrompt, conversationPreprompt]
		.map((part) => part?.trim())
		.filter((part): part is string => Boolean(part))
		.join("\n\n");
}

/**
 * The system prompt for one generation.
 *
 * Artifacts are unchanged by the preset outside tool mode: outside it they
 * stay opt-in per model with a per-model user override, exactly as before.
 * The preset force-enables them on top of that — it is not a gate, and a
 * conversation that would have got the artifacts prompt still gets it whether
 * or not the mode exists. In tool mode the tag grammar is dropped entirely:
 * the tool description carries the contract, and the model must never write
 * tags.
 */
export function resolvePreprompt({
	conversationPreprompt,
	globalPrompt,
	customModelPrompt,
	mlAssistant,
	artifactsOverride,
	supportsArtifacts,
	supportsTools,
	forceTools,
	artifactsMode,
	username,
	timezone,
	now,
	budget,
	skillsPreprompt,
}: PrepromptInput): string | undefined {
	// The ML Assistant preset supplies the whole system prompt, so neither the
	// global prompt nor a custom model's reaches it.
	const base = mlAssistant
		? ML_ASSISTANT_PREPROMPT
		: composeUserPrompt({ globalPrompt, customModelPrompt, conversationPreprompt });
	const toolsEnabled = mlAssistant
		? (supportsTools ?? false)
		: (forceTools ?? supportsTools ?? false);
	const artifacts = artifactsEnabledForTurn({
		mlAssistant,
		artifactsOverride,
		supportsArtifacts,
		supportsTools,
	});
	// In tool mode the grammar leaves the system message: the tool description
	// teaches the contract instead, which is also what keeps the ML-preset
	// ceiling test green.
	const mode = artifactsModeForTurn({
		mlAssistant,
		artifactsOverride,
		supportsArtifacts,
		supportsTools,
		toolsEnabled,
		artifactsMode,
	});
	const withArtifacts = artifacts && mode === "tags" ? injectArtifactsPrompt(base) : base;
	// Execution is a client capability, so the prompt is unconditional: models
	// must know python blocks auto-run in the browser and that they never see
	// the output themselves.
	const resolved = injectExecutionPrompt(withArtifacts);
	// Skills ride on top of the execution contract: a skill body is a
	// procedure the model carries out through those same channels, never
	// execution of its own.
	const withSkills = skillsPreprompt ? `${resolved}\n\n${skillsPreprompt}` : resolved;
	// The one line that says when it is now, for every turn, in the user's zone.
	// At the end: it changes by the minute, so everything above it stays a
	// cacheable prefix. The ML preset states the date and time in its own
	// session context below, so it gets no second one.
	if (!mlAssistant) return `${withSkills}\n\n${currentTimeLine(now ?? new Date(), timezone)}`;
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
