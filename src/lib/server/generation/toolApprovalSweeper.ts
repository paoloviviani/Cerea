import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { onExit } from "$lib/server/exitHandler";
import type { McpElicitation } from "$lib/types/McpElicitation";
import { sweepParkedCalls } from "./parkedSweeper";
import { queueApprovalResume } from "./roundJoin";

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

export async function sweepExpiredToolApprovals(): Promise<void> {
	for (let i = 0; i < SWEEP_BATCH; i += 1) {
		const row = await claimExpired();
		if (!row) break;
		// Denied above; the refusal is applied like any answered approval, by the parked sweeper
		// (which also decides, with the rest of the round, whether the model runs).
		const pending = row.pending;
		if (!pending || pending.kind !== "tool-approval") continue;
		await queueApprovalResume({
			elicitationId: row.elicitationId,
			conversationId: row.conversationId,
			...(row.generationId ? { generationId: row.generationId } : {}),
			pending,
		}).catch((err) =>
			logger.error(
				{ err, elicitationId: row.elicitationId },
				"[tool-approval] deny-timeout sweep failed"
			)
		);
	}
	await sweepParkedCalls();
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
