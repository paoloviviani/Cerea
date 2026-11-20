import { conversationOwnerFilter, resolveConversationModel } from "$lib/server/customModels";
import { effectiveReasoningEffort } from "$lib/server/reasoningEffort";
import { randomUUID } from "crypto";
import { collections } from "$lib/server/database";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { mcpLocalsFor } from "$lib/server/mcp/selection";
import { onExit } from "$lib/server/exitHandler";
import { buildSubtree } from "$lib/utils/tree/buildSubtree";
import { textGeneration } from "$lib/server/textGeneration";
import {
	buildCodeExecutionResolvedUpdate,
	codeResumeResultText,
	EXECUTE_CODE_TOOL_NAME,
} from "$lib/server/textGeneration/builtinTools/executeCodeTool";
import { ToolResultStatus } from "$lib/types/Tool";
import {
	MessageToolUpdateType,
	MessageUpdateStatus,
	MessageUpdateType,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import type { ParkedCall } from "$lib/types/ParkedCall";
import type { TextGenerationContext } from "$lib/server/textGeneration/types";
import { settleTurnCost, turnGatewayToken } from "$lib/server/turnCostSettle";
import { createGenerationWriter } from "./writer";
import { applyUpdateToMessage } from "./applyUpdate";
import {
	turnAbandoned,
	turnAwaitingInput,
	turnEnded,
	turnOrphaned,
	turnRunning,
} from "./turnState";
import { resumeParkedToolCall } from "$lib/server/mcp/resumeElicitation";
import { compressUpdatesForStorage } from "./compressUpdates";
import { deferDelayMs, liveProducerCount, otherParkedRows, roundBlocker } from "./roundJoin";

const SWEEP_BATCH = 5;
/** A row this many attempts deep is not going to resume; stop burning turns on it. */
const MAX_ATTEMPTS = 3;

function sweepIntervalMs(): number {
	const raw = config.PARKED_SWEEP_INTERVAL_MS;
	const parsed = raw ? parseInt(raw, 10) : NaN;
	return !isNaN(parsed) && parsed > 0 ? parsed : 10_000;
}

/**
 * How long a claim holds a row before another sweeper may take it. A resume that
 * dies between the claim and its own error handling — or a pod that dies at any
 * point — would otherwise strand the row in `resuming` until the TTL removed it,
 * and `attempts` would never reach the retry ceiling it exists to enforce.
 */
const CLAIM_LEASE_MS = 5 * 60_000;

/**
 * A LIVE resume renews its claim on this cadence (see resumeParkedCall), so the
 * lease only ever expires under a producer that actually died. Well under
 * CLAIM_LEASE_MS: several consecutive renewals must all fail before a row can
 * be stolen from a running resume.
 */
const LEASE_RENEW_MS = 60_000;

/**
 * Bump the claim's lease while the resume is still working. Guarded on the
 * status so a renewal racing the finally's `resumed` write can never revive a
 * finished row.
 */
export async function renewClaim(park: ParkedCall): Promise<void> {
	const now = new Date();
	await collections.parkedCalls
		.updateOne({ _id: park._id, status: "resuming" }, { $set: { takenAt: now, updatedAt: now } })
		.catch((err) =>
			logger.warn({ err, parkedCallId: park.parkedCallId }, "[parked] failed to renew claim lease")
		);
}

/**
 * Claim one due row. The filter carries the status, so two pods racing on the
 * same row produce one winner and one miss rather than two resumed turns. A
 * claim whose lease has expired is fair game again, which is what makes the
 * attempt counter meaningful.
 */
async function claimDueCall(now: Date): Promise<ParkedCall | null> {
	const claimed = await collections.parkedCalls.findOneAndUpdate(
		{
			resumeAt: { $lte: now },
			$or: [
				{ status: "waiting" },
				{ status: "resuming", takenAt: { $lt: new Date(now.getTime() - CLAIM_LEASE_MS) } },
			],
		},
		{ $set: { status: "resuming", takenAt: now, updatedAt: now }, $inc: { attempts: 1 } },
		{ sort: { resumeAt: 1 }, returnDocument: "after" }
	);
	// Driver v5: findOneAndUpdate returns ModifyResult unless told otherwise.
	return claimed?.value ?? null;
}

/**
 * Cut a wait short because the user asked to: they can see what the turn is
 * waiting for and often know it is worth a look before the timer is up.
 *
 * Moving the deadline is the ENTIRE state change. The row stays `waiting`, so
 * the ordinary claim still decides which pod resumes it and a racing sweeper
 * cannot produce a second producer for the turn. The caller kicks a sweep
 * afterwards purely so the user does not sit through the sweep interval.
 */
export async function wakeParkedCallEarly(
	conversationId: ParkedCall["conversationId"],
	messageId: string
): Promise<boolean> {
	const now = new Date();
	// A pipeline update so the deadline the model asked for is kept in the same
	// atomic write that overwrites it — the resumed round needs both to say how
	// much of the wait was skipped.
	const result = await collections.parkedCalls.updateOne(
		{ conversationId, messageId, status: "waiting" },
		[{ $set: { plannedResumeAt: "$resumeAt", resumeAt: now, wokeEarlyAt: now, updatedAt: now } }]
	);
	if (result.matchedCount === 0) return false;
	logger.info(
		{ conversationId: conversationId.toString(), messageId },
		"[parked] user asked to wake a parked turn early"
	);
	return true;
}

export async function abandon(park: ParkedCall, reason: string): Promise<void> {
	logger.warn({ parkedCallId: park.parkedCallId, reason }, "[parked] abandoning a parked call");
	await collections.parkedCalls.updateOne(
		{ _id: park._id },
		{ $set: { status: "abandoned", abandonedReason: reason, updatedAt: new Date() } }
	);
	// Close the turn too: nothing will resume it, and a `waiting` state doc
	// would read alive forever (see turnAbandoned). Persisting the terminal
	// state into the message is what lets the next snapshot clear the wait
	// banner — and makes the failed turn eligible for the Resume affordance.
	const failedUpdate = await turnAbandoned(
		park.conversationId,
		park.messageId,
		`The turn was abandoned: ${reason}.`
	);
	if (failedUpdate) {
		await collections.conversations
			.updateOne({ _id: park.conversationId, "messages.id": park.messageId }, {
				$push: { "messages.$.updates": failedUpdate },
				$set: { "messages.$.updatedAt": new Date(), updatedAt: new Date() },
			} as never)
			.catch((err) =>
				logger.error(
					{ err, parkedCallId: park.parkedCallId },
					"[parked] failed to persist the abandoned turn state"
				)
			);
	}
}

/**
 * Rebuild the identity the parked turn ran as. There is no request to read one
 * from, so it comes from the row and the stored session — which also means a
 * resume can only ever act as the user who parked it.
 *
 * An expired token is not a reason to drop the turn: the model is told, in the
 * tool result, so it can say so rather than failing opaquely on the first call.
 */
async function rebuildIdentity(park: ParkedCall) {
	const user = park.userId
		? ((await collections.users.findOne({ _id: park.userId })) ?? undefined)
		: undefined;

	const session = park.userId
		? await collections.sessions.find({ userId: park.userId }).sort({ updatedAt: -1 }).next()
		: park.sessionId
			? await collections.sessions.findOne({ sessionId: park.sessionId })
			: null;

	const token = session?.oauth?.token;
	const tokenExpired = Boolean(token?.expiresAt && token.expiresAt.getTime() <= Date.now());
	const settings = await collections.settings.findOne(
		park.userId ? { userId: park.userId } : { sessionId: park.sessionId ?? "" }
	);

	const locals: App.Locals = {
		user,
		sessionId: session?.sessionId ?? park.sessionId ?? "",
		isAdmin: false,
		...(token?.value && !tokenExpired ? { token: token.value } : {}),
		...(settings?.billingOrganization ? { billingOrganization: settings.billingOrganization } : {}),
	};
	return {
		locals,
		settings,
		tokenExpired: tokenExpired || !token?.value,
	};
}

/** Wake one parked turn: inject the tool result it parked on, then let it continue. */
export async function resumeParkedCall(park: ParkedCall): Promise<void> {
	// The claim lease exists to recover a resume whose pod DIED — but a live
	// resumed run routinely outlives it (an ML continuation runs for tens of
	// minutes). Without renewal the sweeper re-claims the row every
	// CLAIM_LEASE_MS and launches a second producer onto the same turn:
	// dueling writers over one seq range, interleaved turn states (a stale
	// `waiting` landing after the live `running` is the stuck wait banner),
	// and after MAX_ATTEMPTS the row is abandoned mid-run.
	const leaseRenewer = setInterval(() => void renewClaim(park), LEASE_RENEW_MS);
	leaseRenewer.unref?.();
	try {
		// Stopped between the claim and here: the row is abandoned, so there is nothing to start.
		const stillClaimed = await collections.parkedCalls.countDocuments({
			_id: park._id,
			status: "resuming",
		});
		if (stillClaimed === 0) return;
		await resumeParkedCallInner(park);
	} finally {
		clearInterval(leaseRenewer);
	}
}

async function resumeParkedCallInner(park: ParkedCall): Promise<void> {
	const conv = await collections.conversations.findOne({ _id: park.conversationId });
	if (!conv) return abandon(park, "conversation is gone");

	const message = conv.messages.find((m) => m.id === park.messageId);
	if (!message || message.from !== "assistant") {
		return abandon(park, "no parked assistant message to resume");
	}

	// A custom model resumes on its base, like a fresh turn (`resolveConversationModel`).
	const model = (await resolveConversationModel(conv.model, conversationOwnerFilter(conv)))?.model;
	if (!model) return abandon(park, `model ${conv.model} is no longer available`);

	// A turn that already ended (the user stopped it, or it failed) is never resumed by a late
	// answer, an expiry or a sweep.
	const ended = await collections.turnStates.findOne(
		{ conversationId: conv._id, messageId: message.id, status: { $in: ["failed", "done"] } },
		{ projection: { _id: 1 } }
	);
	if (ended) return abandon(park, "the turn already ended");

	const { locals, settings, tokenExpired } = await rebuildIdentity(park);

	// The connectors this turn may use. A resume has no request to read them from, and without
	// this every round after the park ran with the built-in tools only (the model then hunted
	// for the missing connector among the skills). The same resolver as a fresh turn: the
	// deployment's policies, the person's switches and what the conversation has loaded
	// (ADR 0104). Best effort: a failure leaves the built-in tools, as a fresh turn's does.
	try {
		locals.mcp = await mcpLocalsFor(conv, park.userId);
	} catch (err) {
		logger.warn({ err }, "[parked] could not restore the turn's MCP selection");
	}

	const generationId = randomUUID();
	const initialContent = message.content;
	const promptedAt = new Date();
	const abortController = new AbortController();

	// The browser finds a running turn through the last assistant message's
	// generationId. A resumed run that leaves the parked turn's id in place is
	// invisible: its output only appears on a manual refresh.
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
		...(park.userId ? { userId: park.userId } : {}),
		...(locals.sessionId ? { sessionId: locals.sessionId } : {}),
		snapshot: () => ({
			content: message.content,
			reasoning: message.reasoning,
			files: message.files,
			routerMetadata: message.routerMetadata,
			stats: message.stats,
			updates: compressUpdatesForStorage(message.updates),
		}),
	});

	const apply = (event: MessageUpdate) => {
		const applied = applyUpdateToMessage(event, {
			message,
			conv,
			initialContent,
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
					title: conv.title,
					updatedAt: new Date(),
				},
			}
		);
	};

	// This producer holds the turn from here; the terminal write below is a CAS
	// that leaves a park recorded mid-run standing. Same vocabulary as the route.
	const turnKey = {
		conversationId: conv._id,
		messageId: message.id,
		producerId: generationId,
		...(park.userId ? { userId: park.userId } : {}),
		...(locals.sessionId ? { sessionId: locals.sessionId } : {}),
	};

	let hasError = false;
	try {
		apply(await turnRunning(turnKey, { keepEnded: true }));

		// A tool approval (answered by the user or expired): the SERVER applies the answer, so the
		// approved call runs whether or not the tab that clicked is still open. The round decides
		// whether the model runs: a parked sibling (a code run) resumes the turn itself when it lands.
		let skipModel = false;
		if (park.kind === "approval") {
			const outcome = await resumeParkedToolCall({
				conversationId: conv._id,
				elicitationId: park.parkedCallId,
				generationId,
				extraServers: locals.mcp?.servers,
				signal: abortController.signal,
				token: locals.token,
				viaServer: true,
			});
			for (const update of outcome.updates) apply(update);
			if (outcome.grantedTools?.length) {
				conv.approvedTools = [...new Set([...(conv.approvedTools ?? []), ...outcome.grantedTools])];
			}
			skipModel =
				outcome.parkedAgain === true || (await otherParkedRows(conv._id, message.id, park._id)) > 0;
			if (skipModel) apply(await turnAwaitingInput(turnKey));
		}

		if (park.kind === "code") {
			// Settles the execution card for every subscriber and on replay: the
			// persisted outcome carries the RunOutcome WITHOUT sandbox file paths
			// (dead on replay), plus the durable `files` references when the
			// browser uploaded them — see buildCodeExecutionResolvedUpdate.
			apply(buildCodeExecutionResolvedUpdate(park));
		}
		// The result the parked call has been missing. Replay pairs it with the call
		// by uuid, which is what puts it in the model's history for the next round.
		// For `code` the row carries the browser's posted outcome — or nothing but
		// the deadline when the browser never answered, which becomes the explicit
		// "environment unavailable" fallback the prompt teaches the model to fall
		// back from to a fence.
		const resumeResultText =
			park.kind === "approval"
				? ""
				: park.kind === "code"
					? codeResumeResultText(park, tokenExpired)
					: `Waited for: ${park.reason}. You are now resumed.` +
						(tokenExpired
							? " NOTE: the signed-in session expired while you waited, so tools that need " +
								"the sign-in may be unauthenticated. If one fails that way, say so rather than retrying."
							: "");
		if (park.kind !== "approval")
			apply({
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.Result,
				uuid: park.toolUuid,
				result: {
					status: ToolResultStatus.Success,
					call: {
						name: park.kind === "code" ? EXECUTE_CODE_TOOL_NAME : "wait",
						parameters: {},
					},
					outputs: [
						{
							text: resumeResultText,
						},
					],
					display: true,
					external: false,
				},
			});

		const ctx: TextGenerationContext = {
			model,
			endpoint: await model.getEndpoint(),
			conv,
			messages: buildSubtree(conv, message.id),
			promptedAt,
			ip: "sweeper",
			username: locals.user?.username,
			// Same per-model capability overrides as a fresh turn: tri-state,
			// winning in both directions.
			forceMultimodal: settings?.multimodalOverrides?.[model.id],
			forceTools: settings?.toolsOverrides?.[model.id],
			reasoningEffort: effectiveReasoningEffort(conv, settings, model.id),
			reasoningOverride: settings?.reasoningOverrides?.[model.id],
			artifactsOverride: settings?.artifactsOverrides?.[model.id],
			locals,
			abortController,
			generationId,
			messageId: message.id,
		};

		if (!skipModel) for await (const event of textGeneration(ctx)) apply(event);
		// A resumed turn may park again — on another wait, or on a question. Either
		// way this run's lifecycle closes with `finished`, matching what the route
		// does when a fresh turn parks: the client derives liveness from the LAST
		// lifecycle event (see generationState.ts), so the next resume's `started`
		// is what reopens the message, and a parked one reads terminal — the same
		// from every producer. Leaving `started` as the last event here instead
		// made a reloading client reattach to the already-ended generation in a
		// refresh loop.
		apply({ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished });
		// CAS: misses when the resumed run parked again, and that state stands.
		const endedUpdate = await turnEnded(turnKey, { failed: false });
		if (endedUpdate) apply(endedUpdate);
	} catch (err) {
		hasError = true;
		logger.error({ err, parkedCallId: park.parkedCallId }, "[parked] resumed turn failed");
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
		settleTurnCost({
			conversationId: conv._id,
			messageId: message.id,
			token: turnGatewayToken(locals),
		});
		await collections.parkedCalls.updateOne(
			{ _id: park._id, status: "resuming" },
			{ $set: { status: "resumed", resumedAt: new Date(), updatedAt: new Date() } }
		);
		// The approval's result is in the turn now: it no longer holds the round open.
		if (park.kind === "approval") {
			await collections.mcpElicitations
				.updateOne(
					{ elicitationId: park.parkedCallId, conversationId: park.conversationId },
					{ $set: { consumedAt: new Date() } }
				)
				.catch((err) => logger.error({ err }, "[parked] failed to mark the approval consumed"));
			// Siblings that were put off waiting for this result are due now, not after their backoff.
			await collections.parkedCalls
				.updateMany(
					{
						conversationId: park.conversationId,
						messageId: park.messageId,
						status: "waiting",
						deferrals: { $gt: 0 },
						_id: { $ne: park._id },
					},
					{ $set: { resumeAt: new Date(), updatedAt: new Date() } }
				)
				.catch((err) => logger.error({ err }, "[parked] failed to wake the round's siblings"));
		}
	}
}

/**
 * The user stopped the turn: its round is over, so nothing parked for it may
 * resume it later. Rows are abandoned; the turn's state is closed here only when
 * no producer is running it (a running one ends the turn itself, as stopped).
 */
export async function endRoundOnStop(
	conversationId: ParkedCall["conversationId"]
): Promise<number> {
	// `resuming` too: a claimed row whose run has not started must not start after the stop
	// (a run that already started re-checks its claim, see resumeParkedCall).
	const rows = await collections.parkedCalls
		.find({ conversationId, status: { $in: ["waiting", "resuming"] } })
		.toArray();
	const messages = new Set<string>();
	// An unanswered tool approval of the turn is closed with it: left pending, it would expire
	// later (or be clicked) and queue a resume on a turn the user stopped. Cancelled and
	// consumed, it cannot be answered and the deny sweeper never claims it.
	const now = new Date();
	const approvals = await collections.mcpElicitations
		.find({ conversationId, status: "pending", "pending.kind": "tool-approval" })
		.toArray();
	for (const approval of approvals) {
		const closed = await collections.mcpElicitations.updateOne(
			{ _id: approval._id, status: "pending" },
			{
				$set: {
					status: "resolved",
					action: "cancel",
					resolvedAt: now,
					consumedAt: now,
					updatedAt: now,
					stopped: true,
				},
			}
		);
		if (closed.matchedCount > 0 && approval.pending) messages.add(approval.pending.messageId);
	}
	for (const row of rows) {
		const claimed = await collections.parkedCalls.updateOne(
			{ _id: row._id, status: { $in: ["waiting", "resuming"] } },
			{
				$set: {
					status: "abandoned",
					abandonedReason: "stopped by the user",
					updatedAt: new Date(),
				},
			}
		);
		if (claimed.matchedCount > 0) messages.add(row.messageId);
	}
	for (const messageId of messages) {
		// A producer that was aborted ends its turn with a CAS on `running`, which a park
		// (`awaiting_input`) already moved past; with nothing parked any more, close the turn
		// as stopped here. A state a live run still holds as `running` is left to that run.
		let stopped = await turnOrphaned(
			conversationId,
			messageId,
			"awaiting_input",
			"The turn was stopped."
		);
		stopped ??= await turnOrphaned(conversationId, messageId, "waiting", "The turn was stopped.");
		if ((await liveProducerCount(conversationId, messageId)) === 0) {
			stopped ??= await turnOrphaned(conversationId, messageId, "running", "The turn was stopped.");
		}
		if (stopped) {
			await collections.conversations
				.updateOne({ _id: conversationId, "messages.id": messageId }, {
					$push: { "messages.$.updates": stopped },
					$set: { "messages.$.updatedAt": new Date(), updatedAt: new Date() },
				} as never)
				.catch((err) => logger.error({ err }, "[parked] failed to persist the stopped turn state"));
		}
	}
	return rows.length;
}

/**
 * Give a claimed row back because the round it belongs to is still open (see
 * roundJoin.ts). The claim counted an attempt; a deferral is not a failed one.
 * The answer the row may already carry stays on it.
 */
async function deferClaim(park: ParkedCall): Promise<void> {
	const now = new Date();
	await collections.parkedCalls.updateOne(
		{ _id: park._id, status: "resuming" },
		{
			$set: {
				status: "waiting",
				resumeAt: new Date(now.getTime() + deferDelayMs(park.deferrals ?? 0)),
				updatedAt: now,
			},
			$inc: { attempts: -1, deferrals: 1 },
			$unset: { takenAt: "" },
		}
	);
}

export async function sweepParkedCalls(): Promise<void> {
	for (let i = 0; i < SWEEP_BATCH; i += 1) {
		const park = await claimDueCall(new Date());
		if (!park) return;
		if (park.attempts > MAX_ATTEMPTS) {
			await abandon(park, `gave up after ${park.attempts} attempts`);
			continue;
		}
		// One answer of a round is not the round: a sibling call may still be running in the
		// producer that dispatched it, or waiting on the user. Resume only when all are in.
		const blocker = await roundBlocker(park.conversationId, park.messageId, {
			rowId: park._id,
			...(park.kind === "approval" ? { elicitationId: park.parkedCallId } : {}),
		});
		if (blocker) {
			logger.debug(
				{ parkedCallId: park.parkedCallId, blocker },
				"[parked] the turn's round is still open; resume deferred"
			);
			await deferClaim(park);
			continue;
		}
		logger.info(
			{ parkedCallId: park.parkedCallId, reason: park.reason, attempt: park.attempts },
			"[parked] resuming a parked turn"
		);
		await resumeParkedCall(park).catch((err) =>
			logger.error({ err, parkedCallId: park.parkedCallId }, "[parked] sweep failed")
		);
	}
}

export class ParkedCallSweeper {
	private static instance: ParkedCallSweeper;

	private constructor() {
		const interval = setInterval(() => {
			sweepParkedCalls().catch((err) => logger.error({ err }, "[parked] sweep failed"));
		}, sweepIntervalMs());
		interval.unref?.();
		onExit(() => clearInterval(interval));
	}

	public static getInstance(): ParkedCallSweeper {
		if (!ParkedCallSweeper.instance) {
			ParkedCallSweeper.instance = new ParkedCallSweeper();
		}
		return ParkedCallSweeper.instance;
	}
}
