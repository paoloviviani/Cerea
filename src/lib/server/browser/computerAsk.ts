/**
 * "Which computer?" (ADR 0116, C109): the question the user is asked when several computers have a
 * browser ready and nothing decides for them (`machineChoice.ts`). The model never picks.
 *
 * Like a browse approval it is a durable `mcpElicitations` row (so any pod can take the answer,
 * a reload still shows the card, and the Needs-you inbox lists it for a chat nobody is watching),
 * shown as the chat's own question card: a select of the computers and a "Remember as default"
 * box, ticked by default. The wait polls the row until it is answered, expires or the turn stops.
 */

import { randomUUID } from "crypto";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { awaitAnswer, type ElicitationSink } from "$lib/server/mcp/elicitation";
import { getElicitationTimeoutMs } from "$lib/server/mcp/elicitationConfig";
import type { ElicitationRequestPayload } from "$lib/types/McpElicitation";
import { MessageElicitationUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import type { BrowseMachine } from "./availability";

/** The `server` of the question: the inbox lists rows by it. */
export const BROWSE_COMPUTER_SERVER = "browse_computer";
export const COMPUTER_FIELD = "computer";
export const REMEMBER_FIELD = "remember";

export type ComputerAnswer =
	| { verdict: "chosen"; machine: BrowseMachine; remember: boolean }
	| { verdict: "declined" | "expired" | "aborted" };

export type ComputerAsker = (
	options: BrowseMachine[],
	signal?: AbortSignal
) => Promise<ComputerAnswer>;

export function createComputerAsker(options: {
	sink: ElicitationSink;
	toolUuid: string;
	userId?: ObjectId;
	timeoutMs?: number;
}): ComputerAsker {
	const { sink, toolUuid } = options;
	return async (machines, signal) => {
		const elicitationId = randomUUID();
		const expiresAt = new Date(Date.now() + (options.timeoutMs ?? getElicitationTimeoutMs()));
		const message = "Which computer should Cerea use for browsing?";
		const request: ElicitationRequestPayload = {
			elicitationId,
			server: BROWSE_COMPUTER_SERVER,
			browseComputer: true,
			mode: "form",
			message,
			fields: [
				{
					kind: "select",
					name: COMPUTER_FIELD,
					title: "Which computer?",
					required: true,
					multiple: false,
					options: machines.map((m) => ({ value: m.id, label: m.name })),
				},
				{
					kind: "boolean",
					name: REMEMBER_FIELD,
					title: "Remember as default",
					required: false,
					default: true,
				},
			],
		};
		const now = new Date();
		try {
			await collections.mcpElicitations.insertOne({
				_id: new ObjectId(),
				elicitationId,
				conversationId: sink.conversationId,
				...(sink.generationId ? { generationId: sink.generationId } : {}),
				...(options.userId ? { userId: options.userId } : {}),
				status: "pending",
				request,
				expiresAt,
				createdAt: now,
				updatedAt: now,
			});
		} catch (err) {
			logger.error({ err }, "[browse] failed to record the computer question");
			return { verdict: "declined" };
		}
		sink.emit({
			type: MessageUpdateType.Elicitation,
			subtype: MessageElicitationUpdateType.Request,
			request,
			expiresAt: expiresAt.getTime(),
			toolUuid,
		});
		if (options.userId) {
			const { notifyUser } = await import("$lib/server/push/notify");
			void notifyUser(options.userId, "permission", {
				title: "Browsing needs a computer",
				body: message,
				path: `/conversation/${sink.conversationId.toString()}`,
				tag: `browse-computer-${elicitationId}`,
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
		if (outcome.action === "accept") {
			const picked = outcome.content?.[COMPUTER_FIELD];
			const machine =
				typeof picked === "string" ? machines.find((m) => m.id === picked) : undefined;
			// Only a computer that was on the list counts, whatever the answer carried.
			if (!machine) return { verdict: "declined" };
			return {
				verdict: "chosen",
				machine,
				remember: outcome.content?.[REMEMBER_FIELD] !== false,
			};
		}
		if (outcome.resolution === "expired") return { verdict: "expired" };
		if (outcome.resolution === "aborted" || outcome.resolution === "withdrawn") {
			return { verdict: "aborted" };
		}
		return { verdict: "declined" };
	};
}
