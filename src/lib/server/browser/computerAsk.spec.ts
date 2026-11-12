/** "Which computer?": the question row, the answer, and what a bad answer does. */
import { describe, expect, it, vi } from "vitest";

const notifyUser = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("$lib/server/push/notify", () => ({ notifyUser }));
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { submitElicitationAnswer } from "$lib/server/mcp/elicitation";
import type { MessageUpdate } from "$lib/types/MessageUpdate";
import { isMessageElicitationRequestUpdate } from "$lib/utils/messageUpdates";
import { BROWSE_COMPUTER_SERVER, createComputerAsker } from "./computerAsk";

await ready;

const laptop = { id: "a".repeat(24), name: "Laptop" };
const desk = { id: "b".repeat(24), name: "Desk" };

function harness(timeoutMs?: number) {
	const conversationId = new ObjectId();
	const userId = new ObjectId();
	const updates: MessageUpdate[] = [];
	const ask = createComputerAsker({
		sink: { conversationId, emit: (u) => updates.push(u) },
		toolUuid: "tool-1",
		userId,
		timeoutMs,
	});
	const requested = async () => {
		for (let i = 0; i < 100; i += 1) {
			const found = updates.find(isMessageElicitationRequestUpdate);
			if (found) return found;
			await new Promise((r) => setTimeout(r, 10));
		}
		throw new Error("no question was raised");
	};
	return { conversationId, userId, ask, requested };
}

describe("the Which computer? question", () => {
	it("lists the ready computers, with Remember as default ticked, and notifies the user", async () => {
		const h = harness();
		const pending = h.ask([laptop, desk]);
		const raised = await h.requested();
		expect(raised.request.server).toBe(BROWSE_COMPUTER_SERVER);
		expect(raised.request.fields).toEqual([
			expect.objectContaining({
				kind: "select",
				name: "computer",
				title: "Which computer?",
				required: true,
				options: [
					{ value: laptop.id, label: "Laptop" },
					{ value: desk.id, label: "Desk" },
				],
			}),
			expect.objectContaining({ kind: "boolean", name: "remember", default: true }),
		]);
		// The model never picks: nothing in the request names a choice.
		expect(raised.request.fields?.[0]).not.toHaveProperty("default");
		const row = await collections.mcpElicitations.findOne({
			elicitationId: raised.request.elicitationId,
		});
		expect(row).toMatchObject({ status: "pending", userId: h.userId });
		expect(notifyUser).toHaveBeenCalledWith(h.userId, "permission", expect.anything());
		await submitElicitationAnswer({
			elicitationId: raised.request.elicitationId,
			conversationId: h.conversationId,
			action: "accept",
			content: { computer: desk.id, remember: true },
		});
		await expect(pending).resolves.toEqual({ verdict: "chosen", machine: desk, remember: true });
	});

	it("carries a cleared Remember box", async () => {
		const h = harness();
		const pending = h.ask([laptop, desk]);
		const raised = await h.requested();
		await submitElicitationAnswer({
			elicitationId: raised.request.elicitationId,
			conversationId: h.conversationId,
			action: "accept",
			content: { computer: laptop.id, remember: false },
		});
		await expect(pending).resolves.toEqual({ verdict: "chosen", machine: laptop, remember: false });
	});

	it("declines on decline, and an unanswered question expires", async () => {
		const h = harness();
		const pending = h.ask([laptop, desk]);
		const raised = await h.requested();
		await submitElicitationAnswer({
			elicitationId: raised.request.elicitationId,
			conversationId: h.conversationId,
			action: "decline",
		});
		await expect(pending).resolves.toEqual({ verdict: "declined" });
		const slow = harness(150);
		await expect(slow.ask([laptop, desk])).resolves.toEqual({ verdict: "expired" });
	});
});
