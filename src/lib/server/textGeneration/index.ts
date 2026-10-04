import { preprocessMessages } from "../endpoints/preprocessMessages";

import { generateTitleForConversation } from "./title";
import {
	type MessageUpdate,
	MessageUpdateType,
	MessageUpdateStatus,
} from "$lib/types/MessageUpdate";
import { generate } from "./generate";
import { runMcpFlow } from "./mcp/runMcpFlow";
import { mergeAsyncGenerators } from "$lib/utils/mergeAsyncGenerators";
import type { TextGenerationContext } from "./types";
import { isMlAssistantConversation, pinnedHubToken } from "$lib/server/mlAssistant";
import { settleMlBudget } from "$lib/server/mlBudget/settle";
import { reservedMicroUsd } from "$lib/utils/mlBudget";
import { logger } from "$lib/server/logger";
import { modelReadsImages } from "./utils/modelReadsImages";
import { resolvePreprompt } from "./preprompt";
import { collections } from "$lib/server/database";
import { projectContext } from "$lib/server/projects";

/** Updates that mean the user has already been shown something for this turn. */
function isVisibleWork(update: MessageUpdate): boolean {
	return (
		update.type === MessageUpdateType.Stream ||
		update.type === MessageUpdateType.Tool ||
		update.type === MessageUpdateType.Reasoning ||
		update.type === MessageUpdateType.FinalAnswer
	);
}

async function* keepAlive(done: AbortSignal): AsyncGenerator<MessageUpdate, undefined, undefined> {
	while (!done.aborted) {
		yield {
			type: MessageUpdateType.Status,
			status: MessageUpdateStatus.KeepAlive,
		};
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

export async function* textGeneration(ctx: TextGenerationContext) {
	const done = new AbortController();

	const titleGen = generateTitleForConversation(ctx.conv, ctx.locals);
	const textGen = textGenerationWithoutTitle(ctx, done);
	const keepAliveGen = keepAlive(done.signal);

	// keep alive until textGen is done

	yield* mergeAsyncGenerators([titleGen, textGen, keepAliveGen]);
}

async function* textGenerationWithoutTitle(
	ctx: TextGenerationContext,
	done: AbortController
): AsyncGenerator<MessageUpdate, undefined, undefined> {
	yield {
		type: MessageUpdateType.Status,
		status: MessageUpdateStatus.Started,
	};

	const { conv, messages } = ctx;
	const convId = conv._id;

	// ML Assistant conversations run the preset instead of the user's per-model
	// custom prompt, and get its capabilities regardless of what the model
	// advertises: the preset is a mode, not a set of defaults to fall back from.
	// Outside it nothing changes — artifacts stay opt-in per model.
	const mlAssistant = isMlAssistantConversation(conv);

	// Settle finished jobs before the remaining budget is read anywhere this
	// turn — the session-context line and the gate must both see refunds land.
	if (mlAssistant && conv.mlBudget) {
		try {
			// Same effective credential as dispatch: an operator-pinned Hub entry
			// launched the jobs, so it is what can read them back; the user's own
			// token otherwise.
			const token =
				pinnedHubToken() ??
				(ctx.locals as unknown as { hfAccessToken?: string } | undefined)?.hfAccessToken ??
				(ctx.locals as unknown as { token?: string } | undefined)?.token;
			const settled = await settleMlBudget({
				conversationId: convId,
				budget: conv.mlBudget,
				...(token ? { token } : {}),
			});
			// A changed ledger must reach the strip now: the guard only emits on
			// gated calls, so a turn of text or log reads would otherwise leave the
			// old hold on screen after the refund landed.
			if (settled !== conv.mlBudget) {
				conv.mlBudget = settled;
				yield {
					type: MessageUpdateType.Budget,
					totalMicroUsd: settled.totalMicroUsd,
					spentMicroUsd: settled.spentMicroUsd,
					reservedMicroUsd: reservedMicroUsd(settled),
				};
			}
		} catch (err) {
			// A failed settle only leaves holds in place — safe to run the turn on.
			logger.warn({ err: String(err) }, "[mlBudget] settle pass failed; continuing");
		}
	}

	// Skills (Phase 1, ADR 0072): stage-1 frontmatter rides every turn and
	// `@name` mentions in the latest user message load bodies up front; the
	// model loads further bodies mid-turn itself, through `load_skill`.
	// Retrieval never fails a turn, like project context below: a store
	// that cannot be read contributes no skills, not no answer.
	let skillsPreprompt: string | undefined;
	try {
		const { assembleSkillsContext } = await import("$lib/server/skills/prompt");
		const skillsUserId = (
			ctx.locals as unknown as { user?: { _id?: import("mongodb").ObjectId } } | undefined
		)?.user?._id;
		const lastUserMessage = [...messages].reverse().find((message) => message.from === "user");
		skillsPreprompt = (await assembleSkillsContext(skillsUserId, lastUserMessage?.content ?? ""))
			.preprompt;
	} catch (err) {
		logger.warn({ err: String(err) }, "[skills] skill context failed; continuing without it");
	}

	let preprompt = resolvePreprompt({
		conversationPreprompt: conv.preprompt,
		mlAssistant,
		artifactsOverride: ctx.artifactsOverride,
		supportsArtifacts: ctx.model.supportsArtifacts,
		supportsTools: (ctx.model as unknown as { supportsTools?: boolean }).supportsTools,
		forceTools: ctx.forceTools,
		artifactsMode: (ctx.model as unknown as { artifactsMode?: "tool" | "tags" }).artifactsMode,
		username: ctx.username,
		timezone: (ctx.locals as unknown as { timezone?: string } | undefined)?.timezone,
		budget: conv.mlBudget,
		skillsPreprompt,
	});

	// Standing facts about this person, carried in from earlier conversations
	// (see `$lib/types/Memory`). Appended after `resolvePreprompt` for the
	// reason the project block below is, and *before* it: the conversation's
	// own prompt keeps precedence over both, and a fact about the person is
	// more general than passages retrieved for this one question, so it reads
	// in the order a person would write it.
	//
	// Gated twice, exactly like the `remember`/`forget` tools: the operator's
	// deployment flag and this person's own opt-in, which defaults off. An
	// anonymous turn has no memory at all — there is nowhere durable to keep
	// a fact without a user. The whole block is a try/catch that logs and
	// continues, the same posture as the skills assembly above and
	// `projectContext` below: a store that cannot be read is a reason for a
	// worse answer, never for none.
	try {
		const memoryUserId = ctx.locals?.user?._id;
		if (memoryUserId) {
			const { memoryEnabled } = await import("$lib/server/memoryEnabled");
			if (memoryEnabled()) {
				const settings = await collections.settings.findOne({ userId: memoryUserId as never });
				if (settings?.memoryEnabled === true) {
					const { memoryContext } = await import("$lib/server/memory/service");
					const block = await memoryContext(memoryUserId);
					if (block) preprompt = preprompt ? `${preprompt}\n\n${block}` : block;
				}
			}
		}
	} catch (err) {
		logger.warn({ err: String(err) }, "[memory] memory context failed; continuing without it");
	}

	// A project's standing context, and whatever its knowledge bases — plus any
	// bases attached to this conversation from the composer — offer for this
	// question. Appended to the system prompt rather than mixed into
	// `resolvePreprompt`, and the ordering is the point: the conversation's own
	// prompt — the user's per-model custom prompt, or the ML Assistant preset —
	// keeps precedence, and the project adds to it.
	//
	// The two sources of bases are additive: the conversation's own bases join
	// the project's candidate pool and never replace it. Retrieval runs with
	// the *reader's* token, so a shared project — or an attached base —
	// retrieves only from stores they can already see. It cannot fail the
	// turn: every error inside is logged and swallowed, because a knowledge
	// base being unavailable is a reason for a worse answer and not for no
	// answer (ADR 0062).
	if (conv.projectId || conv.knowledgeBaseIds?.length) {
		const project = conv.projectId
			? ((await collections.projects.findOne({ _id: conv.projectId })) ?? undefined)
			: undefined;
		if (project || conv.knowledgeBaseIds?.length) {
			const lastUser = [...messages].reverse().find((message) => message.from === "user");
			const context = await projectContext({
				project,
				knowledgeBaseIds: conv.knowledgeBaseIds,
				question: lastUser?.content ?? "",
				token: (ctx.locals as unknown as { token?: string } | undefined)?.token,
				locals: ctx.locals,
			});
			if (context) {
				preprompt = preprompt ? `${preprompt}\n\n${context}` : context;
			}
		}
	}

	const processedMessages = await preprocessMessages(
		messages,
		convId,
		modelReadsImages(ctx.model, ctx.forceMultimodal)
	);

	let mcpProducedOutput = false;

	// Try MCP tool flow first; fall back to default generation if not selected/available
	try {
		const mcpGen = runMcpFlow({
			model: ctx.model,
			conv,
			messages: processedMessages,
			assistant: ctx.assistant,
			forceMultimodal: ctx.forceMultimodal,
			forceTools: mlAssistant || ctx.forceTools,
			provider: ctx.provider,
			reasoningEffort: ctx.reasoningEffort,
			reasoningOverride: ctx.reasoningOverride,
			artifactsOverride: ctx.artifactsOverride,
			locals: ctx.locals,
			preprompt,
			abortSignal: ctx.abortController.signal,
			abortController: ctx.abortController,
			promptedAt: ctx.promptedAt,
			generationId: ctx.generationId,
			messageId: ctx.messageId,
		});

		let step = await mcpGen.next();
		while (!step.done) {
			if (isVisibleWork(step.value)) mcpProducedOutput = true;
			yield step.value;
			step = await mcpGen.next();
		}
		const mcpResult = step.value;
		// `!mcpProducedOutput` is not redundant with the result: runMcpFlow catches its own
		// errors, so a failure could still surface here as "not_applicable" rather than a
		// throw, and re-running would discard whatever the user has already been shown.
		if (mcpResult === "not_applicable" && !mcpProducedOutput) {
			// fallback to normal text generation
			yield* generate({ ...ctx, messages: processedMessages }, preprompt);
		}
		// Every other result already emitted a final answer; falling back would replace it.
	} catch (err) {
		// Don't fall back on abort errors - user intentionally stopped
		const isAbort =
			ctx.abortController.signal.aborted ||
			(err instanceof Error &&
				(err.name === "AbortError" ||
					err.name === "APIUserAbortError" ||
					err.message.includes("Request was aborted")));
		if (isAbort) {
			// nothing to recover; the partial message is already what the user saw
		} else if (mcpProducedOutput) {
			// Falling back here would discard the tool work and answer as if none of it ran.
			throw err;
		} else {
			// Nothing was shown yet, so a clean tool-free retry is a real recovery.
			yield* generate({ ...ctx, messages: processedMessages }, preprompt);
		}
	}
	done.abort();
}
