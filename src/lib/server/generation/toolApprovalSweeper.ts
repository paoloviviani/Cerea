import { randomUUID } from "crypto";
import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { onExit } from "$lib/server/exitHandler";
import { models } from "$lib/server/models";
import { buildSubtree } from "$lib/utils/tree/buildSubtree";
import { textGeneration } from "$lib/server/textGeneration";
import { isMlAssistantConversation } from "$lib/server/mlAssistant";
import { mlAssistantProviderFor } from "$lib/server/mlAssistantModels";
import { ML_ASSISTANT_EFFORT } from "$lib/constants/mlAssistant";
import { resumeParkedToolCall } from "$lib/server/mcp/resumeElicitation";
import {
	MessageUpdateStatus,
	MessageUpdateType,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import type { McpElicitation } from "$lib/types/McpElicitation";
import type { TextGenerationContext } from "$lib/server/textGeneration/types";
import { createGenerationWriter } from "./writer";
import { applyUpdateToMessage } from "./applyUpdate";
import { turnEnded, turnRunning } from "./turnState";
import { compressUpdatesForStorage } from "./compressUpdates";

const SWEEP_BATCH = 20;
const SWEEP_INTERVAL_MS = 30_000;

/**
 * Deny-timeout sweep for the tool-approval gate (ADR 0075): "unanswered
 * approvals fail closed... nobody watching means no approval, never
 * auto-approval." A tool-approval prompt carries `expiresAt`
 * (`openToolApprovalPrompt`, reusing `getElicitationTimeoutMs()`) precisely
 * so this sweep — not a live request — is what closes it out. Modeled on
 * `parkedSweeper.ts`'s resume, but keyed off `mcpElicitations` (the
 * click-driven answer path this reuses) rather than `parkedCalls`.
 */

/** Atomic claim: the CAS on `status: "pending"` means only one pod wins a given expired row. */
async function claimExpired(): Promise<McpElicitation | null> {
	const now = new Date();
	const claimed = await collections.mcpElicitations.findOneAndUpdate(
		{ status: "pending", "pending.kind": "tool-approval", expiresAt: { $lte: now } },
		{ $set: { status: "resolved", action: "decline", resolvedAt: now, updatedAt: now } },
		{ returnDocument: "after" }
	);
	// Driver v5: findOneAndUpdate returns ModifyResult unless told otherwise.
	return claimed?.value ?? null;
}

/**
 * Rebuild the identity the parked turn ran as. There is no request to read one
 * from, so it comes from whoever opened the prompt (`PendingToolApprovalCall.userId`/
 * `sessionId`) and the stored session — a resume can only ever act as that user.
 */
async function rebuildIdentity(userId?: ObjectId, sessionId?: string) {
	const user = userId
		? ((await collections.users.findOne({ _id: userId })) ?? undefined)
		: undefined;
	const session = userId
		? await collections.sessions.find({ userId }).sort({ updatedAt: -1 }).next()
		: sessionId
			? await collections.sessions.findOne({ sessionId })
			: null;
	const token = session?.oauth?.token;
	const tokenExpired = Boolean(token?.expiresAt && token.expiresAt.getTime() <= Date.now());
	const settings = await collections.settings.findOne(
		userId ? { userId } : { sessionId: sessionId ?? "" }
	);
	return {
		locals: {
			user,
			sessionId: session?.sessionId ?? sessionId ?? "",
			isAdmin: false,
			...(token?.value && !tokenExpired ? { token: token.value } : {}),
			...(settings?.billingOrganization
				? { billingOrganization: settings.billingOrganization }
				: {}),
		} as unknown as App.Locals,
		settings,
	};
}

/** Deny one expired prompt (already claimed) and let the parked turn continue with the refusal. */
async function denyAndResume(row: McpElicitation): Promise<void> {
	const pending = row.pending;
	// `claimExpired` only ever claims a `pending.kind === "tool-approval"` row.
	if (!pending || pending.kind !== "tool-approval") return;

	const conv = await collections.conversations.findOne({ _id: row.conversationId });
	if (!conv) return;
	const message = conv.messages.find((m) => m.id === pending.messageId);
	if (!message || message.from !== "assistant") return;
	const model = models.find((m) => m.id === conv.model);
	if (!model) return;

	const { locals, settings } = await rebuildIdentity(pending.userId, pending.sessionId);

	const generationId = randomUUID();
	const promptedAt = new Date();
	const abortController = new AbortController();

	message.generationId = generationId;
	await collections.conversations.updateOne(
		{ _id: conv._id, "messages.id": message.id },
		{ $set: { "messages.$.generationId": generationId, updatedAt: new Date() } }
	);

	const writer = await createGenerationWriter({
		generationId,
		conversationId: conv._id,
		messageId: message.id,
		continueFromSeq: message.materializedSeq,
		...(pending.userId ? { userId: pending.userId } : {}),
		...(locals.sessionId ? { sessionId: locals.sessionId } : {}),
		snapshot: () => ({
			content: message.content,
			reasoning: message.reasoning,
			files: message.files,
			routerMetadata: message.routerMetadata,
			updates: compressUpdatesForStorage(message.updates),
		}),
	});

	const apply = (event: MessageUpdate) => {
		const applied = applyUpdateToMessage(event, {
			message,
			conv,
			initialContent: message.content,
			isRouterModel: Boolean(model.isRouter),
		});
		if (applied.skipped) return;
		writer.push(event);
	};

	const persist = async () => {
		message.materializedSeq = writer.currentSeq();
		await collections.conversations.updateOne(
			{ _id: conv._id },
			{
				$set: {
					messages: conv.messages.map((m) => ({
						...m,
						updates: compressUpdatesForStorage(m.updates),
					})),
					updatedAt: new Date(),
				},
			}
		);
	};

	const turnKey = {
		conversationId: conv._id,
		messageId: message.id,
		producerId: generationId,
		...(pending.userId ? { userId: pending.userId } : {}),
		...(locals.sessionId ? { sessionId: locals.sessionId } : {}),
	};

	let hasError = false;
	try {
		apply(await turnRunning(turnKey));

		// Already denied by the claim above; this re-issues nothing (the call
		// never ran) and just produces the refusal the model reads.
		const outcome = await resumeParkedToolCall({
			conversationId: conv._id,
			elicitationId: row.elicitationId,
			generationId,
		});
		for (const update of outcome.updates) apply(update);

		// A queued call behind this one may itself need its own prompt: leave
		// the turn parked on THAT one rather than continuing the model now.
		if (!outcome.parkedAgain) {
			const ctx: TextGenerationContext = {
				model,
				endpoint: await model.getEndpoint(),
				conv,
				messages: buildSubtree(conv, message.id),
				promptedAt,
				ip: "tool-approval-sweeper",
				username: locals.user?.username,
				forceMultimodal: !config.isHuggingChat
					? settings?.multimodalOverrides?.[model.id]
					: undefined,
				forceTools: !config.isHuggingChat ? settings?.toolsOverrides?.[model.id] : undefined,
				provider:
					config.isHuggingChat && !model.isRouter
						? isMlAssistantConversation(conv)
							? mlAssistantProviderFor(model.id, settings?.providerOverrides?.[model.id])
							: settings?.providerOverrides?.[model.id]
						: undefined,
				reasoningEffort: isMlAssistantConversation(conv)
					? ML_ASSISTANT_EFFORT
					: settings?.reasoningEffortOverrides?.[model.id],
				reasoningOverride: settings?.reasoningOverrides?.[model.id],
				artifactsOverride: settings?.artifactsOverrides?.[model.id],
				locals,
				abortController,
				generationId,
				messageId: message.id,
			};
			for await (const event of textGeneration(ctx)) apply(event);
		}

		apply({ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished });
		const endedUpdate = await turnEnded(turnKey, { failed: false });
		if (endedUpdate) apply(endedUpdate);
	} catch (err) {
		hasError = true;
		logger.error(
			{ err, elicitationId: row.elicitationId },
			"[tool-approval] deny-timeout resume failed"
		);
		const errorMessage = err instanceof Error ? err.message : "The resumed turn failed.";
		apply({
			type: MessageUpdateType.Status,
			status: MessageUpdateStatus.Error,
			message: errorMessage,
		});
		const failedUpdate = await turnEnded(turnKey, { failed: true, error: errorMessage });
		if (failedUpdate) apply(failedUpdate);
	} finally {
		await persist();
		await writer.finish({ status: hasError ? "error" : "completed" });
	}
}

export async function sweepExpiredToolApprovals(): Promise<void> {
	for (let i = 0; i < SWEEP_BATCH; i += 1) {
		const row = await claimExpired();
		if (!row) return;
		await denyAndResume(row).catch((err) =>
			logger.error(
				{ err, elicitationId: row.elicitationId },
				"[tool-approval] deny-timeout sweep failed"
			)
		);
	}
}

export class ToolApprovalSweeper {
	private static instance: ToolApprovalSweeper;

	private constructor() {
		const interval = setInterval(() => {
			sweepExpiredToolApprovals().catch((err) =>
				logger.error({ err }, "[tool-approval] deny-timeout sweep failed")
			);
		}, SWEEP_INTERVAL_MS);
		interval.unref?.();
		onExit(() => clearInterval(interval));
	}

	public static getInstance(): ToolApprovalSweeper {
		if (!ToolApprovalSweeper.instance) {
			ToolApprovalSweeper.instance = new ToolApprovalSweeper();
		}
		return ToolApprovalSweeper.instance;
	}
}
