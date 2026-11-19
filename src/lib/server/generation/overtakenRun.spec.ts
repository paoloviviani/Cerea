/**
 * Two generations in one turn: the newer one fails fast while the older one is
 * still finishing a slow call. The older run's late writes must not collide
 * with the newer one's sequence numbers, nor overwrite the message with a
 * lifecycle the turn state contradicts. And a turn state with nothing behind
 * it is closed by the reaper.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { randomUUID } from "crypto";
import { collections, ready } from "$lib/server/database";
import { createGenerationWriter } from "./writer";
import { turnEnded, turnHeldByAnother, turnRunning } from "./turnState";
import { turnEventsAfter } from "./turnLog";
import { reapOrphanTurnStates } from "./reaper";
import {
	MessageUpdateStatus,
	MessageUpdateType,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import { reconcileWithTurnState, isTurnSubscribable } from "$lib/utils/generationState";
import type { Message } from "$lib/types/Message";

const token = (text: string): MessageUpdate => ({ type: MessageUpdateType.Stream, token: text });

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	await collections.generationEvents.deleteMany({});
	await collections.generations.deleteMany({});
	await collections.turnStates.deleteMany({});
	await collections.conversations.deleteMany({});
});

async function seedConversation(messageId: string) {
	const conversationId = new ObjectId();
	await collections.conversations.insertOne({
		_id: conversationId,
		messages: [{ id: messageId, from: "assistant", content: "", children: [], updates: [] }],
		model: "m",
		title: "t",
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	return conversationId;
}

describe("an overtaken run", () => {
	it("writes neither events nor the message once a newer generation holds the turn", async () => {
		const messageId = randomUUID();
		const conversationId = await seedConversation(messageId);
		const key = (producerId: string) => ({ conversationId, messageId, producerId });
		const idA = randomUUID();
		const idB = randomUUID();

		const a = await createGenerationWriter({
			generationId: idA,
			conversationId,
			messageId,
			snapshot: () => ({ content: "stale from A" }),
		});
		a.push(await turnRunning(key(idA)));
		await new Promise((r) => setTimeout(r, 5));

		// B takes the turn over while A is still waiting on a slow call, and fails fast.
		const b = await createGenerationWriter({
			generationId: idB,
			conversationId,
			messageId,
			snapshot: () => ({ content: "from B" }),
		});
		b.push(await turnRunning(key(idB)));
		b.push({ type: MessageUpdateType.Status, status: MessageUpdateStatus.Error, message: "401" });
		const failed = await turnEnded(key(idB), { failed: true, error: "boom" });
		if (failed) b.push(failed);
		await b.finish({ status: "error" });

		// A finishes late.
		expect(await a.isSuperseded()).toBe(true);
		expect(await turnHeldByAnother(key(idA))).toBe(true);
		expect(await turnHeldByAnother(key(idB))).toBe(false);
		a.push(token("late"));
		a.push({ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished });
		await a.finish({ status: "completed" });

		const events = await turnEventsAfter(conversationId, messageId, 0, 100);
		const seqs = events.map((e) => e.seq);
		expect(new Set(seqs).size).toBe(seqs.length);
		expect(events.some((e) => e.generationId === idA && e.seq > 1)).toBe(false);

		const conv = await collections.conversations.findOne({ _id: conversationId });
		expect(conv?.messages[0].content).toBe("from B");
		expect((await collections.turnStates.findOne({ conversationId, messageId }))?.status).toBe(
			"failed"
		);
	});

	it("a message that still says awaiting_input is reconciled to the failed turn state", () => {
		const message = {
			id: "m1",
			from: "assistant",
			content: "",
			children: [],
			generationId: "a",
			updates: [{ type: MessageUpdateType.TurnState, state: "awaiting_input", serverNow: 0 }],
		} as unknown as Message;
		expect(isTurnSubscribable(message)).toBe(true);
		const fixed = reconcileWithTurnState(message, {
			messageId: "m1",
			status: "failed",
			serverNow: 1,
		} as never);
		expect(isTurnSubscribable(fixed)).toBe(false);
	});
});

describe("orphaned turn states", () => {
	it("closes running and long-awaiting turns with no producer, spares live ones", async () => {
		const old = new Date(Date.now() - 30 * 24 * 3600_000);
		const mk = async (status: "running" | "awaiting_input", updatedAt: Date) => {
			const messageId = randomUUID();
			const conversationId = await seedConversation(messageId);
			await collections.turnStates.insertOne({
				_id: new ObjectId(),
				conversationId,
				messageId,
				status,
				producerId: randomUUID(),
				createdAt: updatedAt,
				updatedAt,
			});
			return { conversationId, messageId };
		};
		const orphanRunning = await mk("running", old);
		const orphanAwaiting = await mk("awaiting_input", old);
		const fresh = await mk("running", new Date());
		const live = await mk("running", old);
		await collections.generations.insertOne({
			_id: new ObjectId(),
			generationId: randomUUID(),
			conversationId: live.conversationId,
			messageId: live.messageId,
			status: "running",
			seq: 0,
			lastHeartbeatAt: new Date(),
			startedAt: old,
			createdAt: old,
			updatedAt: new Date(),
		} as never);

		expect(await reapOrphanTurnStates()).toBe(2);
		const status = async (k: { conversationId: ObjectId; messageId: string }) =>
			(await collections.turnStates.findOne(k))?.status;
		expect(await status(orphanRunning)).toBe("failed");
		expect(await status(orphanAwaiting)).toBe("failed");
		expect(await status(fresh)).toBe("running");
		expect(await status(live)).toBe("running");

		const conv = await collections.conversations.findOne({ _id: orphanRunning.conversationId });
		const last = conv?.messages[0].updates?.at(-1);
		expect(last).toMatchObject({ type: MessageUpdateType.TurnState, state: "failed" });
	});
});
