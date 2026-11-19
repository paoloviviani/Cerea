import { collections } from "$lib/server/database";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { onExit } from "$lib/server/exitHandler";
import { markGenerationInterrupted, finalizeActiveRunsOnExit } from "./finalize";
import { turnOrphaned } from "./turnState";

const REAP_BATCH = 200;

function reapIntervalMs(): number {
	const raw = config.GENERATION_REAP_INTERVAL_MS;
	if (raw) {
		const parsed = parseInt(raw, 10);
		if (!isNaN(parsed) && parsed > 0) return parsed;
	}
	return 60_000;
}

// Must stay well above the heartbeat interval (see writer.ts) or a live but jittery
// pod is reaped between beats. The 90s default is ~9 missed 10s beats. Configurable
// only so tests can scale both timers down together.
export function reapAfterMs(): number {
	const raw = config.GENERATION_REAP_AFTER_MS;
	if (raw) {
		const parsed = parseInt(raw, 10);
		if (!isNaN(parsed) && parsed > 0) return parsed;
	}
	return 90_000;
}

// A run whose pod died stays `status: running` with a frozen heartbeat forever;
// nothing else finalizes it, so it would spin or present its partial output as a
// finished answer. Mark it interrupted instead.
export async function reapStaleGenerations(): Promise<void> {
	const threshold = new Date(Date.now() - reapAfterMs());
	const stale = await collections.generations
		.find({ status: "running", lastHeartbeatAt: { $lt: threshold } })
		.limit(REAP_BATCH)
		.toArray();
	if (stale.length === 0) return;

	logger.warn({ count: stale.length }, "[generation] reaping runs with stale heartbeat");
	await Promise.all(
		stale.map((g) =>
			markGenerationInterrupted(g.generationId, {
				conversationId: g.conversationId,
				messageId: g.messageId,
			}).catch((err) =>
				logger.error({ err, generationId: g.generationId }, "[generation] failed to reap run")
			)
		)
	);
}

// A turn awaiting the user's answer may legitimately wait a long time, so it is only
// closed once it has sat untouched this long with nothing that could still answer it.
const AWAITING_INPUT_ORPHAN_MS = 7 * 24 * 60 * 60 * 1000;
const ORPHAN_ERROR = "The turn was abandoned: nothing was running it any more.";

/**
 * Turn states stuck `running` (a run that died without ending its turn, or was
 * reaped: reaping marks the generation, not the turn) or `awaiting_input`
 * (a question never answered) with no producer, parked call or pending prompt
 * behind them. A client holding such a turn subscribes to it forever. Close
 * each as failed, and persist that into the message so snapshots agree.
 */
export async function reapOrphanTurnStates(now = Date.now()): Promise<number> {
	const runningBefore = new Date(now - Math.max(reapAfterMs() * 2, 5 * 60_000));
	const awaitingBefore = new Date(now - AWAITING_INPUT_ORPHAN_MS);
	const candidates = await collections.turnStates
		.find({
			$or: [
				{ status: "running", updatedAt: { $lt: runningBefore } },
				{ status: "awaiting_input", updatedAt: { $lt: awaitingBefore } },
			],
		})
		.limit(REAP_BATCH)
		.toArray();

	let closed = 0;
	for (const doc of candidates) {
		const { conversationId, messageId } = doc;
		const status = doc.status as "running" | "awaiting_input";
		try {
			const live = await collections.generations.countDocuments({
				conversationId,
				messageId,
				status: "running",
				lastHeartbeatAt: { $gte: runningBefore },
			});
			if (live > 0) continue;
			const parked = await collections.parkedCalls.countDocuments({
				conversationId,
				messageId,
				status: { $in: ["waiting", "resuming"] },
			});
			if (parked > 0) continue;
			if (status === "awaiting_input") {
				const asked = await collections.mcpElicitations.countDocuments({
					conversationId,
					status: "pending",
					"pending.messageId": messageId,
					$or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date(now) } }],
				});
				if (asked > 0) continue;
			}
			// Only the doc judged above: a turn restarted in between keeps running.
			const failed = await turnOrphaned(
				conversationId,
				messageId,
				status,
				ORPHAN_ERROR,
				doc.updatedAt
			);
			if (!failed) continue;
			closed++;
			await collections.conversations.updateOne({ _id: conversationId, "messages.id": messageId }, {
				$push: { "messages.$.updates": failed },
				$set: { "messages.$.updatedAt": new Date(), updatedAt: new Date() },
			} as never);
		} catch (err) {
			logger.error({ err, messageId }, "[generation] failed to close an orphaned turn");
		}
	}
	if (closed > 0) logger.warn({ closed }, "[generation] closed orphaned turn states");
	return closed;
}

export class GenerationReaper {
	private static instance: GenerationReaper;

	private constructor() {
		const interval = setInterval(() => {
			reapStaleGenerations()
				.then(() => reapOrphanTurnStates())
				.catch((err) => logger.error({ err }, "[generation] reaper sweep failed"));
		}, reapIntervalMs());
		interval.unref?.();
		onExit(() => clearInterval(interval));
		// A graceful shutdown finalizes this pod's runs at once, not one sweep later.
		onExit(() => finalizeActiveRunsOnExit());

		reapStaleGenerations()
			.then(() => reapOrphanTurnStates())
			.catch((err) => logger.error({ err }, "[generation] initial reaper sweep failed"));
	}

	public static getInstance(): GenerationReaper {
		if (!GenerationReaper.instance) {
			GenerationReaper.instance = new GenerationReaper();
		}
		return GenerationReaper.instance;
	}
}
