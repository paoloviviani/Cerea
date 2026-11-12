/**
 * Asking the user about a commit-class action (ADR 0116 §4), inside a sub-agent loop.
 *
 * The chat's own approvals park the turn and resume it on the click (`toolApproval.ts`); a
 * browsing sub-agent is a loop in memory inside one tool call, with a live page behind it, so it
 * cannot be parked. It waits instead, the way a 2025-era MCP prompt does (`mcp/elicitation.ts`):
 * the prompt is a durable `mcpElicitations` row (so the answer can arrive on any pod, and a
 * reload still shows the card), the card is the chat's own approval card, and the wait polls the
 * row until it is answered, expires or the turn is stopped. The loop's clock does not run while it
 * waits (`loop.ts`).
 *
 * A server that restarts mid-wait loses the loop, as it loses any running tool call; the row is
 * closed (`cancel`) and the card settles as expired.
 */

import { randomUUID } from "crypto";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import type { ElicitationSink } from "$lib/server/mcp/elicitation";
import { awaitAnswer } from "$lib/server/mcp/elicitation";
import { getElicitationTimeoutMs } from "$lib/server/mcp/elicitationConfig";
import type { BrowseApprovalPayload, ElicitationRequestPayload } from "$lib/types/McpElicitation";
import { MessageElicitationUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import type { BrowserAction } from "./contract";

/** The grant key an approval card carries as its tool name. */
export const BROWSE_APPROVAL_TOOL = "browser_act";

/** A picture larger than this (base64 characters) is left off the card: it is stored with the message. */
export const MAX_APPROVAL_SCREENSHOT_CHARS = 160_000;

/** The runtime is untrusted: only a plain picture, in plain base64, ever reaches a card's `data:` url. */
export function safeScreenshot(
	shot: { mime: string; base64: string } | undefined,
	maxChars = MAX_APPROVAL_SCREENSHOT_CHARS
): { mime: string; base64: string } | undefined {
	if (!shot) return undefined;
	if (!/^image\/(png|jpeg|webp)$/.test(shot.mime)) return undefined;
	if (shot.base64.length > maxChars) return undefined;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(shot.base64)) return undefined;
	return shot;
}

export interface ApprovalAsk {
	sentence: string;
	site: string;
	/** The page's URL without its fragment, shown on the card and bound into the grant. */
	url?: string;
	reason?: string;
	action: BrowserAction;
	screenshot?: { mime: string; base64: string };
}

export type ApprovalOutcome =
	| { verdict: "approved"; id: string }
	| { verdict: "denied" }
	| { verdict: "expired" }
	| { verdict: "aborted" };

/** What the loop calls. The production one is `createElicitationApprover`; tests script it. */
export type Approver = (ask: ApprovalAsk, signal?: AbortSignal) => Promise<ApprovalOutcome>;

export function createElicitationApprover(options: {
	sink: ElicitationSink;
	toolUuid: string;
	/** Who the turn belongs to: the push that says an approval is waiting goes to them. */
	userId?: ObjectId;
	/** Test seam: how long an unanswered ask lives. */
	timeoutMs?: number;
}): Approver {
	const { sink, toolUuid } = options;
	return async (ask, signal) => {
		const elicitationId = randomUUID();
		const expiresAt = new Date(Date.now() + (options.timeoutMs ?? getElicitationTimeoutMs()));
		const browse: BrowseApprovalPayload = {
			sentence: ask.sentence,
			site: ask.site,
			...(ask.url ? { url: ask.url } : {}),
			...(ask.reason ? { reason: ask.reason } : {}),
			...(safeScreenshot(ask.screenshot) ? { screenshot: safeScreenshot(ask.screenshot) } : {}),
		};
		const request: ElicitationRequestPayload = {
			elicitationId,
			server: BROWSE_APPROVAL_TOOL,
			mode: "form",
			message: ask.sentence,
			fields: [
				{
					kind: "select",
					name: "scope",
					title: "Allow this action?",
					required: true,
					multiple: false,
					options: [{ value: "once", label: "Allow this action" }],
				},
			],
			toolApproval: { tool: BROWSE_APPROVAL_TOOL, args: { action: ask.action, site: ask.site } },
			browse,
		};
		const now = new Date();
		try {
			await collections.mcpElicitations.insertOne({
				_id: new ObjectId(),
				elicitationId,
				conversationId: sink.conversationId,
				...(sink.generationId ? { generationId: sink.generationId } : {}),
				status: "pending",
				request,
				expiresAt,
				createdAt: now,
				updatedAt: now,
			});
		} catch (err) {
			logger.error({ err }, "[browse] failed to record an approval");
			// Nothing was shown, so nothing was approved.
			return { verdict: "denied" };
		}
		sink.emit({
			type: MessageUpdateType.Elicitation,
			subtype: MessageElicitationUpdateType.Request,
			request,
			expiresAt: expiresAt.getTime(),
			toolUuid,
		});
		// The same push an agent's ask sends: the user may be on their phone with the tab closed.
		if (options.userId) {
			const { notifyUser } = await import("$lib/server/push/notify");
			void notifyUser(options.userId, "permission", {
				title: "Browsing needs your approval",
				body: ask.sentence,
				path: `/conversation/${sink.conversationId.toString()}`,
				tag: `browse-${elicitationId}`,
			}).catch(() => undefined);
		}

		const outcome = await awaitAnswer(elicitationId, {
			deadlineAt: expiresAt.getTime(),
			generation: signal,
		});
		sink.emit({
			type: MessageUpdateType.Elicitation,
			subtype: MessageElicitationUpdateType.Resolved,
			elicitationId,
			action: outcome.action,
			resolution: outcome.resolution,
			...(outcome.content ? { content: outcome.content } : {}),
		});

		if (outcome.action === "accept") return { verdict: "approved", id: elicitationId };
		if (outcome.resolution === "expired") return { verdict: "expired" };
		if (outcome.resolution === "aborted" || outcome.resolution === "withdrawn") {
			return { verdict: "aborted" };
		}
		return { verdict: "denied" };
	};
}
