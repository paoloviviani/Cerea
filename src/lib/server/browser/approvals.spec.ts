import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { submitElicitationAnswer } from "$lib/server/mcp/elicitation";
import type { MessageUpdate } from "$lib/types/MessageUpdate";
import {
	isMessageElicitationRequestUpdate,
	isMessageElicitationResolvedUpdate,
} from "$lib/utils/messageUpdates";
import { TINY_PNG_BASE64 } from "./fakeRuntime";
import {
	BROWSE_APPROVAL_TOOL,
	MAX_APPROVAL_SCREENSHOT_CHARS,
	createElicitationApprover,
	safeScreenshot,
	type ApprovalAsk,
} from "./approvals";

await ready;

const ask: ApprovalAsk = {
	sentence: "Click 'Pay €120' on shop.example.com",
	site: "shop.example.com",
	reason: "verb",
	action: { type: "click", ref: "e1" },
	screenshot: { mime: "image/png", base64: TINY_PNG_BASE64 },
};

function harness(timeoutMs?: number) {
	const conversationId = new ObjectId();
	const updates: MessageUpdate[] = [];
	const approve = createElicitationApprover({
		sink: { conversationId, emit: (u) => updates.push(u) },
		toolUuid: "tool-1",
		timeoutMs,
	});
	const requested = async () => {
		for (let i = 0; i < 100; i += 1) {
			const found = updates.find(isMessageElicitationRequestUpdate);
			if (found) return found;
			await new Promise((r) => setTimeout(r, 10));
		}
		throw new Error("no approval was raised");
	};
	return { conversationId, updates, approve, requested };
}

describe("the browse approver (the existing approval card, a durable row, a wait)", () => {
	it("raises the card with the sentence and the picture, and resumes on accept", async () => {
		const h = harness();
		const pending = h.approve(ask);
		const raised = await h.requested();

		expect(raised.toolUuid).toBe("tool-1");
		expect(raised.request.message).toBe(ask.sentence);
		expect(raised.request.toolApproval?.tool).toBe(BROWSE_APPROVAL_TOOL);
		expect(raised.request.browse).toEqual({
			sentence: ask.sentence,
			site: "shop.example.com",
			reason: "verb",
			screenshot: ask.screenshot,
		});
		expect(raised.expiresAt).toBeGreaterThan(Date.now());

		const row = await collections.mcpElicitations.findOne({
			elicitationId: raised.request.elicitationId,
		});
		expect(row).toMatchObject({ status: "pending", conversationId: h.conversationId });
		// Nothing to resume on a click: the loop is waiting in process.
		expect(row?.pending).toBeUndefined();

		const answered = await submitElicitationAnswer({
			elicitationId: raised.request.elicitationId,
			conversationId: h.conversationId,
			action: "accept",
			content: { scope: "once" },
		});
		expect(answered).toMatchObject({ ok: true, resume: false });

		await expect(pending).resolves.toEqual({
			verdict: "approved",
			id: raised.request.elicitationId,
		});
		const resolved = h.updates.find(isMessageElicitationResolvedUpdate);
		expect(resolved).toMatchObject({ action: "accept", resolution: "user" });
	});

	it("returns denied on decline", async () => {
		const h = harness();
		const pending = h.approve(ask);
		const raised = await h.requested();
		await submitElicitationAnswer({
			elicitationId: raised.request.elicitationId,
			conversationId: h.conversationId,
			action: "decline",
		});
		await expect(pending).resolves.toEqual({ verdict: "denied" });
	});

	it("expires an unanswered ask and closes its row, so a stale card cannot be accepted", async () => {
		const h = harness(150);
		const outcome = await h.approve(ask);
		expect(outcome).toEqual({ verdict: "expired" });
		const raised = await h.requested();
		const row = await collections.mcpElicitations.findOne({
			elicitationId: raised.request.elicitationId,
		});
		expect(row).toMatchObject({ status: "resolved", action: "cancel" });
		const late = await submitElicitationAnswer({
			elicitationId: raised.request.elicitationId,
			conversationId: h.conversationId,
			action: "accept",
			content: { scope: "once" },
		});
		expect(late.ok).toBe(false);
		expect(h.updates.find(isMessageElicitationResolvedUpdate)).toMatchObject({
			resolution: "expired",
		});
	});

	it("stops waiting when the turn is stopped", async () => {
		const h = harness();
		const controller = new AbortController();
		const pending = h.approve(ask, controller.signal);
		await h.requested();
		controller.abort();
		await expect(pending).resolves.toEqual({ verdict: "aborted" });
	});

	it("is answerable only from its own conversation", async () => {
		const h = harness();
		const pending = h.approve(ask, AbortSignal.timeout(2000));
		const raised = await h.requested();
		const stranger = await submitElicitationAnswer({
			elicitationId: raised.request.elicitationId,
			conversationId: new ObjectId(),
			action: "accept",
			content: { scope: "once" },
		});
		expect(stranger.ok).toBe(false);
		await submitElicitationAnswer({
			elicitationId: raised.request.elicitationId,
			conversationId: h.conversationId,
			action: "decline",
		});
		await expect(pending).resolves.toEqual({ verdict: "denied" });
	});
});

describe("safeScreenshot", () => {
	it("passes a plain picture", () => {
		expect(safeScreenshot({ mime: "image/png", base64: TINY_PNG_BASE64 })).toBeDefined();
	});
	it("drops anything that could be more than a picture, or too big for a message", () => {
		expect(safeScreenshot({ mime: "image/svg+xml", base64: TINY_PNG_BASE64 })).toBeUndefined();
		expect(safeScreenshot({ mime: "text/html", base64: TINY_PNG_BASE64 })).toBeUndefined();
		expect(safeScreenshot({ mime: "image/png", base64: '"><script>' })).toBeUndefined();
		expect(
			safeScreenshot({ mime: "image/png", base64: "A".repeat(MAX_APPROVAL_SCREENSHOT_CHARS + 4) })
		).toBeUndefined();
		expect(safeScreenshot(undefined)).toBeUndefined();
	});
	it("leaves a bad picture off the card but still asks", async () => {
		const h = harness(100);
		await h.approve({ ...ask, screenshot: { mime: "image/svg+xml", base64: "AAAA" } });
		const raised = await h.requested();
		expect(raised.request.browse?.screenshot).toBeUndefined();
		expect(raised.request.browse?.sentence).toBe(ask.sentence);
	});
});
