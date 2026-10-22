import { currentTimeLine } from "./utils/clock";
import { artifactsEnabledForTurn, artifactsModeForTurn, injectArtifactsPrompt } from "./artifacts";
import type { ArtifactsMode } from "./artifacts";
import { injectExecutionPrompt } from "./executionPrompt";

export interface PrepromptInput {
	/** The conversation's stored system prompt. */
	conversationPreprompt?: string;
	/** The person's global system prompt (settings); every chat turn. */
	globalPrompt?: string;
	/**
	 * The person's opt-in location line (`locationLine`), or undefined. Reads
	 * last among the user's own parts: it is context, not an instruction.
	 */
	locationLine?: string;
	/** The prompt of the custom model the conversation is on, if any. */
	customModelPrompt?: string;
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
	/** IANA zone from the request, so the stamped time is the user's. */
	timezone?: string;
	/** Injectable clock, for tests. */
	now?: Date;
	/**
	 * The turn's skill context (Phase 1, ADR 0072): stage-1 frontmatter for
	 * every enabled skill plus bodies for `@name` mentions. Appended after
	 * the execution prompt it builds on — skills are carried out through
	 * those same sandbox channels.
	 */
	skillsPreprompt?: string;
}

/**
 * The person's own instructions for a chat turn, in the one order they apply:
 * their global prompt, then the custom model's prompt, then the conversation's
 * stored prompt (the deployment model's default, or an imported share's), then
 * the one-line location the person opted to share, if any.
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
	locationLine,
}: Pick<
	PrepromptInput,
	"globalPrompt" | "customModelPrompt" | "conversationPreprompt" | "locationLine"
>): string {
	return [globalPrompt, customModelPrompt, conversationPreprompt, locationLine]
		.map((part) => part?.trim())
		.filter((part): part is string => Boolean(part))
		.join("\n\n");
}

/**
 * The system prompt for one generation.
 *
 * Artifacts are opt-in per model with a per-model user override. In tool mode
 * the tag grammar is dropped entirely: the tool description carries the
 * contract, and the model must never write tags.
 */
export function resolvePreprompt({
	conversationPreprompt,
	globalPrompt,
	customModelPrompt,
	locationLine,
	artifactsOverride,
	supportsArtifacts,
	supportsTools,
	forceTools,
	artifactsMode,
	timezone,
	now,
	skillsPreprompt,
}: PrepromptInput): string | undefined {
	const base = composeUserPrompt({
		globalPrompt,
		customModelPrompt,
		conversationPreprompt,
		locationLine,
	});
	const toolsEnabled = forceTools ?? supportsTools ?? false;
	const artifacts = artifactsEnabledForTurn({
		artifactsOverride,
		supportsArtifacts,
		supportsTools,
	});
	// In tool mode the grammar leaves the system message: the tool description
	// teaches the contract instead.
	const mode = artifactsModeForTurn({
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
	// cacheable prefix.
	return `${withSkills}\n\n${currentTimeLine(now ?? new Date(), timezone)}`;
}
